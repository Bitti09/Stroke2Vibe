// Playback sync: sample converted (or passthrough) axis values at the video playhead
// and drive the connected device through a smoothed output loop.

import type { Action, Funscript } from '../funscript'
import { emitAxis } from '../axisBus'

export interface AxisSource {
  id: string
  actions: Action[]
}

/** Sample an action list at time t with linear interpolation (funscript semantics). */
export function sampleAxis(actions: Action[], t: number): number {
  if (actions.length === 0) return 0
  if (t <= actions[0].at) return actions[0].pos
  if (t >= actions[actions.length - 1].at) return actions[actions.length - 1].pos
  let lo = 0
  let hi = actions.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (actions[mid].at <= t) lo = mid
    else hi = mid
  }
  const a = actions[lo]
  const b = actions[hi]
  const f = (t - a.at) / (b.at - a.at || 1)
  return a.pos + f * (b.pos - a.pos)
}

export interface SyncOptions {
  intensity: number // global 0..1.x multiplier
  rampMs: number
  pauseStops: boolean
  /** per-motor power limits (0..1), applied after intensity: value is clamped
   *  to [min, max]; min lifts idle buzz, max caps brutal peaks per motor */
  motorMin: [number, number]
  motorMax: [number, number]
}

export interface SyncDriver {
  /** call each tick; returns the values actually sent (after ramp) */
  tick: (tMs: number, playing: boolean, rate: number) => Promise<[number, number]>
  stop: () => Promise<void>
  dispose: () => void
  /** live-update options (intensity/ramp/limits) without recreating the driver */
  updateOptions: (opts: SyncOptions) => void
}

/**
 * Creates a rAF-driven loop that samples `sources` (V0, V1) at the video time and
 * sends smoothed values to the device. `send` receives intensities in 0..1.
 */
export function createSyncDriver(
  sources: AxisSource[],
  send: (values: number[]) => Promise<void>,
  opts: SyncOptions,
): SyncDriver {
  let activeOpts = opts
  let lastSent: [number, number] = [0, 0]
  let lastReal: [number, number] = [0, 0]
  let lastTickAt = performance.now()
  let disposed = false

  const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
  const clampLimits = (v: number, min: number, max: number) => {
    const lo = Math.max(0, Math.min(1, min))
    const hi = Math.max(lo, Math.min(1, max))
    // below min the motor should be OFF rather than buzzing at the floor — only lift
    // values that are already running; hard cap the top
    if (v <= 0) return 0
    if (v < lo) return lo
    return Math.min(hi, v)
  }

  const tick = async (tMs: number, playing: boolean, rate: number): Promise<[number, number]> => {
    if (disposed) return lastSent
    const now = performance.now()
    const dt = Math.min(200, Math.max(1, now - lastTickAt))
    lastTickAt = now

    let target: [number, number] = [0, 0]
    if (playing || !activeOpts.pauseStops) {
      const tScaled = tMs // caller passes video.currentTime in ms (already rate-adjusted by the video element)
      target = [
        sampleAxis(sources[0]?.actions ?? [], tScaled) / 100,
        sampleAxis(sources[1]?.actions ?? [], tScaled) / 100,
      ]
      // global intensity
      target = [clamp01(target[0] * activeOpts.intensity), clamp01(target[1] * activeOpts.intensity)]
      // per-motor power limits
      target = [
        clampLimits(target[0], activeOpts.motorMin[0], activeOpts.motorMax[0]),
        clampLimits(target[1], activeOpts.motorMin[1], activeOpts.motorMax[1]),
      ]
    }

    lastReal = target
    // follow the script curve: the sampled value IS the waveform. Strong tracking
    // (k≈0.85/tick at 60fps) reproduces the action steps as waves; only a short
    // glide remains to avoid clicks. The old heavy ramp (k≈0.05) flattened every
    // pattern into a static power level — that bug is gone.
    const k = 1 - Math.exp(-dt / Math.max(8, activeOpts.rampMs * 0.35))
    const next: [number, number] = [
      lastSent[0] + (target[0] - lastSent[0]) * k,
      lastSent[1] + (target[1] - lastSent[1]) * k,
    ]

    // send whenever the script moves: deadband only kills pure jitter (0.005),
    // never the script's own steps
    const deadband = 0.005
    if (Math.abs(next[0] - lastSent[0]) > deadband || Math.abs(next[1] - lastSent[1]) > deadband) {
      lastSent = next
      emitAxis(next[0] * 100, next[1] * 100, tMs)
      try {
        await send(next)
      } catch {
        /* device hiccups are non-fatal; next tick retries */
      }
    } else {
      emitAxis(next[0] * 100, next[1] * 100, tMs)
    }
    void rate
    return next
  }

  const stop = async () => {
    lastSent = [0, 0]
    lastReal = [0, 0]
    try {
      await send([0, 0])
    } catch {
      /* ignore */
    }
  }

  const dispose = () => {
    disposed = true
  }

  const updateOptions = (o: SyncOptions) => {
    opts = o
  }

  return { tick, stop, dispose, updateOptions }
}

/** Which axes drive playback: converted V0/V1 if present, else L0 mirrored to both. */
export function playbackSources(fs: Funscript): AxisSource[] {
  const byId = (id: string) => fs.axes.find((a) => a.id.toLowerCase() === id.toLowerCase())
  const v0 = byId('V0')
  const v1 = byId('V1')
  if (v0 && v1) {
    return [
      { id: 'V0', actions: v0.actions },
      { id: 'V1', actions: v1.actions },
    ]
  }
  // fallback: single vibe motor semantics — L0 drives both motors equally
  return [
    { id: 'L0', actions: fs.actions },
    { id: 'L0', actions: fs.actions },
  ]
}

/** Build a heatmap strip (0..100 intensity) for visualization. */
/** Ordered list of ALL traces: playback axes (V0/V1) first, then motion (L0, l2, r0...),
 *  then other generated ones (a0, ...). Used by the waveform panel. */
export function allTraces(fs: Funscript): Array<{ id: string; actions: Action[]; kind: 'vibe' | 'motion' | 'generated' }> {
  const byId = (id: string) => fs.axes.find((a) => a.id.toLowerCase() === id.toLowerCase())
  const out: Array<{ id: string; actions: Action[]; kind: 'vibe' | 'motion' | 'generated' }> = []
  // playback vibes first
  for (const id of ['V0', 'V1']) {
    const ax = byId(id)
    if (ax) out.push({ id: ax.id, actions: ax.actions, kind: 'vibe' })
  }
  // motion: top-level L0 + motion axes
  if (fs.actions.length > 0) out.push({ id: 'L0', actions: fs.actions, kind: 'motion' })
  for (const ax of fs.axes) {
    const lo = ax.id.toLowerCase()
    if (lo === 'v0' || lo === 'v1') continue
    const kind: 'motion' | 'generated' = /^[a-z]/.test(lo) && lo.startsWith('a') ? 'generated' : 'motion'
    out.push({ id: ax.id, actions: ax.actions, kind })
  }
  return out
}

export function heatmap(sources: AxisSource[], buckets = 200): number[] {
  const t0 = sources[0]?.actions[0]?.at ?? 0
  const t1 = sources[0]?.actions[sources[0].actions.length - 1]?.at ?? 1
  const out = new Array(buckets).fill(0)
  for (const src of sources) {
    for (const a of src.actions) {
      const idx = Math.min(buckets - 1, Math.max(0, Math.floor(((a.at - t0) / (t1 - t0 || 1)) * buckets)))
      out[idx] = Math.max(out[idx], a.pos)
    }
  }
  return out
}
