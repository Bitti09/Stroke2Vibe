<script lang="ts">
  // Vacuum/suction track generator: derive an A0-class suction axis from existing traces.
  import { state as app } from '../appstate.svelte'
  import { availableSources, generateVacuum, defaultVacuumOptions } from './engine'
  import type { VacuumMode } from './engine'
  import { setAxis, serialize, download } from '../funscript'

  interface Props {
    onapplied?: () => void
  }
  let { onapplied }: Props = $props()

  let open = $state(false)
  let source = $state('L0')
  let mode = $state<VacuumMode>('stroke')
  let depth = $state(defaultVacuumOptions.depth)
  let duty = $state(defaultVacuumOptions.duty)
  let invert = $state(defaultVacuumOptions.invert)
  let basePos = $state(defaultVacuumOptions.basePos)
  let pumpPulses = $state(defaultVacuumOptions.pumpPulses)
  let pulseHz = $state(defaultVacuumOptions.pulseHz)
  let axisId = $state('A0')
  let error = $state('')

  const sources = $derived(app.script ? availableSources(app.script) : [])

  const result = $derived.by(() => {
    if (!app.script || !open) return null
    try {
      const r = generateVacuum(app.script, { mode, depth, duty, invert, basePos, pumpPulses, pulseHz }, source, axisId)
      error = ''
      return r
    } catch (e) {
      error = (e as Error).message
      return null
    }
  })

  function apply() {
    if (!app.script || !result) return
    setAxis(app.script, { id: axisId, actions: result.actions })
    if (!app.generatedAxes.includes(axisId.toLowerCase())) app.generatedAxes.push(axisId.toLowerCase())
    onapplied?.()
  }

  function downloadTrack() {
    if (!app.script || !result) return
    apply()
    const base = app.scriptName.replace(/\.funscript(\.json)?$/i, '')
    const doc = { version: app.script.version, actions: result.actions }
    download(`${base}.${axisId.toLowerCase()}.funscript`, JSON.stringify(doc))
  }

  const previewPath = $derived.by(() => {
    if (!result || result.actions.length < 2) return ''
    const t0 = result.actions[0].at
    const t1 = result.actions[result.actions.length - 1].at
    const pts = result.actions.map((a) => `${((a.at - t0) / (t1 - t0 || 1)) * 600},${78 - (a.pos / 100) * 74}`)
    return `M${pts.join('L')}`
  })
</script>

<div class="panel">
  <h2>
    Vacuum / suction track
    <button class="mini" onclick={() => (open = !open)}>{open ? 'hide' : 'generate…'}</button>
  </h2>
  {#if open}
    <p class="muted">
      Derive a suction track (A0-class: valve/suck) from an existing trace. Suction follows
      the stroke position by default — strongest when inserted, releasing towards the top.
      <strong>Pump pulses</strong>: for devices that can't hold vacuum (e.g. Svakom Sam
      Neo) — emits rhythmic on/off pump strokes instead of a held level.
    </p>
    <div class="row">
      <label>
        Source
        <select bind:value={source}>
          {#each sources as s (s.id)}
            <option value={s.id}>{s.id} ({s.actions})</option>
          {/each}
        </select>
      </label>
      <label>
        Mode
        <select bind:value={mode}>
          <option value="stroke">stroke position (default)</option>
          <option value="pulse">tempo-locked pulsing</option>
          <option value="envelope">action intensity</option>
        </select>
      </label>
      <label> Depth {(depth * 100).toFixed(0)}% <input type="range" min="0.2" max="1" step="0.05" bind:value={depth} /> </label>
      {#if mode === 'pulse'}
        <label> Duty {(duty * 100).toFixed(0)}% <input type="range" min="0.2" max="0.9" step="0.05" bind:value={duty} /> </label>
      {/if}
      <label> Base {basePos} <input type="range" min="0" max="40" step="1" bind:value={basePos} /> </label>
      <label class="check"><input type="checkbox" bind:checked={pumpPulses} /> pump pulses</label>
      {#if pumpPulses}
        <label> Rate {pulseHz.toFixed(1)} Hz <input type="range" min="0.5" max="6" step="0.1" bind:value={pulseHz} /> </label>
      {/if}
      <label class="check"><input type="checkbox" bind:checked={invert} /> invert</label>
      <label> Axis id <input style="width:70px" bind:value={axisId} /> </label>
    </div>

    {#if error}
      <p class="error">{error}</p>
    {:else if result}
      <p class="muted">
        {result.stats.actions} actions · {result.stats.activePct.toFixed(0)}% active · mean
        {result.stats.meanActive.toFixed(1)} · max {result.stats.max} · source tempo
        {result.stats.tempoHz.toFixed(2)} Hz
        {#if result.stats.pumpPulses}· pump mode {result.stats.pulseHz.toFixed(1)} Hz on/off{/if}
      </p>
      <svg viewBox="0 0 600 80" class="preview" preserveAspectRatio="none">
        <path d={previewPath} fill="none" stroke="var(--accent-2)" stroke-width="1.5" />
      </svg>
      <div class="row">
        <button class="primary" onclick={apply}>Add {axisId} to script</button>
        <button onclick={downloadTrack}>Download {axisId} track</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  h2 {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin: 0 0 0.4rem 0;
    font-size: 1.05rem;
  }
  .mini {
    font-size: 0.7rem;
    padding: 0.15rem 0.5rem;
  }
  label {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    font-size: 0.85rem;
  }
  .check {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }
  .preview {
    width: 100%;
    height: 60px;
    background: var(--panel-2);
    border-radius: var(--radius);
    margin: 0.4rem 0;
  }
  .error {
    color: var(--danger);
  }
</style>
