<script lang="ts">
  import { state as app } from '../appstate.svelte'
  import { convertScript, defaultOptions } from './engine'
  import type { Mode } from './engine'
  import { setAxes, serialize, download } from '../funscript'

  let open = $state(true)
  let mode = $state<Mode>('auto')
  let gamma = $state(defaultOptions.gamma)
  let floorVal = $state(defaultOptions.floorVal)
  let duty = $state(defaultOptions.duty)
  let travelFromTop = $state(false)
  let stats = $state<ReturnType<typeof convertScript>['stats'] | null>(null)
  let error = $state('')

  const envelopePath = $derived.by(() => {
    if (!preview || preview.envelope.length < 2) return ''
    const [t0, t1] = [preview.envelope[0][0], preview.envelope[preview.envelope.length - 1][0]]
    const pts = preview.envelope.map(([t, e]) => `${((t - t0) / (t1 - t0 || 1)) * 600},${80 - (e / 100) * 78}`)
    return `M${pts.join('L')}`
  })

  const preview = $derived.by(() => {
    if (!app.script) return null
    try {
      return convertScript(app.script, {
        mode,
        gamma,
        floorVal,
        duty,
        travelFromTop,
      })
    } catch {
      return null
    }
  })

  $effect(() => {
    if (preview) {
      stats = preview.stats
      error = ''
    } else if (app.script) {
      error = 'conversion failed for this script'
    }
  })

  function apply() {
    if (!app.script || !preview) return
    setAxes(app.script, preview.axes)
    app.generatedAxes = preview.axes.map((a) => a.id.toLowerCase())
    app.converted = true
  }

  function exportMulti() {
    if (!app.script) return
    apply()
    download(app.scriptName.replace(/\.funscript(\.json)?$/i, '') + '.vibe.funscript', serialize(app.script))
  }
</script>

<div class="panel">
  <h2>Convert to V0/V1</h2>
  <p class="muted">This script has no vibration axes. Generate a coherent dual-motor vibe script from the L0 stroke data.</p>

  <div class="row">
    <label>
      Mode
      <select bind:value={mode}>
        <option value="auto">auto (recommended)</option>
        <option value="travel">travel — wave with the stroke</option>
        <option value="alternate">alternate — tempo-locked ping-pong</option>
        <option value="layer">layer — rolling warmth</option>
        <option value="surge">surge — both full (+echo)</option>
      </select>
    </label>
    <label> Gamma {gamma.toFixed(2)} <input type="range" min="0.4" max="1" step="0.05" bind:value={gamma} /> </label>
    <label> Floor {floorVal} <input type="range" min="0" max="25" step="1" bind:value={floorVal} /> </label>
    {#if mode === 'alternate' || mode === 'auto'}
      <label> Duty {(duty * 100).toFixed(0)}% <input type="range" min="0.5" max="0.95" step="0.05" bind:value={duty} /> </label>
    {/if}
    <label class="check"><input type="checkbox" bind:checked={travelFromTop} /> wave from top</label>
  </div>

  {#if error}
    <p class="error">{error}</p>
  {:else if preview && stats}
    <table>
      <thead>
        <tr><th>Axis</th><th>Actions</th><th>Active</th><th>Mean</th><th>p99</th><th>Max</th></tr>
      </thead>
      <tbody>
        {#each stats.axes as ax}
          <tr>
            <td>{ax.id}</td>
            <td>{ax.actions}</td>
            <td>{ax.activePct.toFixed(0)}%</td>
            <td>{ax.meanActive.toFixed(1)}</td>
            <td>{ax.p99.toFixed(1)}</td>
            <td>{ax.max.toFixed(1)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p class="muted">
      tempo {(1000 / (2 * stats.tempo.halfStrokeMs)).toFixed(2)} strokes/s · sync corr {stats.corr.toFixed(3)}
      {#if stats.degradedPct > 0}· spatial patterns degrade {stats.degradedPct.toFixed(0)}% of the time{/if}
      {#if mode === 'surge'}· saturation {stats.saturationPct.toFixed(0)}%{/if}
    </p>
    <svg viewBox="0 0 600 80" class="preview" preserveAspectRatio="none">
      <path d={envelopePath} fill="none" stroke="var(--accent-2)" stroke-width="1.5" />
    </svg>
  {/if}

  <div class="row">
    <button class="primary" onclick={apply}>Use V0/V1 for playback</button>
    <button onclick={exportMulti}>Download converted script</button>
    {#if open}
      <button class="muted" onclick={() => (open = false)}>hide details</button>
    {/if}
  </div>
</div>

<style>
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
    margin-top: 0.5rem;
  }
  th,
  td {
    text-align: left;
    padding: 0.25rem 0.5rem;
    border-bottom: 1px solid #2b2b3d;
  }
  .preview {
    width: 100%;
    height: 60px;
    background: var(--panel-2);
    border-radius: var(--radius);
  }
  .check {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }
  .error {
    color: var(--danger);
  }
</style>
