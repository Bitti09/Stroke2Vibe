<script lang="ts">
  // Waveform display for ALL script traces (playback axes first, then motion/generated),
  // with per-trace visibility chips, pos/speed view modes, shared zoom/seek and a live
  // playhead marker.
  import type { AxisSource } from './sync'
  import type { Action } from '../funscript'

  interface TraceInfo {
    id: string
    actions: Action[]
    /** playback axis (V0/V1) -> filled by default; motion traces -> outline by default */
    kind: 'vibe' | 'motion' | 'generated'
  }

  interface SectionInfo {
    start: number
    end: number
    profile: 'softer' | 'balanced' | 'stronger' | 'extreme'
  }

  interface Props {
    /** all available traces of the script (ordered) */
    traces: TraceInfo[]
    /** ids that drive playback (V0/V1) — filled by default and always first */
    activeIds?: string[]
    /** current playhead in ms */
    currentTimeMs: number
    durationMs: number
    /** optional section map (M2.1) drawn as background bands */
    sections?: SectionInfo[]
    onseek?: (tMs: number) => void
  }
  let { traces, activeIds = [], currentTimeMs, durationMs, sections, onseek }: Props = $props()

  const PALETTE = ['#7c5cff', '#22d3ee', '#f59e0b', '#34d399', '#f472b6', '#60a5fa', '#fb7185']

  const H = 40 // lane height px
  const GAP = 6

  type ViewMode = 'pos' | 'speed'
  interface LaneState {
    visible: boolean
    mode: ViewMode
  }
  // visibility/view state per trace id — NEVER written inside deriveds/templates:
  // stateOf is a pure read (missing entry = default), mutations happen only in handlers
  let laneState = $state<Record<string, LaneState>>({})

  function stateOf(t: TraceInfo): LaneState {
    const s = laneState[t.id]
    if (s) return s
    const isPlayback = activeIds.map((a) => a.toLowerCase()).includes(t.id.toLowerCase())
    return isPlayback ? { visible: true, mode: 'pos' } : { visible: false, mode: 'pos' }
  }
  function toggle(t: TraceInfo) {
    const s = { ...stateOf(t), visible: !stateOf(t).visible }
    laneState[t.id] = s
  }
  function solo(t: TraceInfo) {
    const on = stateOf(t).visible
    for (const tr of traces) laneState[tr.id] = { ...stateOf(tr), visible: false }
    laneState[t.id] = { ...stateOf(t), visible: !on }
  }
  function cycleMode(t: TraceInfo) {
    const s = stateOf(t)
    laneState[t.id] = { ...s, mode: s.mode === 'pos' ? 'speed' : 'pos' }
  }

  // lanes list: visible traces, playback axes first (already ordered by caller)
  let lanes = $derived(
    traces
      .filter((t) => stateOf(t).visible)
      .map((t, i) => ({ t, state: stateOf(t), color: colorOf(t) })),
  )

  function secProfileColor(p: SectionInfo['profile']): string {
    switch (p) {
      case 'softer': return '#22d3ee'
      case 'stronger': return '#f59e0b'
      case 'extreme': return '#ef4444'
      default: return '#94a3b8'
    }
  }

  function colorOf(t: TraceInfo): string {
    const idx = traces.findIndex((x) => x.id === t.id)
    return PALETTE[idx % PALETTE.length]
  }

  // ---- view window (zoom) ----
  let viewStart = $state<number | null>(null)
  let viewLen = $state<number | null>(null)
  let zoomed = $state(false)

  const t0 = $derived(
    traces.length ? Math.min(...traces.map((t) => (t.actions.length ? t.actions[0].at : Infinity))) : 0,
  )
  const t1 = $derived(
    traces.length ? Math.max(...traces.map((t) => (t.actions.length ? t.actions[t.actions.length - 1].at : 0)), 1) : 1,
  )
  const winLenMs = $derived(zoomed && viewLen !== null ? viewLen : Math.max(1, t1 - t0))
  const winStart = $derived(zoomed && viewStart !== null ? viewStart : t0)
  const winEnd = $derived(Math.min(t1, winStart + winLenMs))
  const winLen = $derived(Math.max(1, winEnd - winStart))

  const W = 1000
  const HSR = 2000 // smoothing window for speed mode (ms)

  function speedAt(actions: Action[], t: number): number {
    if (actions.length < 2) return 0
    let lo = 0
    let hi = actions.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (actions[mid].at <= t) lo = mid
      else hi = mid
    }
    const a = actions[lo]
    const b = actions[hi]
    const dt = b.at - a.at
    const dp = Math.abs(b.pos - a.pos)
    return dt > 0 ? dp / dt : 0 // pos/ms
  }

  function buildPath(actions: Action[], mode: ViewMode): string {
    if (actions.length === 0) return ''
    // speed mode: compute speed series at each action, smooth, normalize to lane
    let series = actions
    if (mode === 'speed') {
      const speeds = actions.map((a) => ({ at: a.at, pos: speedAt(actions, a.at) }))
      const sm = speeds.map((s) => {
        let sum = 0
        let cnt = 0
        for (const o of speeds) {
          if (Math.abs(o.at - s.at) <= HSR) {
            sum += o.pos
            cnt++
          }
        }
        return { at: s.at, pos: cnt ? (sum / cnt) * 1000 * 0.1 : 0 } // scale pos/s*0.1 → 0..~100
      })
      const maxV = Math.max(1, ...sm.map((s) => s.pos))
      series = sm.map((s) => ({ at: s.at, pos: (s.pos / maxV) * 100 }))
    }
    const pts: string[] = []
    for (const a of series) {
      if (a.at < winStart - 500 || a.at > winEnd + 500) continue
      const x = ((a.at - winStart) / winLen) * W
      const y = H - (a.pos / 100) * (H - 4) - 2
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`)
    }
    if (pts.length === 0) return ''
    return `M0,${H} L${pts.join('L')} L${W},${H} Z`
  }

  const lanePaths = $derived(lanes.map((l) => buildPath(l.t.actions, l.state.mode)))

  const playheadPct = $derived(
    Math.max(0, Math.min(100, ((currentTimeMs - winStart) / winLen) * 100)),
  )

  // ---- interaction: seek + wheel zoom ----
  let dragging = $state(false)
  let followCooldown = 0

  function seekFromEvent(e: MouseEvent) {
    if (!onseek) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const rel = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    followCooldown = Date.now() + 1500
    onseek(winStart + rel * winLen)
  }
  function onDown(e: MouseEvent) {
    dragging = true
    seekFromEvent(e)
  }
  function onMove(e: MouseEvent) {
    if (dragging) seekFromEvent(e)
  }
  function onUp() {
    dragging = false
  }

  function wheelZoom(lenMult: number, anchorT: number) {
    followCooldown = Date.now() + 1500
    let len = zoomed ? winLen : t1 - t0
    len *= lenMult
    len = Math.max(2000, Math.min(t1 - t0, len))
    const rel = Math.max(0, Math.min(1, (anchorT - winStart) / winLen))
    const nextZoom = len < (t1 - t0) * 0.98
    if (nextZoom) {
      viewStart = Math.max(t0, Math.min(t1 - len, anchorT - rel * len))
      viewLen = len
    }
    zoomed = nextZoom
  }
  function onWheel(e: WheelEvent) {
    e.preventDefault()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const rel = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    wheelZoom(e.deltaY > 0 ? 1.25 : 0.8, winStart + rel * winLen)
  }
  function zoomIn() {
    wheelZoom(0.7, currentTimeMs)
  }
  function zoomOut() {
    wheelZoom(1.4, currentTimeMs)
  }
  function toggleZoom() {
    followCooldown = Date.now() + 1500
    if (!zoomed) {
      viewLen = 60000
      viewStart = Math.max(t0, Math.min(t1 - viewLen, currentTimeMs - viewLen / 2))
    }
    zoomed = !zoomed
  }
  function followPlayhead() {
    followCooldown = Date.now() + 1000
    const len = viewLen ?? 60000
    viewStart = Math.max(t0, Math.min(Math.max(t0, t1 - len), currentTimeMs - len / 2))
  }

  // auto-follow while zoomed
  $effect(() => {
    if (!zoomed || dragging) return
    if (Date.now() < followCooldown) return
    if (currentTimeMs < winStart || currentTimeMs > winEnd) followPlayhead()
  })
</script>

<div class="wave" role="img" aria-label="trace waveforms">
  <div class="chips">
    {#each traces as t (t.id)}
      {@const s = stateOf(t)}
      <button
        class="chip"
        class:on={s.visible}
        style="--c:{colorOf(t)}"
        onclick={() => toggle(t)}
        ondblclick={() => solo(t)}
        oncontextmenu={(e) => {
          e.preventDefault()
          cycleMode(t)
        }}
        title="{t.id} — click: toggle, double-click: solo, right-click: pos/speed ({s.mode})"
      >
        {t.id}
        {#if s.mode === 'speed'}<span class="m">v</span>{/if}
      </button>
    {/each}
  </div>

  <div
    class="lanes"
    role="slider"
    tabindex="0"
    aria-label="trace seek"
    aria-valuenow={Math.round(currentTimeMs)}
    aria-valuemin={0}
    aria-valuemax={durationMs}
    onmousedown={onDown}
    onmousemove={onMove}
    onmouseup={onUp}
    onmouseleave={onUp}
    onwheel={onWheel}
    onkeydown={(e) => {
      if (!onseek) return
      if (e.key === 'ArrowLeft') onseek(Math.max(0, currentTimeMs - 1000))
      if (e.key === 'ArrowRight') onseek(currentTimeMs + 1000)
    }}
  >
    {#each lanes as l, i (l.t.id)}
      <div class="lane" style="height:{H}px; margin-bottom:{GAP}px">
        {#if sections && sections.length > 0}
          <div class="sections" aria-hidden="true">
            {#each sections as sec}
              <span
                class="sec"
                style="left:{Math.max(0, ((sec.start - winStart) / winLen) * 100)}%;
                       width:{Math.max(0, Math.min(100, ((Math.min(sec.end, winEnd) - Math.max(sec.start, winStart)) / winLen) * 100))}%;
                       --sec:{secProfileColor(sec.profile)}"
                title="{sec.profile} ({(sec.start / 1000).toFixed(0)}–{(sec.end / 1000).toFixed(0)}s)"
              ></span>
            {/each}
          </div>
        {/if}
        <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none">
          <path
            d={lanePaths[i] ?? ''}
            fill={l.color}
            opacity={l.t.kind === 'vibe' ? 0.75 : l.state.mode === 'speed' ? 0.5 : 0.28}
            fill-rule="evenodd"
            stroke={l.t.kind !== 'vibe' && l.state.mode === 'pos' ? l.color : 'none'}
            stroke-width="1"
          />
        </svg>
        <span class="id" style="color:{l.color}">{l.t.id}{l.state.mode === 'speed' ? ' (v)' : ''}</span>
      </div>
    {/each}
    {#if lanes.length === 0}
      <div class="empty muted">no traces visible — click a chip above</div>
    {/if}
    <div class="playhead" style="left:{playheadPct}%"></div>
  </div>

  <div class="tools">
    <span class="muted">{(winStart / 1000).toFixed(0)}s – {(winEnd / 1000).toFixed(0)}s</span>
    {#if onseek}
      <span class="muted">click/drag = seek · wheel = zoom</span>
    {/if}
    <button class="mini" onclick={zoomOut}>−</button>
    <button class="mini" onclick={toggleZoom}>{zoomed ? `${(winLenMs / 1000).toFixed(0)}s` : 'zoom'}</button>
    <button class="mini" onclick={zoomIn}>+</button>
    {#if zoomed}
      <button class="mini" onclick={followPlayhead}>follow</button>
    {/if}
  </div>
</div>

<style>
  .wave {
    margin-top: 0.5rem;
  }
  .chips {
    display: flex;
    gap: 0.3rem;
    flex-wrap: wrap;
    margin-bottom: 0.4rem;
  }
  .chip {
    font-size: 0.68rem;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    border: 1px solid #34344a;
    background: var(--panel-2);
    color: var(--muted);
    opacity: 0.6;
  }
  .chip.on {
    opacity: 1;
    border-color: var(--c);
    color: var(--c);
    font-weight: 700;
  }
  .chip .m {
    font-size: 0.6rem;
    margin-left: 0.2rem;
  }
  .lanes {
    position: relative;
    background: var(--panel-2, #1b1b26);
    border-radius: var(--radius);
    padding: 6px 4px 2px 4px;
    cursor: crosshair;
    user-select: none;
  }
  .lane {
    position: relative;
    width: 100%;
    overflow: hidden;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.25);
  }
  .sections {
    position: absolute;
    inset: 0;
    display: flex;
    pointer-events: none;
  }
  .sec {
    position: absolute;
    top: 0;
    bottom: 0;
    background: var(--sec);
    opacity: 0.12;
  }
  .lane svg {
    width: 100%;
    height: 100%;
    display: block;
  }
  .lane .id {
    position: absolute;
    top: 2px;
    left: 6px;
    font-size: 0.68rem;
    font-weight: 700;
    opacity: 0.9;
    pointer-events: none;
  }
  .empty {
    padding: 1rem;
    text-align: center;
    font-size: 0.8rem;
  }
  .playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: white;
    box-shadow: 0 0 6px rgba(255, 255, 255, 0.8);
    pointer-events: none;
  }
  .tools {
    display: flex;
    gap: 0.8rem;
    align-items: center;
    margin-top: 0.3rem;
    font-size: 0.75rem;
  }
  .mini {
    font-size: 0.7rem;
    padding: 0.12rem 0.5rem;
  }
</style>
