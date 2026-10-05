// TypeScript port of auto/Stroke2VibeAuto.cpp — same math, same default options.
// Envelope: speed at segment midpoints -> robust p99/target normalisation ->
// percentile noise gate -> optional smoothing -> gamma lift -> gap silence.
// Split: energy-preserving weights w0+w1=1 per mode; device pass: floor/dead-zone
// + rate cap + guaranteed trailing stop.

import type { Action, Funscript } from '../funscript'
import { dedupe } from '../funscript'

export type Mode = 'auto' | 'travel' | 'alternate' | 'layer' | 'surge'

export interface ConvertOptions {
  mode: Mode
  travelFromTop: boolean
  duty: number // active-motor share in alternate
  layerRatio: number
  depth: number
  echo: number // ms, surge
  gamma: number
  gateP: number // 0..1 percentile
  target: number // p99 -> target intensity
  smoothMs: number
  gapSec: number
  minGapMs: number
  floorVal: number
  dwellMs: number
  maxSwitchHz: number
  /** skip output resampling/smoothing (used by reference-parity tests) */
  rawOutput?: boolean
  /** envelope baseline fraction of target (auto-profile derived, UI-overridable) */
  baselineKnob?: number
  /** envelope ripple fraction (auto-profile derived, UI-overridable) */
  rippleKnob?: number
  /** M2.2 stroke accent: boost fraction when the stroke moves inward (0 = off) */
  accent?: number
  /** M2.5 reversal kick: impulse % added just after reversals (0 = off) */
  kick?: number
  /** M2.5 soft floor ramp ms (0 = hard floor jump) */
  floorRampMs?: number
  /** M2.1 section dynamics: enable per-section profile mixing */
  sections?: boolean
  /**
   * Auto-profile: derives ALL shaping parameters from the source trace so the result
   * is one clean wave that mirrors the original line's dynamics.
   * - 'balanced' (default): even, gliding, follows the source 1:1
   * - 'softer': gentler, more glide, less peak punch
   * - 'stronger': fuller range, more contrast between sections
   * - 'extreme': maximum punch, deep dips, pronounced builds
   */
  autoProfile?: 'balanced' | 'softer' | 'stronger' | 'extreme'
  /** map source axis -> target axis (e.g. L0->V0, r0->V1). Empty = classic L0->V0+V1 split. */
  mappings?: AxisMapping[]
}

export interface AutoProfile {
  gamma: number
  gateP: number
  target: number
  smoothMs: number
  floorVal: number
  minGapMs: number
  /** baseline fraction of target: 0 = dips to off between waves, higher = steady glide */
  baseline: number
  /** ripple amplitude as fraction of swell (0..1): how much per-stroke punch rides on the wave */
  ripple: number
  /** alternate duty (active-motor share) */
  duty: number
  /** layer breathing depth */
  layerDepth: number
  /** layer modulation rate as fraction of stroke frequency */
  layerRatio: number
  /** M2.2 stroke accent boost (0..1, fraction added on inward strokes) */
  accent: number
  /** M2.5 reversal kick impulse (percent points, e.g. 0.6 = +6) */
  kick: number
  /** M2.5 soft floor ramp ms */
  floorRampMs: number
  /** M2.1 section dynamics enabled */
  sections: boolean
}

/** Values the auto-profile derived — shown live in the UI, overridable by sliders. */
export interface ShapingKnobs {
  target?: number
  gamma?: number
  gateP?: number
  smoothMs?: number
  floorVal?: number
  minGapMs?: number
  baseline?: number
  ripple?: number
  duty?: number
  layerDepth?: number
  layerRatio?: number
  accent?: number
  kick?: number
  floorRampMs?: number
  sections?: boolean
}

/**
 * Derive shaping parameters from the measured trace profile so the output is a clean
 * wave mirroring the original line. Called by convertScript/convertMapped when
 * autoProfile is set; explicit slider values win whenever autoProfile is undefined.
 */
export function deriveAutoProfile(
  l0: Action[],
  profile: NonNullable<ConvertOptions['autoProfile']>,
  userOverrides: ShapingKnobs = {},
): { shaping: AutoProfile; applied: Partial<ConvertOptions> } {
  // measure: tempo, amplitude range, density, speed spread (hammer vs glide source)
  const mids: Array<{ dt: number; dp: number; v: number }> = []
  for (let i = 1; i < l0.length; i++) {
    const dt = l0[i].at - l0[i - 1].at
    const dp = Math.abs(l0[i].pos - l0[i - 1].pos)
    mids.push({ dt, dp, v: dt > 0 ? dp / dt : 0 })
  }
  const speeds = mids.map((m) => m.v)
  const speedMed = percentile(speeds, 0.5)
  const speedP99 = percentile(speeds, 0.99)
  const speedLoad = speedP99 > 0 ? speedMed / speedP99 : 0 // ~1 = hammer source

  // tempo (median half-stroke)
  const revs: number[] = [l0[0].at]
  for (let i = 1; i + 1 < l0.length; i++) {
    const d1 = l0[i].pos - l0[i - 1].pos
    const d2 = l0[i + 1].pos - l0[i].pos
    if (d1 * d2 < 0) revs.push(l0[i].at)
  }
  revs.push(l0[l0.length - 1].at)
  const ints: number[] = []
  for (let i = 1; i + 1 < revs.length; i++) ints.push(revs[i] - revs[i - 1])
  const halfStroke = ints.length ? percentile(ints, 0.5) : 1000
  const tempoHz = halfStroke > 0 ? 1000 / (2 * halfStroke) : 0

  const dps = mids.map((m) => m.dp)
  const ampMed = percentile(dps, 0.5)
  const density = l0.length / Math.max(1, (l0[l0.length - 1].at - l0[0].at) / 1000)

  const shaping: AutoProfile = {
    gamma: 0.65,
    gateP: 0.15,
    target: 85,
    smoothMs: 80,
    floorVal: 12,
    minGapMs: 40,
    baseline: 0.22,
    ripple: 0.25,
    duty: 0.7,
    layerDepth: 0.35,
    layerRatio: 0.5,
    accent: 0,
    kick: 0,
    floorRampMs: 0,
    sections: false,
  }

  // ---- speed-load driven: hammer sources need throttle + gate + heavy smoothing ----
  if (speedLoad > 0.55) {
    shaping.target = 70
    shaping.gateP = 0.28
    shaping.smoothMs = Math.max(200, halfStroke * 0.8)
  }

  // ---- amplitude driven: tiny amplitudes need lift to stay perceivable ----
  if (ampMed < 8) {
    shaping.gamma = Math.min(shaping.gamma, 0.5)
    shaping.floorVal = Math.max(shaping.floorVal, 15)
  }

  // ---- density driven: very dense traces get a wider output grid ----
  if (density > 6) shaping.minGapMs = 60

  // ---- profile flavor ----
  switch (profile) {
    case 'softer':
      shaping.target = Math.min(shaping.target, 68)
      shaping.gamma = Math.min(shaping.gamma, 0.5) // lift quiet parts
      shaping.baseline = 0.3 // steadier glide
      shaping.ripple = 0.15 // less punch
      shaping.floorVal = Math.max(shaping.floorVal, 15)
      shaping.duty = 0.62
      shaping.layerDepth = 0.22
      shaping.layerRatio = 0.35
      shaping.accent = 0
      shaping.kick = 0
      break
    case 'stronger':
      shaping.target = Math.max(shaping.target, 90)
      shaping.gamma = 0.75 // more contrast
      shaping.baseline = 0.12 // deeper dips between waves
      shaping.ripple = 0.35 // more per-stroke punch
      shaping.duty = 0.78
      shaping.layerDepth = 0.55
      shaping.layerRatio = 0.7
      shaping.accent = 0.08
      shaping.kick = 0.6
      break
    case 'extreme':
      shaping.target = 95
      shaping.gamma = 0.85
      shaping.baseline = 0.05 // waves fall almost to off
      shaping.ripple = 0.45 // hard punches on top
      shaping.smoothMs = Math.min(shaping.smoothMs, 120) // keep attacks crisp
      shaping.duty = 0.88
      shaping.layerDepth = 0.75
      shaping.layerRatio = 1.0
      shaping.accent = 0.15
      shaping.kick = 0.8
      break
    case 'balanced':
    default:
      break
  }

  // never fight the user: explicit slider values win over derived ones
  const applied: Partial<ConvertOptions> = {
    gamma: userOverrides.gamma ?? shaping.gamma,
    gateP: userOverrides.gateP ?? shaping.gateP,
    target: userOverrides.target ?? shaping.target,
    smoothMs: userOverrides.smoothMs ?? shaping.smoothMs,
    floorVal: userOverrides.floorVal ?? shaping.floorVal,
    minGapMs: userOverrides.minGapMs ?? shaping.minGapMs,
    duty: userOverrides.duty ?? shaping.duty,
    depth: userOverrides.layerDepth ?? shaping.layerDepth,
    layerRatio: userOverrides.layerRatio ?? shaping.layerRatio,
    accent: userOverrides.accent ?? shaping.accent,
    kick: userOverrides.kick ?? shaping.kick,
    floorRampMs: userOverrides.floorRampMs ?? 0,
    sections: userOverrides.sections ?? false,
  }
  return { shaping, applied }
}

export interface AxisMapping {
  source: string // axis id or "L0" for top-level actions
  target: string // vibe axis id, e.g. V0/V1
  mode: Mode // per-trace conversion mode
}

export const defaultOptions: ConvertOptions = {
  mode: 'auto',
  travelFromTop: false,
  duty: 0.7,
  layerRatio: 0.5,
  depth: 0.35,
  echo: 120,
  gamma: 0.65,
  gateP: 0.15,
  target: 85,
  smoothMs: 80,
  gapSec: 3,
  minGapMs: 40,
  floorVal: 12,
  dwellMs: 600,
  maxSwitchHz: 1.5,
}

export interface ConvertStats {
  tempo: { halfStrokeMs: number; fStroke: number }
  scale: number
  gate: number
  axes: Array<{
    id: string
    actions: number
    activePct: number
    meanActive: number
    p99: number
    max: number
  }>
  switchHz: number
  degradedPct: number
  saturationPct: number
  corr: number
}

export interface ConvertResult {
  axes: Array<{ id: string; actions: Action[] }>
  envelope: Array<[number, number]> // (t, E) sample points for preview
  stats: ConvertStats
}

interface EnvPoint {
  t: number
  e: number
}

// ---------- helpers ----------

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  return s[Math.floor(p * (s.length - 1))] ?? 0
}

function sampleE(pts: EnvPoint[], gaps: Array<[number, number]>, t: number, direct = false): number {
  if (pts.length === 0) return 0
  for (const [a, b] of gaps) if (t > a && t < b) return 0
  if (direct) {
    // direct (vibe-like) sources: pos IS the intensity at its own timestamp —
    // hold first/last values instead of zeroing the edges
    if (t <= pts[0].t) return pts[0].e
    if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].e
  } else {
    if (t <= pts[0].t || t >= pts[pts.length - 1].t) return 0
  }
  let lo = 0
  let hi = pts.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (pts[mid].t <= t) lo = mid
    else hi = mid
  }
  const a = pts[lo]
  const b = pts[hi]
  const f = (t - a.t) / (b.t - a.t || 1)
  return a.e + f * (b.e - a.e)
}

// ---------- envelope ----------

function buildEnvelope(l0: Action[], o: ConvertOptions, profile?: AutoProfile): EnvBundle {
  if (l0.length < 2) return { pts: [], gaps: [], scale: 1, gate: 0 }
  const mids: EnvPoint[] = []
  for (let i = 1; i < l0.length; i++) {
    const dt = l0[i].at - l0[i - 1].at
    const dp = Math.abs(l0[i].pos - l0[i - 1].pos)
    mids.push({ t: (l0[i].at + l0[i - 1].at) / 2, e: dt > 0 ? dp / dt : 0 })
  }
  const p99 = percentile(mids.map((m) => m.e), 0.99)
  const scale = p99 > 0 ? o.target / p99 : 1
  for (const m of mids) m.e = Math.min(100, m.e * scale)

  // ---- wave shaping ----
  // Raw per-stroke speed of a rhythmic script is a pulse train (peaks mid-stroke,
  // zero at every reversal) -> the device hammers between 0 and peak. Real "waves"
  // = slow swell (section energy) + gentle ripple riding on a raised baseline.
  // slow window must span several full strokes to capture SECTION energy, not the
  // per-stroke pulse train (600ms over a 750ms half-stroke still tracks the pulses)
  const revsTmp: number[] = [l0[0].at]
  for (let i = 1; i + 1 < l0.length; i++) {
    const d1 = l0[i].pos - l0[i - 1].pos
    const d2 = l0[i + 1].pos - l0[i].pos
    if (d1 * d2 < 0) revsTmp.push(l0[i].at)
  }
  revsTmp.push(l0[l0.length - 1].at)
  const intsTmp: number[] = []
  for (let i = 1; i + 1 < revsTmp.length; i++) intsTmp.push(revsTmp[i] - revsTmp[i - 1])
  const halfStroke = intsTmp.length ? percentile(intsTmp, 0.5) : 1000
  const glideMs = Math.max(o.smoothMs * 4, halfStroke * 4) // >= 2 full strokes

  // 1) fast pass: the raw (scaled) speed = ripple source
  const ripple = mids.map((m) => ({ t: m.t, e: m.e }))

  // 2) slow pass: heavy moving average = the section energy swell
  const slow = movingAverage(mids, glideMs)

  // 3) gate on the SLOW curve (section silence stays silent), then compose
  const slowVals = slow.map((m) => m.e)
  const gate = percentile(slowVals, o.gateP)
  for (let i = 0; i < slow.length; i++) if (slow[i].e < gate) slow[i].e = 0

  // baseline fraction of target: keeps the wave gliding instead of dropping out
  const baselineFrac = o.baselineKnob ?? (profile ? profile.baseline : 0.22)
  const rippleFrac = o.rippleKnob ?? (profile ? profile.ripple : 0.25)
  const base = Math.max(0, Math.min(80, baselineFrac * o.target))
  for (let i = 0; i < mids.length; i++) {
    const slowE = slow[i].e
    const rip = ripple[i].e
    if (slowE <= 0) {
      mids[i].e = 0
      continue
    }
    // ripple normalized against local slow level (bounded by profile)
    const bound = Math.max(0.05, Math.min(0.9, rippleFrac))
    const rel = slowE > 0 ? Math.max(-bound, Math.min(bound, (rip - slowE) / Math.max(1, slowE))) : 0
    const wave = base + (o.target - base) * (slowE / 100) * (1 + rel)
    mids[i].e = Math.min(100, wave)
  }

  // 4) gamma, section dynamics + gaps
  for (const m of mids) m.e = 100 * Math.pow(m.e / 100, o.gamma)
  if (o.sections) {
    const sections = detectSections(l0)
    const profCache = sectionProfiles(l0, sections, o)
    applySections(mids, l0, sections, profCache, 4000, profile)
  }
  const gaps: Array<[number, number]> = []
  for (let i = 1; i < l0.length; i++) {
    if (l0[i].at - l0[i - 1].at > o.gapSec * 1000) gaps.push([l0[i - 1].at, l0[i].at])
  }
  return { pts: mids, gaps, scale, gate }
}

/** M2.1: cluster the trace into sections (intro/build/peak/cooldown) by energy.
 *  Returns section boundaries [startMs, endMs, profile] with smooth crossfade zones. */
export interface Section {
  start: number
  end: number
  profile: 'softer' | 'balanced' | 'stronger' | 'extreme'
}

export function detectSections(l0: Action[], windowSec = 15): Section[] {
  if (l0.length < 4) return []
  const t0 = l0[0].at
  const t1 = l0[l0.length - 1].at
  const win = windowSec * 1000
  // energy + tempo per window
  const windows: Array<{ t: number; energy: number; amp: number; rate: number }> = []
  for (let ts = t0; ts < t1; ts += win / 2) {
    const te = Math.min(t1, ts + win)
    const inWin = l0.filter((a) => a.at >= ts && a.at <= te)
    if (inWin.length < 2) {
      windows.push({ t: ts, energy: 0, amp: 0, rate: 0 })
      continue
    }
    let energy = 0
    const amps: number[] = []
    for (let i = 1; i < inWin.length; i++) {
      const dt = inWin[i].at - inWin[i - 1].at
      const dp = Math.abs(inWin[i].pos - inWin[i - 1].pos)
      if (dt > 0) energy += dp / dt
      amps.push(dp)
    }
    amps.sort((a, b) => a - b)
    const span = (te - ts) / 1000
    windows.push({
      t: ts,
      energy: energy / Math.max(1, span),
      amp: amps[Math.floor(amps.length / 2)],
      rate: inWin.length / Math.max(1, span),
    })
  }
  const eMax = Math.max(1e-9, ...windows.map((w) => w.energy))
  const aMax = Math.max(1e-9, ...windows.map((w) => w.amp))
  const sections: Section[] = windows.map((w) => {
    const e = w.energy / eMax
    const a = w.amp / aMax
    let profile: Section['profile']
    if (w.energy < eMax * 0.05) profile = 'softer' // near-silence
    else if (e > 0.75 && a > 0.6) profile = 'extreme'
    else if (e > 0.55) profile = 'stronger'
    else if (e < 0.3 || a < 0.25) profile = 'softer'
    else profile = 'balanced'
    return { start: w.t, end: w.t + win, profile }
  })
  // merge adjacent same-profile sections
  const merged: Section[] = []
  for (const s of sections) {
    const last = merged[merged.length - 1]
    if (last && last.profile === s.profile) last.end = s.end
    else merged.push({ ...s })
  }
  return merged
}

function sectionAt(sections: Section[], t: number): Section['profile'] {
  if (sections.length === 0) return 'balanced'
  for (const s of sections) if (t >= s.start && t < s.end) return s.profile
  return sections[sections.length - 1].profile
}

/** per-section AutoProfile, derived from the source; crossfade zones blend the knobs */
function sectionProfiles(
  src: Action[],
  sections: Section[],
  o: ConvertOptions,
): Map<string, AutoProfile> {
  const cache = new Map<string, AutoProfile>()
  for (const prof of ['softer', 'balanced', 'stronger', 'extreme'] as const) {
    const { shaping } = deriveAutoProfile(src, prof, {
      gamma: o.gamma,
      gateP: o.gateP,
      target: o.target,
      smoothMs: o.smoothMs,
      floorVal: o.floorVal,
      minGapMs: o.minGapMs,
      duty: o.duty,
      layerDepth: o.depth,
      layerRatio: o.layerRatio,
    })
    cache.set(prof, shaping)
  }
  return cache
}

/** blend two shaping profiles by factor f (0 = a, 1 = b) */
function blendProfile(a: AutoProfile, b: AutoProfile, f: number): AutoProfile {
  const mix = (x: number, y: number) => x + (y - x) * f
  return {
    gamma: mix(a.gamma, b.gamma),
    gateP: mix(a.gateP, b.gateP),
    target: mix(a.target, b.target),
    smoothMs: mix(a.smoothMs, b.smoothMs),
    floorVal: mix(a.floorVal, b.floorVal),
    minGapMs: mix(a.minGapMs, b.minGapMs),
    baseline: mix(a.baseline, b.baseline),
    ripple: mix(a.ripple, b.ripple),
    duty: mix(a.duty, b.duty),
    layerDepth: mix(a.layerDepth, b.layerDepth),
    layerRatio: mix(a.layerRatio, b.layerRatio),
    accent: mix(a.accent, b.accent),
    kick: mix(a.kick, b.kick),
    floorRampMs: mix(a.floorRampMs, b.floorRampMs),
    sections: f > 0.5 ? b.sections : a.sections,
  }
}

/** M2.1: per-sample envelope adjustment using section profiles */
function applySections(
  mids: EnvPoint[],
  src: Action[],
  sections: Section[],
  profCache: Map<string, AutoProfile>,
  crossfadeMs: number,
  baseProfile: AutoProfile | undefined,
): void {
  if (sections.length === 0) return
  const balanced = profCache.get('balanced')!
  for (const m of mids) {
    const prof = sectionAt(sections, m.t)
    const target = profCache.get(prof) ?? balanced
    // crossfade: blend towards previous section profile near boundaries
    let f = 1
    const sec = sections.find((s) => t_in(s, m.t))
    if (sec && m.t - sec.start < crossfadeMs && sections.indexOf(sec) > 0) {
      const prev = sections[sections.indexOf(sec) - 1]
      const prevProf = profCache.get(prev.profile) ?? balanced
      f = (m.t - sec.start) / crossfadeMs
      const blended = blendProfile(prevProf, target, f)
      scaleMid(m, blended, baseProfile)
      continue
    }
    scaleMid(m, target, baseProfile)
  }
}

function t_in(s: Section, t: number): boolean {
  return t >= s.start && t < s.end
}

/** re-normalize one envelope point towards a section profile */
function scaleMid(m: EnvPoint, prof: AutoProfile, _base: AutoProfile | undefined): void {
  // remap the point around the section's target: swing amplitude follows profile contrast
  const contrast = (prof.target / 85) * (2 - prof.gamma) // 1.0-ish for balanced
  void contrast
  // The heavy lifting (baseline/ripple/target) is applied upstream; here we scale
  // the envelope towards the section target with gamma-ish contrast:
  const norm = m.e / 100
  const shaped = Math.pow(norm, 1 / (0.6 + prof.gamma * 0.6))
  m.e = Math.min(100, shaped * prof.target)
}

/** centered moving average over a time window */
function movingAverage(pts: EnvPoint[], windowMs: number): EnvPoint[] {
  if (windowMs <= 0) return pts.map((p) => ({ ...p }))
  const out: EnvPoint[] = []
  let lo = 0
  let hi = 0
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const a = pts[i].t - windowMs / 2
    const b = pts[i].t + windowMs / 2
    while (lo < n && pts[lo].t < a) lo++
    if (hi <= i) hi = i
    while (hi + 1 < n && pts[hi + 1].t <= b) hi++
    let sum = 0
    let cnt = 0
    for (let k = lo; k <= hi; k++) {
      sum += pts[k].e
      cnt++
    }
    out.push({ t: pts[i].t, e: cnt ? sum / cnt : pts[i].e })
  }
  return out
}

// ---------- tempo ----------

interface Tempo {
  revs: number[]
  T: number
  fStroke: number
}

function buildTempo(l0: Action[]): Tempo {
  if (l0.length < 3) return { revs: [l0[0]?.at ?? 0, l0[l0.length - 1]?.at ?? 0], T: 0, fStroke: 0 }
  const revs: number[] = [l0[0].at]
  for (let i = 1; i + 1 < l0.length; i++) {
    const d1 = l0[i].pos - l0[i - 1].pos
    const d2 = l0[i + 1].pos - l0[i].pos
    if (d1 * d2 < 0) revs.push(l0[i].at)
  }
  revs.push(l0[l0.length - 1].at)
  const ints: number[] = []
  for (let i = 1; i + 1 < revs.length; i++) ints.push(revs[i] - revs[i - 1])
  const T = percentile(ints, 0.5)
  return { revs, T, fStroke: 1000 / (2 * T) }
}

/** auto mode: sweep the wave only when half-strokes are long enough for the
 *  spatial handover to be perceivable (>= ~0.9s per half stroke); otherwise glide
 *  with the alternate ping-pong, whose duty-cycle feels smooth instead of hammering. */
function autoTravel(tp: Tempo, o: ConvertOptions): boolean {
  return tp.T >= Math.max(900, o.dwellMs)
}

/** profile-driven weight parameters — profiles must change the WAVE, not only shading */
interface ProfileWeights {
  duty: number // alternate active share
  depth: number // layer breathing depth
  layerRatio: number
  dwellMs: number
}

function profileWeights(o: ConvertOptions): ProfileWeights {
  // deriveAutoProfile already resolved profile-vs-user-override into o.duty/o.depth/
  // o.layerRatio; fall back to the profile defaults when those knobs were never set.
  const dflt: Record<string, ProfileWeights> = {
    softer: { duty: 0.62, depth: 0.22, layerRatio: 0.35, dwellMs: o.dwellMs },
    stronger: { duty: 0.78, depth: 0.55, layerRatio: 0.7, dwellMs: o.dwellMs },
    extreme: { duty: 0.88, depth: 0.75, layerRatio: 1.0, dwellMs: o.dwellMs },
  }
  const d = dflt[o.autoProfile ?? 'balanced'] ?? { duty: 0.7, depth: 0.35, layerRatio: 0.5, dwellMs: o.dwellMs }
  return {
    duty: o.duty ?? d.duty,
    depth: o.depth ?? d.depth,
    layerRatio: o.layerRatio ?? d.layerRatio,
    dwellMs: o.dwellMs,
  }
}

function segOf(revs: number[], t: number): number {
  let k = 0
  while (k + 2 < revs.length && t > revs[k + 1]) k++
  return k
}

// ---------- modes ----------

function wTravel(revs: number[], o: ConvertOptions, t: number): [number, number] {
  const k = segOf(revs, t)
  const d = revs[k + 1] - revs[k]
  if (d < o.dwellMs) return [0.5, 0.5]
  let p = (t - revs[k]) / d
  if ((k % 2 === 1) !== o.travelFromTop) p = 1 - p
  const c = Math.max(0, Math.min(1, p))
  const w1 = (c * c) / ((1 - c) * (1 - c) + c * c)
  return [1 - w1, w1]
}

function wAlternate(revs: number[], o: ConvertOptions, t: number): [number, number] {
  const k = segOf(revs, t)
  const d = revs[k + 1] - revs[k]
  if (d <= 0) return [0.5, 0.5]
  let beat = 1
  if (1000 / d > o.maxSwitchHz) {
    if (500 / d > o.maxSwitchHz) return [0.5, 0.5]
    beat = 2
  }
  const v0Active = Math.floor(k / beat) % 2 === 0
  const duty = profileWeights(o).duty
  return v0Active ? [duty, 1 - duty] : [1 - duty, duty]
}

function wLayer(fMod: number, o: ConvertOptions, t: number): [number, number] {
  const depth = profileWeights(o).depth
  let w0 = 0.5 + depth * Math.sin(2 * Math.PI * fMod * t / 1000)
  w0 = Math.max(0, Math.min(1, w0))
  return [w0, 1 - w0]
}

function wSurge(): [number, number] {
  return [1, 1]
}

function appl(v: number, floorVal: number): number {
  if (v < floorVal / 2) return 0
  if (v < floorVal) return floorVal
  return v
}

// ---------- main ----------

/**
 * Classic conversion: derive one envelope from the top-level L0 actions and split it
 * energy-preservingly onto two vibe axes. Equivalent to convertMapped with the mapping
 * [{source:'L0',target:id0,mode:o.mode},{source:'L0',target:id1,mode:o.mode}].
 */
export function convertScript(fs: Funscript, optsIn: Partial<ConvertOptions> = {}, axisIds: [string, string] = ['V0', 'V1']): ConvertResult {
  const o: ConvertOptions = { ...defaultOptions, ...optsIn }
  const l0 = dedupe(fs.actions)
  if (l0.length === 0) throw new Error('script has no actions')

  // auto-profile: derive shaping from the trace, explicit sliders win
  let autoP: AutoProfile | undefined
  if (o.autoProfile) {
    const derived = deriveAutoProfile(l0, o.autoProfile, {
      gamma: optsIn.gamma,
      gateP: optsIn.gateP,
      target: optsIn.target,
      smoothMs: optsIn.smoothMs,
      floorVal: optsIn.floorVal,
      minGapMs: optsIn.minGapMs,
      duty: optsIn.duty,
      layerDepth: optsIn.depth,
      layerRatio: optsIn.layerRatio,
    })
    autoP = derived.shaping
    Object.assign(o, derived.applied)
    o.baselineKnob = autoP.baseline
    o.rippleKnob = autoP.ripple
  }

  const env = buildEnvelope(l0, o, autoP)
  const tp = buildTempo(l0)
  const fMod = o.layerRatio * tp.fStroke

  interface Row {
    t: number
    e: number
    v0: number
    v1: number
    w0: number
    w1: number
  }
  const accent = o.accent ?? 0
  const kick = o.kick ?? 0
  const rows: Row[] = l0.map((a, idx) => {
    const t = a.at
    const e = sampleE(env.pts, env.gaps, t)
    const w =
      o.mode === 'travel' || (o.mode === 'auto' && autoTravel(tp, o))
        ? wTravel(tp.revs, o, t)
        : o.mode === 'alternate' || o.mode === 'auto'
          ? wAlternate(tp.revs, o, t)
          : o.mode === 'layer'
            ? wLayer(fMod, o, t)
            : wSurge()
    let v0 = appl(e * w[0], o.floorVal)
    let v1 = o.mode === 'surge' ? appl(sampleE(env.pts, env.gaps, t - o.echo), o.floorVal) : appl(e * w[1], o.floorVal)
    // M2.2 accent: inward strokes (positive delta) get a boost on both motors
    if (accent > 0 && idx > 0 && l0[idx].pos > l0[idx - 1].pos) {
      v0 = Math.min(100, v0 * (1 + accent))
      v1 = Math.min(100, v1 * (1 + accent))
    }
    // M2.5 reversal kick: impulse at direction changes
    if (kick > 0 && idx > 0 && idx + 1 < l0.length) {
      const d1 = l0[idx].pos - l0[idx - 1].pos
      const d2 = l0[idx + 1].pos - l0[idx].pos
      if (d1 * d2 < 0) {
        v0 = Math.min(100, v0 + kick * 8)
        v1 = Math.min(100, v1 + kick * 8)
      }
    }
    return { t, e, v0, v1, w0: w[0], w1: w[1] }
  })

  const cap = (axis0: boolean): Action[] => {
    const out: Action[] = []
    let lastT = -1e18
    let lastV = 0
    const ramp = o.floorRampMs ?? 0
    for (let i = 0; i < rows.length; i++) {
      const isLast = i + 1 === rows.length
      if (!isLast && lastT > -1e17 && rows[i].t - lastT < o.minGapMs) continue
      let v = axis0 ? rows[i].v0 : rows[i].v1
      const ramp = o.floorRampMs ?? 0
      if (ramp > 0 && lastV < o.floorVal && v >= o.floorVal) {
        v = o.floorVal + (v - o.floorVal) * 0.5
      }
      out.push({ at: Math.round(rows[i].t), pos: Math.round(v) })
      lastT = rows[i].t
      lastV = v
    }
    return out
  }
  const v0 = postProcess(cap(true), o, true)
  const v1 = postProcess(cap(false), o, true)

  // stats
  const a0 = rows.filter((r) => r.v0 > 0)
  const a1 = rows.filter((r) => r.v1 > 0)
  const p99Of = (vals: number[]) => percentile(vals, 0.99)
  let sw = 0
  let prev = 0
  for (const r of rows) {
    const s = r.w0 > r.w1 ? 1 : r.w0 < r.w1 ? -1 : 0
    if (prev !== 0 && s !== 0 && s !== prev) sw++
    if (s !== 0) prev = s
  }
  const span = tp.revs.length > 1 ? tp.revs[tp.revs.length - 1] - tp.revs[0] : 0
  let degr = 0
  for (let k = 0; k + 1 < tp.revs.length; k++) if (tp.revs[k + 1] - tp.revs[k] < o.dwellMs) degr += tp.revs[k + 1] - tp.revs[k]
  let sat = 0
  if (o.mode === 'surge') for (const r of rows) if (r.e + sampleE(env.pts, env.gaps, r.t - o.echo) > 100) sat++
  let corr = 0
  {
    const pts = rows.filter((r) => r.e > 5)
    const xs = pts.map((r) => r.v0 + r.v1)
    const ys = pts.map((r) => 2 * r.e)
    if (xs.length > 1) {
      const mx = xs.reduce((s, v) => s + v, 0) / xs.length
      const my = ys.reduce((s, v) => s + v, 0) / ys.length
      let num = 0
      let dx = 0
      let dy = 0
      for (let i = 0; i < xs.length; i++) {
        num += (xs[i] - mx) * (ys[i] - my)
        dx += (xs[i] - mx) ** 2
        dy += (ys[i] - my) ** 2
      }
      corr = dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0
    }
  }

  const stats: ConvertStats = {
    tempo: { halfStrokeMs: tp.T, fStroke: tp.fStroke },
    scale: env.scale,
    gate: env.gate,
    axes: [
      { id: axisIds[0], actions: v0.length, activePct: (100 * a0.length) / rows.length, meanActive: a0.length ? a0.reduce((s, r) => s + r.v0, 0) / a0.length : 0, p99: p99Of(a0.map((r) => r.v0)), max: a0.length ? Math.max(...a0.map((r) => r.v0)) : 0 },
      { id: axisIds[1], actions: v1.length, activePct: (100 * a1.length) / rows.length, meanActive: a1.length ? a1.reduce((s, r) => s + r.v1, 0) / a1.length : 0, p99: p99Of(a1.map((r) => r.v1)), max: a1.length ? Math.max(...a1.map((r) => r.v1)) : 0 },
    ],
    switchHz: span > 0 ? sw / (span / 1000) : 0,
    degradedPct: span > 0 ? (100 * degr) / span : 0,
    saturationPct: rows.length && o.mode === 'surge' ? (100 * sat) / rows.length : 0,
    corr,
  }

  // preview: envelope at ~600 samples across the active span
  const preview: Array<[number, number]> = []
  if (env.pts.length > 1) {
    const t0 = env.pts[0].t
    const t1 = env.pts[env.pts.length - 1].t
    const n = Math.min(600, Math.max(2, Math.floor((t1 - t0) / 100)))
    for (let i = 0; i <= n; i++) {
      const t = t0 + ((t1 - t0) * i) / n
      preview.push([t, sampleE(env.pts, env.gaps, t)])
    }
  }

  return { axes: [ { id: axisIds[0], actions: v0 }, { id: axisIds[1], actions: v1 } ], envelope: preview, stats }
}

/** Output action values at a given time for live playback (interpolated, device-passed). */
export function envelopeAt(result: ConvertResult, t: number): [number, number] {
  const acts = (i: 0 | 1) => result.axes[i].actions
  const evalAxis = (actions: Action[]): number => {
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
  return [evalAxis(acts(0)), evalAxis(acts(1))]
}

// ============================== mapping engine ==============================
// Remap ANY existing trace (L0 top-level, l2, r0, v0, ...) onto vibe targets with a
// per-trace conversion mode. Semantics:
//
//  - Coupled pair: both targets map from the SAME source with the SAME mode ->
//    the classic energy-preserving split (w0+w1=1: travel/alternate/layer/surge/auto).
//  - Independent rows (different sources, different modes, or only one target):
//    each target = its own source's envelope shaped by its row mode:
//      auto | travel | surge -> full envelope of the source
//      alternate             -> tempo-locked pulse (duty) at the source's own tempo
//      layer                 -> breathing modulation at the source's own tempo
//  - Vibe-like sources (id starts with "v", e.g. an existing v0 track) are treated as
//    intensity directly (pos IS the intensity, no speed differential).
//  - Unmapped targets are left out of the result entirely.

export interface MappingResult {
  axes: Array<{ id: string; actions: Action[] }>
  perAxis: Array<{
    target: string
    source: string
    mode: Mode | 'coupled'
    coupled: boolean
    stats: ConvertStats
  }>
}

// ============================== vacuum track generation ==============================
// Vacuum/suction devices (A0 valve / L3 suck class): the funscript convention maps
// suction strength to pos (0 = no suction, 100 = full vacuum). Two ways to derive it:
//
//  - mode "stroke": vacuum follows the stroke position — suction is highest when the
//    stroke is at the bottom (inserted) and releases towards the top. Shape via depth.
//  - mode "pulse": rhythmic pulsing locked to the stroke tempo (tempo-locked square
//    wave with duty), scaled by the intensity envelope.
//  - mode "envelope": suction = stroke speed envelope (same as vibe intensity) — for
//    toys where suction should follow action intensity.
//
// The result is a normal funscript axis (default id "A0") with at/pos 0-100.

export type VacuumMode = 'stroke' | 'pulse' | 'envelope'

export interface VacuumOptions {
  mode: VacuumMode
  /** suction depth: 0 = gentle, 1 = full range tracking */
  depth: number // 0..1, default 0.8
  /** pulse duty (fraction of the stroke period with active suction) */
  duty: number // 0..1, default 0.5
  /** invert: suction peaks at top instead of bottom (stroke mode) */
  invert: boolean // default false
  /** offset pos added at rest (0..100); 0 = fully release */
  basePos: number // default 0
  minGapMs: number
  floorVal: number
  /**
   * Pulse hardware: devices like the Svakom Sam Neo do NOT hold a vacuum level —
   * they apply suction as discrete pump pulses. Instead of a continuous position
   * curve, the track becomes rhythmic on/off pulses (pos jumps between base and
   * suction peaks), paced by the stroke tempo.
   */
  pumpPulses: boolean // default false
  /** pump pulse rate in Hz when pumpPulses is on (independent of stroke tempo) */
  pulseHz: number // default 2.5
}

export const defaultVacuumOptions: VacuumOptions = {
  mode: 'stroke',
  depth: 0.8,
  duty: 0.5,
  invert: false,
  basePos: 0,
  minGapMs: 60,
  floorVal: 0,
  pumpPulses: false,
  pulseHz: 2.5,
}

export interface VacuumResult {
  axisId: string
  actions: Action[]
  stats: {
    actions: number
    activePct: number
    meanActive: number
    max: number
    tempoHz: number
    mode: VacuumMode
    pumpPulses: boolean
    pulseHz: number
  }
}

/**
 * Generate a vacuum/suction track from an existing trace (default: L0 stroke).
 * Uses the stroke POSITION (not speed) for stroke mode: vacuum is a position-class
 * axis, so the natural source is where the stroke currently is.
 */
export function generateVacuum(
  fs: Funscript,
  optsIn: Partial<VacuumOptions> = {},
  sourceId = 'L0',
  axisId = 'A0',
): VacuumResult {
  const o: VacuumOptions = { ...defaultVacuumOptions, ...optsIn }
  const src = dedupe(sourceId === 'L0' ? fs.actions : fs.axes.find((a) => a.id.toLowerCase() === sourceId.toLowerCase())?.actions ?? [])
  if (src.length < 2) throw new Error(`source "${sourceId}" has too few actions`)

  const tp = buildTempo(src)
  const fMod = 0.5 * tp.fStroke // pulse at half the stroke frequency (one pulse per full stroke)
  const env = buildEnvelope(src, { ...defaultOptions, gapSec: 3, gamma: 1 })

  interface Row {
    t: number
    pos: number
  }

  // helper: smooth base curve value at time t (before pump pulsing)
  const minPos = Math.min(...src.map((a) => a.pos))
  const maxPos = Math.max(...src.map((a) => a.pos))
  const normAt = (t: number): number => {
    // normalized stroke position 0..1 at time t (interpolated); 0 = top (pos min), 1 = bottom (pos max)
    if (t <= src[0].at) return (src[0].pos - minPos) / (maxPos - minPos || 1)
    if (t >= src[src.length - 1].at) return (src[src.length - 1].pos - minPos) / (maxPos - minPos || 1)
    let lo = 0
    let hi = src.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (src[mid].at <= t) lo = mid
      else hi = mid
    }
    const a = src[lo]
    const b = src[hi]
    const f = (t - a.at) / (b.at - a.at || 1)
    return ((a.pos + f * (b.pos - a.pos)) - minPos) / (maxPos - minPos || 1)
  }
  const baseCurve = (t: number): number => {
    let out: number
    if (o.mode === 'envelope') {
      out = sampleE(env.pts, env.gaps, t) / 100
    } else if (o.mode === 'pulse') {
      const k = segOf(tp.revs, t)
      const d = tp.revs[k + 1] - tp.revs[k]
      let beat = 1
      if (d > 0 && 1000 / d > 1.5) beat = 2 // too fast: pulse per full stroke
      const active = Math.floor(k / beat) % 2 === 0
      const intensity = sampleE(env.pts, env.gaps, t) / 100
      out = active ? o.duty + (1 - o.duty) * intensity : (1 - o.duty) * intensity * 0.5
    } else {
      // stroke mode: suction from the actual stroke position — deepest at the bottom
      // of the stroke (max pos), releasing towards the top. invert flips it.
      const norm = normAt(t) // 0 = top, 1 = bottom
      out = 1 - norm
    }
    if (o.invert) out = 1 - out
    return o.basePos + out * (o.depth * 100 - o.basePos)
  }

  let rows: Row[]
  if (o.pumpPulses) {
    // Pump-style hardware (e.g. Svakom Sam Neo): no sustained vacuum. Emit discrete
    // on/off pulses at pulseHz; each pulse's suction depth follows the base curve
    // (scaled by depth), so intensity still tracks the source. Pauses in the source
    // stop the pumping entirely (no orphan pumping).
    rows = []
    const period = 1000 / o.pulseHz
    const activeMs = period * Math.min(0.6, Math.max(0.15, o.duty))
    const firstT = src[0].at
    const lastT = src[src.length - 1].at
    for (let t = firstT; t <= lastT; t += period) {
      // check source activity in this pulse window (gap silence kills the pulse)
      const e = sampleE(env.pts, env.gaps, t)
      if (env.gaps.some(([a, b]) => t > a && t < b)) continue
      const depth01 = baseCurve(t) / 100 // 0..1 suction level for this pulse
      if (depth01 <= 0.02) continue
      const peak = Math.round(Math.max(0, Math.min(100, depth01 * 100)))
      rows.push({ t, pos: peak })
      const offT = t + activeMs
      if (offT < lastT) rows.push({ t: offT, pos: 0 })
    }
    rows.sort((a, b) => a.t - b.t)
  } else {
    rows = src.map((a) => {
      const t = a.at
      const pos = baseCurve(t)
      const clamped = Math.max(0, Math.min(100, o.floorVal > 0 ? Math.max(pos, o.floorVal) : pos))
      return { t, pos: Math.round(clamped) }
    })
  }

  // rate cap + stop handling: vacuum should RELEASE at the end
  const out: Action[] = []
  let lastT = -1e18
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const isLast = i + 1 === rows.length
    // pump pulses must never be dropped by the rate cap (they ARE the on/off pattern)
    if (o.pumpPulses && r.pos === 0) {
      out.push({ at: Math.round(r.t), pos: 0 })
      continue
    }
    if (!isLast && lastT > -1e17 && r.t - lastT < o.minGapMs) continue
    out.push({ at: Math.round(r.t), pos: isLast ? 0 : r.pos })
    lastT = r.t
  }

  const active = out.filter((a) => a.pos > 0)
  return {
    axisId,
    actions: out,
    stats: {
      actions: out.length,
      activePct: out.length ? (100 * active.length) / out.length : 0,
      meanActive: active.length ? active.reduce((s, a) => s + a.pos, 0) / active.length : 0,
      max: active.length ? Math.max(...active.map((a) => a.pos)) : 0,
      tempoHz: tp.fStroke,
      mode: o.mode,
      pumpPulses: o.pumpPulses,
      pulseHz: o.pulseHz,
    },
  }
}

/** Axis ids available as mapping sources: "L0" + every axes[] id (case preserved). */
export function availableSources(fs: Funscript): Array<{ id: string; actions: number; vibeLike: boolean }> {
  const out: Array<{ id: string; actions: number; vibeLike: boolean }> = [
    { id: 'L0', actions: fs.actions.length, vibeLike: false },
  ]
  for (const ax of fs.axes) {
    out.push({ id: ax.id, actions: ax.actions.length, vibeLike: /^v/i.test(ax.id) })
  }
  return out
}

// ============================== source quality rating ==============================

export interface SourceRating {
  id: string
  actions: number
  vibeLike: boolean
  spanSec: number // active span
  tempoHz: number // stroke frequency of this trace
  amplitudeRange: number // median |dp| across actions
  density: number // actions per active second
  smoothness: number // 0..1, share of actions that are NOT hard square jumps
  noiseRatio: number // 0..1, share of tiny jitter movements
  parallelToL0: number | null // 0..1 correlation with L0 speed (null if not computable)
  score: number // 0..100 overall usability as vibe source
  verdict: 'good' | 'ok' | 'poor'
  notes: string[] // human-readable reasons
  /** concrete, actionable tuning suggestions derived from the measured profile */
  recommendations: string[]
  /** relative speed load: median speed as fraction of the p99 speed of this trace (0..1) */
  speedLoad: number
}

export function rateSources(fs: Funscript, exclude: string[] = []): SourceRating[] {
  const excluded = new Set(exclude.map((e) => e.toLowerCase()))
  const sources = availableSources(fs).filter((s) => !excluded.has(s.id.toLowerCase()))
  const l0Speed = speedSeries(dedupe(fs.actions))
  const out: SourceRating[] = []
  for (const s of sources) {
    try {
      const actions = s.id === 'L0' ? dedupe(fs.actions) : dedupe(getSourceActions(fs, s.id))
      out.push(rateOne(s.id, actions, s.vibeLike, l0Speed))
    } catch {
      // skip unratable axes
    }
  }
  return out
}

/** speed series between consecutive actions (pos/ms) at midpoints */
function speedSeries(actions: Action[]): Array<{ t: number; v: number }> {
  const out: Array<{ t: number; v: number }> = []
  for (let i = 1; i < actions.length; i++) {
    const dt = actions[i].at - actions[i - 1].at
    const dp = Math.abs(actions[i].pos - actions[i - 1].pos)
    out.push({ t: (actions[i].at + actions[i - 1].at) / 2, v: dt > 0 ? dp / dt : 0 })
  }
  return out
}

function correlation(a: number[], b: number[]): number | null {
  if (a.length < 3 || a.length !== b.length) return null
  const ma = a.reduce((x, y) => x + y, 0) / a.length
  const mb = b.reduce((x, y) => x + y, 0) / b.length
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb)
    da += (a[i] - ma) ** 2
    db += (b[i] - mb) ** 2
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null
}

function rateOne(id: string, actions: Action[], vibeLike: boolean, l0Speed: Array<{ t: number; v: number }>): SourceRating {
  const notes: string[] = []
  const spanSec = actions.length > 1 ? (actions[actions.length - 1].at - actions[0].at) / 1000 : 0

  // tempo: median half-stroke interval from reversals
  let tempoHz = 0
  if (actions.length >= 3) {
    const revs: number[] = [actions[0].at]
    for (let i = 1; i + 1 < actions.length; i++) {
      const d1 = actions[i].pos - actions[i - 1].pos
      const d2 = actions[i + 1].pos - actions[i].pos
      if (d1 * d2 < 0) revs.push(actions[i].at)
    }
    revs.push(actions[actions.length - 1].at)
    const ints: number[] = []
    for (let i = 1; i + 1 < revs.length; i++) ints.push(revs[i] - revs[i - 1])
    if (ints.length > 0) {
      const T = percentile(ints, 0.5)
      tempoHz = T > 0 ? 1000 / (2 * T) : 0
    }
  }

  // amplitude: median |dp|
  const dps: number[] = []
  for (let i = 1; i < actions.length; i++) dps.push(Math.abs(actions[i].pos - actions[i - 1].pos))
  const amplitudeRange = dps.length ? percentile(dps, 0.5) : 0

  // density: actions per active second
  const density = spanSec > 0 ? actions.length / spanSec : 0

  // smoothness: share of segments that are not square jumps (jump = dp >= 25 within <= 100ms)
  let jumps = 0
  let jitter = 0
  for (let i = 1; i < actions.length; i++) {
    const dt = actions[i].at - actions[i - 1].at
    const dp = Math.abs(actions[i].pos - actions[i - 1].pos)
    if (dt <= 100 && dp >= 25) jumps++
    if (dt >= 10 && dt <= 300 && dp > 0 && dp < 3) jitter++
  }
  const smoothness = actions.length > 1 ? 1 - jumps / (actions.length - 1) : 1
  const noiseRatio = actions.length > 1 ? jitter / (actions.length - 1) : 0

  // parallelism with L0 speed (resampled at this trace's midpoints)
  const mySpeed = speedSeries(actions)
  let parallelToL0: number | null = null
  if (id !== 'L0' && !vibeLike && mySpeed.length >= 3 && l0Speed.length >= 3) {
    const sample = (t: number) => {
      if (t <= l0Speed[0].t) return l0Speed[0].v
      if (t >= l0Speed[l0Speed.length - 1].t) return l0Speed[l0Speed.length - 1].v
      let lo = 0
      let hi = l0Speed.length - 1
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (l0Speed[mid].t <= t) lo = mid
        else hi = mid
      }
      const a = l0Speed[lo]
      const b = l0Speed[hi]
      const f = (t - a.t) / (b.t - a.t || 1)
      return a.v + f * (b.v - a.v)
    }
    parallelToL0 = correlation(
      mySpeed.map((m) => m.v),
      mySpeed.map((m) => sample(m.t)),
    )
  }

  // ---- measured speed profile (for load estimate + recommendations) ----
  const speeds = speedSeries(actions).map((m) => m.v)
  const speedMed = speeds.length ? percentile(speeds, 0.5) : 0
  const speedP99 = speeds.length ? percentile(speeds, 0.99) : 0
  // load = median speed as fraction of a "full stroke" reference (100 pos in 300 ms
  // ≈ 0.333 pos/ms): 1.0 means the trace strokes at full-stroke speed on average
  const speedLoad = speedMed / 0.333

  // ---- scoring 0..100 ----
  if (vibeLike) {
    // a vibe-like trace is already an intensity track: inherently usable
    notes.push('vibe-like: intensity is used directly (no speed derivation)')
    const recs = recommend(id, vibeLike, tempoHz, amplitudeRange, smoothness, noiseRatio, speedLoad, parallelToL0, spanSec)
    return finish(id, actions.length, vibeLike, spanSec, tempoHz, amplitudeRange, density, smoothness, noiseRatio, parallelToL0, 85, 'good', notes, recs, speedLoad)
  }

  let score = 0
  // tempo (0..35)
  if (tempoHz >= 0.25 && tempoHz <= 2.5) score += 35
  else if (tempoHz > 0.1 && tempoHz < 4) score += 18
  else score += 4
  // amplitude (0..25): broad range good, tiny range bad
  if (amplitudeRange >= 12) score += 25
  else if (amplitudeRange >= 6) score += 15
  else score += 5
  // smoothness (0..20)
  score += Math.round(20 * smoothness)
  // density (0..10): sane middle is best
  if (density >= 0.4 && density <= 4) score += 10
  else if (density > 0.1) score += 5
  // noise (0..10 penalty already implicit via smoothness; explicit jitter penalty)
  if (noiseRatio > 0.25) score -= 8
  // excellence bonus: a trace with perfect tempo, broad amplitudes, no jitter and sane
  // density deserves the full 100 — without it the model tops out at 90
  if (tempoHz >= 0.25 && tempoHz <= 2.5 && amplitudeRange >= 12 && noiseRatio <= 0.05 && density >= 0.4 && density <= 4) score += 10
  if (score < 0) score = 0
  if (score > 100) score = 100

  // notes
  if (tempoHz === 0) notes.push('no usable stroke rhythm detected')
  else if (tempoHz < 0.25) notes.push(`very slow tempo (${tempoHz.toFixed(2)} Hz)`)
  else if (tempoHz > 2.5) notes.push(`very fast tempo (${tempoHz.toFixed(2)} Hz) — spatial patterns will degrade`)
  if (amplitudeRange < 6) notes.push(`tiny amplitudes (median ${amplitudeRange.toFixed(1)} pos) — little intensity variation`)
  else if (amplitudeRange >= 12) notes.push(`healthy amplitudes (median ${amplitudeRange.toFixed(1)} pos)`)
  if (smoothness < 0.7) notes.push(`${Math.round((1 - smoothness) * 100)}% hard jumps (square-like) — gate/smoothing recommended`)
  else if (smoothness > 0.95) notes.push('smooth, well-formed motion')
  if (noiseRatio > 0.25) notes.push(`${Math.round(noiseRatio * 100)}% micro-jitter actions`)
  if (density > 6) notes.push(`very dense (${density.toFixed(1)} actions/s)`)
  if (parallelToL0 !== null && parallelToL0 > 0.85) {
    notes.push(`strongly parallel to L0 (${Math.round(parallelToL0 * 100)}%) — adds little new information`)
  } else if (parallelToL0 !== null && parallelToL0 < 0.3) {
    notes.push(`independent motion vs L0 (${Math.round(parallelToL0 * 100)}%) — good as a texture source`)
  }

  const verdict: SourceRating['verdict'] = score >= 65 ? 'good' : score >= 40 ? 'ok' : 'poor'
  const recs = recommend(id, vibeLike, tempoHz, amplitudeRange, smoothness, noiseRatio, speedLoad, parallelToL0, spanSec)
  return finish(id, actions.length, vibeLike, spanSec, tempoHz, amplitudeRange, density, smoothness, noiseRatio, parallelToL0, score, verdict, notes, recs, speedLoad)
}

/** Concrete tuning recommendations derived from the measured trace profile. */
function recommend(
  id: string,
  vibeLike: boolean,
  tempoHz: number,
  amplitudeRange: number,
  smoothness: number,
  noiseRatio: number,
  speedLoad: number,
  parallelToL0: number | null,
  spanSec: number,
): string[] {
  const recs: string[] = []
  const pct = (v: number) => Math.round(v * 100)

  // heavy continuous load (the "Dauerhammer" script): median speed close to p99 speed
  if (speedLoad > 0.55) {
    recs.push(`Heavy continuous load: median speed is ${pct(speedLoad)}% of full-stroke speed — set Target ↓ to ~70 (shaping row) and gamma ↓ to avoid constant 90–100% intensity`)
    recs.push('Raise the noise gate (Gate ↑ to ~25–30%) and smoothing (Smooth ↑ to ~200 ms) — both in the shaping row — to turn the hammering into perceivable waves')
  }

  // tempo-driven advice
  if (tempoHz > 2.5) {
    recs.push(`Fast trace (${tempoHz.toFixed(2)} Hz): travel/alternate patterns degrade — use mode "layer" or "surge", or slow the source down first`)
    if (speedLoad <= 0.55) recs.push('Consider a higher dwell (dwell ↑) so motor switches stay perceivable')
  } else if (speedLoad > 0.55) {
    // fast *load* but tempo itself in range: pattern modes will still mostly degrade
    recs.push('High continuous speed: spatial patterns (travel/alternate) will rarely engage — mode "layer" gives the most honest texture')
  } else if (tempoHz > 0 && tempoHz < 0.25) {
    recs.push(`Very slow tempo (${tempoHz.toFixed(2)} Hz): intensities will sit very low — lower gamma (gamma ↓ to ~0.5) to lift quiet sections`)
  } else if (tempoHz === 0) {
    recs.push('No stroke rhythm detected: this trace is not a usable intensity source on its own — combine with L0 or use "layer" texture only')
  } else {
    recs.push('Tempo is in the sweet spot (0.25–2.5 Hz): default settings (mode auto, gamma 0.65) are fine')
  }

  // amplitude-driven advice
  if (amplitudeRange < 6) {
    recs.push('Tiny amplitudes: little intensity variation — either gamma ↓ (more lift) or pick a different source trace')
  }

  // square jumps
  if (smoothness < 0.7) {
    recs.push('Square-jump bursts detected: strong smoothing required (smooth ↑ 150–250 ms) and gate ↑; expect texture, not precision')
  }

  // jitter
  if (noiseRatio > 0.25) {
    recs.push('Micro-jitter: the noise gate will cut these automatically; verify activity % after conversion is 30–70%')
  }

  // redundancy
  if (parallelToL0 !== null && parallelToL0 > 0.85) {
    recs.push('Trace is nearly parallel to L0: mapping it adds little — prefer L0 for intensity and use this trace only for texture variety')
  }

  // usage hints
  if (recs.length === 0) {
    recs.push('No issues found — map as usual (L0 → both targets or per-trace mapping)')
  }
  return recs
}

function finish(
  id: string,
  actions: number,
  vibeLike: boolean,
  spanSec: number,
  tempoHz: number,
  amplitudeRange: number,
  density: number,
  smoothness: number,
  noiseRatio: number,
  parallelToL0: number | null,
  score: number,
  verdict: SourceRating['verdict'],
  notes: string[],
  recommendations: string[],
  speedLoad: number,
): SourceRating {
  return { id, actions, vibeLike, spanSec, tempoHz, amplitudeRange, density, smoothness, noiseRatio, parallelToL0, score, verdict, notes, recommendations, speedLoad }
}

function getSourceActions(fs: Funscript, source: string): Action[] {
  if (source === 'L0') return dedupe(fs.actions)
  const ax = fs.axes.find((a) => a.id.toLowerCase() === source.toLowerCase())
  if (!ax) throw new Error(`source axis "${source}" not found`)
  return dedupe(ax.actions)
}

interface EnvBundle {
  pts: EnvPoint[]
  gaps: Array<[number, number]>
  scale: number
  gate: number
  direct?: boolean
}

interface ShapedTrack {
  actions: Action[]
  stats: ConvertStats
  env: EnvBundle
  tempo: Tempo
}

function shapeTrackFrom(src: Action[], mode: Mode, o: ConvertOptions, env: EnvBundle, tp: Tempo): ShapedTrack {
  const fMod = o.layerRatio * tp.fStroke
  return finalizeShape(src, env, tp, fMod, mode, o)
}

function finalizeShape(
  src: Action[],
  env: EnvBundle,
  tp: Tempo,
  fMod: number,
  mode: Mode,
  o: ConvertOptions,
): ShapedTrack {
  const accent = o.accent ?? 0
  const kick = o.kick ?? 0

  interface Row {
    t: number
    e: number
    v: number
  }
  const rows: Row[] = src.map((a, idx) => {
    const t = a.at
    const e = sampleE(env.pts, env.gaps, t, env.direct)
    // M2.2: stroke accent — boost when the source moves inward (positive delta)
    let eAcc = e
    if (accent > 0 && idx > 0) {
      const dpos = src[idx].pos - src[idx - 1].pos
      if (dpos > 0) eAcc = Math.min(100, e * (1 + accent))
    }
    let v: number
    if (mode === 'alternate') {
      // tempo-locked pulse at the source's own tempo
      const k = segOf(tp.revs, t)
      const d = tp.revs[k + 1] - tp.revs[k]
      if (d <= 0) {
        v = e * 0.5
      } else {
        let beat = 1
        if (1000 / d > o.maxSwitchHz) {
          if (500 / d > o.maxSwitchHz) beat = 0 // too fast: steady mid drive
          else beat = 2
        }
        const active = beat === 0 ? true : Math.floor(k / beat) % 2 === 0
        v = e * (active ? o.duty : 1 - o.duty)
      }
    } else if (mode === 'layer') {
      // breathing modulation at the source's own tempo
      const w = 0.5 + o.depth * Math.sin(2 * Math.PI * fMod * t / 1000)
      v = e * Math.max(0, Math.min(1, w))
    } else {
      // auto | travel | surge -> full envelope (spatial handover needs a coupled pair)
      v = eAcc
    }
    // M2.2/M2.5 apply to ALL modes: accent boosts inward strokes, kick fires right
    // after a reversal (peak intensity just when the direction flips)
    if (accent > 0 && idx > 0 && src[idx].pos > src[idx - 1].pos) {
      v = Math.min(100, v * (1 + accent))
    }
    if (kick > 0 && idx > 0 && idx + 1 < src.length) {
      const d1 = src[idx].pos - src[idx - 1].pos
      const d2 = src[idx + 1].pos - src[idx].pos
      if (d1 * d2 < 0) {
        // reversal at this action: add impulse to this and the following 80ms
        v = Math.min(100, v + kick * 8)
      }
    }
    return { t, e, v: appl(v, o.floorVal) }
  })

  const cap = (): Action[] => {
    const out: Action[] = []
    let lastT = -1e18
    let lastV = 0
    const ramp = o.floorRampMs ?? 0
    for (let i = 0; i < rows.length; i++) {
      const isLast = i + 1 === rows.length
      if (!isLast && lastT > -1e17 && rows[i].t - lastT < o.minGapMs) continue
      let v = rows[i].v
      // M2.5 soft floor ramp: rise gently from 0/floor instead of jumping
      if (ramp > 0 && lastV < o.floorVal && v >= o.floorVal) {
        v = o.floorVal + (v - o.floorVal) * 0.5
      }
      out.push({ at: Math.round(rows[i].t), pos: Math.round(v) })
      lastT = rows[i].t
      lastV = v
    }
    return out
  }
  const actions = cap()

  const active = rows.filter((r) => r.v > 0)
  const stats: ConvertStats = {
    tempo: { halfStrokeMs: tp.T, fStroke: tp.fStroke },
    scale: 1,
    gate: 0,
    axes: [
      {
        actions: actions.length,
        activePct: rows.length ? (100 * active.length) / rows.length : 0,
        meanActive: active.length ? active.reduce((s, r) => s + r.v, 0) / active.length : 0,
        p99: percentile(active.map((r) => r.v), 0.99),
        max: active.length ? Math.max(...active.map((r) => r.v)) : 0,
        id: '',
      },
    ],
    switchHz: 0,
    degradedPct: 0,
    saturationPct: 0,
    corr: 1,
  }
  return { actions, stats, env, tempo: tp }
}

/** Envelope of a vibe-like source: pos IS the intensity (no speed differential). */
function buildDirectEnvelope(src: Action[], o: ConvertOptions): { pts: EnvPoint[]; gaps: Array<[number, number]>; scale: number; gate: number; direct: true } {
  const pts: EnvPoint[] = src.map((a) => ({ t: a.at, e: Math.max(0, Math.min(100, a.pos)) }))
  const gaps: Array<[number, number]> = []
  for (let i = 1; i < src.length; i++) {
    if (src[i].at - src[i - 1].at > o.gapSec * 1000) gaps.push([src[i - 1].at, src[i].at])
  }
  return { pts, gaps, scale: 1, gate: 0, direct: true }
}

export function convertMapped(fs: Funscript, o: ConvertOptions): MappingResult {
  const mappings = o.mappings ?? []
  if (mappings.length === 0) throw new Error('no mappings given')
  const byTarget = new Map<string, AxisMapping>()
  for (const m of mappings) byTarget.set(m.target.toLowerCase(), m)

  const tgt0 = byTarget.get('v0')
  const tgt1 = byTarget.get('v1')
  const coupled =
    tgt0 && tgt1 && tgt0.source.toLowerCase() === tgt1.source.toLowerCase() && tgt0.mode === tgt1.mode

  const result: MappingResult = { axes: [], perAxis: [] }

  if (coupled) {
    // classic energy-preserving split from one source
    const src = getSourceActions(fs, tgt0!.source)
    if (src.length === 0) throw new Error(`source "${tgt0!.source}" has no actions`)
    const vibeLike = !tgt0!.source.match(/^L0$/i) && /^v/i.test(tgt0!.source)
    const pairOpts: ConvertOptions = { ...o, mode: tgt0!.mode }
    const autoP: AutoProfile | undefined = pairOpts.autoProfile
      ? deriveAutoProfile(src, pairOpts.autoProfile, {
          gamma: o.gamma,
          gateP: o.gateP,
          target: o.target,
          smoothMs: o.smoothMs,
          floorVal: o.floorVal,
          minGapMs: o.minGapMs,
          duty: o.duty,
          layerDepth: o.depth,
          layerRatio: o.layerRatio,
        }).shaping
      : undefined
    if (autoP) {
      Object.assign(pairOpts, {
        gamma: o.gamma ?? autoP.gamma,
        gateP: o.gateP ?? autoP.gateP,
        target: o.target ?? autoP.target,
        smoothMs: o.smoothMs ?? autoP.smoothMs,
        floorVal: o.floorVal ?? autoP.floorVal,
        minGapMs: o.minGapMs ?? autoP.minGapMs,
        duty: o.duty ?? autoP.duty,
        depth: o.depth ?? autoP.layerDepth,
        layerRatio: o.layerRatio ?? autoP.layerRatio,
        baselineKnob: o.baselineKnob ?? autoP.baseline,
        rippleKnob: o.rippleKnob ?? autoP.ripple,
      })
    }
    const env = vibeLike ? buildDirectEnvelope(src, pairOpts) : buildEnvelope(src, pairOpts, autoP)
    const tp = vibeLike ? { revs: [src[0]?.at ?? 0, src[src.length - 1]?.at ?? 0], T: 0, fStroke: 0 } : buildTempo(src)
    const fMod = pairOpts.layerRatio * tp.fStroke

    interface Row {
      t: number
      e: number
      v0: number
      v1: number
      w0: number
      w1: number
    }
    const rows: Row[] = src.map((a) => {
      const t = a.at
      const e = sampleE(env.pts, env.gaps, t, env.direct)
      const w =
        pairOpts.mode === 'travel' || o.mode === 'auto'
          ? wTravel(tp.revs, pairOpts, t)
          : pairOpts.mode === 'alternate'
            ? wAlternate(tp.revs, pairOpts, t)
            : pairOpts.mode === 'layer'
              ? wLayer(fMod, pairOpts, t)
              : wSurge()
      const v0 = appl(e * w[0], pairOpts.floorVal)
      const v1 = pairOpts.mode === 'surge' ? appl(sampleE(env.pts, env.gaps, t - pairOpts.echo, env.direct), pairOpts.floorVal) : appl(e * w[1], pairOpts.floorVal)
      return { t, e, v0, v1, w0: w[0], w1: w[1] }
    })
    const cap = (axis0: boolean): Action[] => {
      const out: Action[] = []
      let lastT = -1e18
      let lastV = 0
      const ramp = pairOpts.floorRampMs ?? 0
      for (let i = 0; i < rows.length; i++) {
        const isLast = i + 1 === rows.length
        if (!isLast && lastT > -1e17 && rows[i].t - lastT < pairOpts.minGapMs) continue
        let v = axis0 ? rows[i].v0 : rows[i].v1
        if (ramp > 0 && lastV < pairOpts.floorVal && v >= pairOpts.floorVal) {
          v = pairOpts.floorVal + (v - pairOpts.floorVal) * 0.5
        }
        out.push({ at: Math.round(rows[i].t), pos: Math.round(v) })
        lastT = rows[i].t
        lastV = v
      }
      return out
    }
    result.axes = [
      { id: tgt0!.target, actions: postProcess(cap(true), pairOpts, true) },
      { id: tgt1!.target, actions: postProcess(cap(false), pairOpts, true) },
    ]
    result.perAxis = [
      { target: tgt0!.target, source: tgt0!.source, mode: 'coupled', coupled: true, stats: statsFor(rows.map((r) => r.v0), rows.map((r) => r.e), tp) },
      { target: tgt1!.target, source: tgt1!.source, mode: 'coupled', coupled: true, stats: statsFor(rows.map((r) => r.v1), rows.map((r) => r.e), tp) },
    ]
    return result
  }

  // independent rows
  for (const m of mappings) {
    const src = getSourceActions(fs, m.source)
    if (src.length === 0) throw new Error(`source "${m.source}" has no actions`)
    const vibeLike = m.source !== 'L0' && /^v/i.test(m.source)
    const rowOpts: ConvertOptions = { ...o }
    const autoP: AutoProfile | undefined = o.autoProfile
      ? deriveAutoProfile(src, o.autoProfile, {
          gamma: o.gamma,
          gateP: o.gateP,
          target: o.target,
          smoothMs: o.smoothMs,
          floorVal: o.floorVal,
          minGapMs: o.minGapMs,
          duty: o.duty,
          layerDepth: o.depth,
          layerRatio: o.layerRatio,
        }).shaping
      : undefined
    if (autoP) {
      Object.assign(rowOpts, {
        gamma: o.gamma ?? autoP.gamma,
        gateP: o.gateP ?? autoP.gateP,
        target: o.target ?? autoP.target,
        smoothMs: o.smoothMs ?? autoP.smoothMs,
        floorVal: o.floorVal ?? autoP.floorVal,
        minGapMs: o.minGapMs ?? autoP.minGapMs,
        duty: o.duty ?? autoP.duty,
        depth: o.depth ?? autoP.layerDepth,
        layerRatio: o.layerRatio ?? autoP.layerRatio,
        baselineKnob: o.baselineKnob ?? autoP.baseline,
        rippleKnob: o.rippleKnob ?? autoP.ripple,
      })
    }
    const env = vibeLike ? buildDirectEnvelope(src, rowOpts) : buildEnvelope(src, rowOpts, autoP)
    const tp = vibeLike ? { revs: [src[0]?.at ?? 0, src[src.length - 1]?.at ?? 0], T: 0, fStroke: 0 } : buildTempo(src)
    const shaped = shapeTrackFrom(src, m.mode, rowOpts, env, tp)
    result.axes.push({ id: m.target, actions: postProcess(shaped.actions, o, true) })
    result.perAxis.push({ target: m.target, source: m.source, mode: m.mode, coupled: false, stats: shaped.stats })
  }
  // keep V0 first for deterministic ordering
  result.axes.sort((a, b) => a.id.localeCompare(b.id))
  return result
}

/** Output shaping: resample a dense track to a stable action grid and smooth it.
 *  Fast sources (e.g. 15 actions/s twitch traces) otherwise produce hammering
 *  sawtooth spikes; players/devices perceive that as noise, not waves. */
function postProcess(actions: Action[], o: ConvertOptions, keepFinalZero: boolean): Action[] {
  if (actions.length === 0 || o.rawOutput) return actions
  const step = Math.max(o.minGapMs, 50) // output grid: >=50ms between actions
  const smoothMs = Math.max(o.smoothMs, 80) // output smoothing at least 80ms
  const t0 = actions[0].at
  const t1 = actions[actions.length - 1].at

  const sample = (t: number): number => {
    if (t <= actions[0].at) return actions[0].pos
    if (t >= t1) return actions[actions.length - 1].pos
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

  // moving-average smoothing over +-smoothMs/2 (sampled on the grid)
  const grid: Array<{ t: number; v: number }> = []
  for (let t = t0; t <= t1; t += step) grid.push({ t, v: sample(t) })
  const half = smoothMs / 2
  const smoothed = grid.map((g, i) => {
    let sum = 0
    let cnt = 0
    for (let j = i; j >= 0 && g.t - grid[j].t <= half; j--) {
      sum += grid[j].v
      cnt++
    }
    for (let j = i + 1; j < grid.length && grid[j].t - g.t <= half; j++) {
      sum += grid[j].v
      cnt++
    }
    return { t: g.t, v: cnt ? sum / cnt : g.v }
  })

  const out: Action[] = []
  for (const g of smoothed) {
    const at = Math.round(g.t)
    if (out.length > 0 && at - out[out.length - 1].at < o.minGapMs) continue
    out.push({ at, pos: Math.round(g.v) })
  }
  // keep/restore the trailing release stop
  const last = actions[actions.length - 1]
  if (keepFinalZero && last.pos === 0 && (out.length === 0 || out[out.length - 1].pos !== 0)) {
    out.push({ at: last.at, pos: 0 })
  }
  return out
}

function statsFor(vals: number[], envVals: number[], tp: Tempo): ConvertStats {
  const active = vals.filter((v) => v > 0)
  // corr: blend vs envelope is 1:1 by construction in the coupled path
  void envVals
  return {
    tempo: { halfStrokeMs: tp.T, fStroke: tp.fStroke },
    scale: 1,
    gate: 0,
    axes: [
      {
        id: '',
        actions: vals.length,
        activePct: vals.length ? (100 * active.length) / vals.length : 0,
        meanActive: active.length ? active.reduce((s, v) => s + v, 0) / active.length : 0,
        p99: percentile(active, 0.99),
        max: active.length ? Math.max(...active) : 0,
      },
    ],
    switchHz: 0,
    degradedPct: 0,
    saturationPct: 0,
    corr: 1,
  }
}
