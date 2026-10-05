<script lang="ts">
  // Per-trace remapping: connect ANY existing axis (L0, l2, r0, v0, ...) to vibe
  // targets V0/V1 and choose the conversion mode per trace.
  import { state as app, options } from '../appstate.svelte'
  import { convertMapped, availableSources, defaultOptions, deriveAutoProfile, detectSections } from './engine'
  import { dedupe } from '../funscript'
  import type { AxisMapping, Mode, ConvertOptions } from './engine'

  type AutoProfileName = NonNullable<ConvertOptions['autoProfile']>
  import { setAxes, serialize, download } from '../funscript'

  interface Props {
    /** called when playback axes changed (apply/download) so the player re-reads them */
    onapplied?: () => void
  }
  let { onapplied }: Props = $props()

  const MODES: Array<{ id: Mode; label: string }> = [
    { id: 'auto', label: 'auto' },
    { id: 'travel', label: 'travel (wave)' },
    { id: 'alternate', label: 'alternate (pulse)' },
    { id: 'layer', label: 'layer (breathing)' },
    { id: 'surge', label: 'surge (full)' },
  ]

  // rows: two target slots (V0, V1), each with source + mode; empty source = unmapped
  let rows = $state<Array<{ target: string; source: string; mode: Mode }>>([
    { target: 'V0', source: 'L0', mode: 'auto' },
    { target: 'V1', source: 'L0', mode: 'auto' },
  ])
  // auto wave profile: derives all shaping from the source, sliders act as overrides
  let autoProfile = $state<AutoProfileName | ''>('balanced')
  // envelope shaping overrides (undefined = let auto decide)
  let gamma = $state<number | undefined>(undefined)
  let floorVal = $state<number | undefined>(undefined)
  let gateP = $state<number | undefined>(undefined)
  let smoothMs = $state<number | undefined>(undefined)
  let target = $state<number | undefined>(undefined)
  let baseline = $state<number | undefined>(undefined)
  let ripple = $state<number | undefined>(undefined)
  let duty = $state<number | undefined>(undefined)
  let layerDepth = $state<number | undefined>(undefined)
  let layerRatio = $state<number | undefined>(undefined)
  let minGapMs = $state<number | undefined>(undefined)
  let accent = $state<number | undefined>(undefined)
  let kick = $state<number | undefined>(undefined)
  let floorRampMs = $state<number | undefined>(undefined)
  let sections = $state<boolean | undefined>(undefined)
  let manual = $state(false)
  // context visibility: show only knob groups that affect the chosen modes
  const modesUsed = $derived.by(() => {
    const m = new Set<string>()
    for (const r of rows) if (r.source !== '') m.add(r.mode)
    return m
  })
  // macro: overall strength — moves target/baseline/ripple proportionally; 0 = neutral
  let strength = $state<number | null>(null)
  const STRENGTH_TARGET = 85
  const applyStrength = (v: number) => {
    strength = v
    const f = v // -1..+1
    target = Math.max(40, Math.min(95, Math.round(STRENGTH_TARGET + f * 25)))
    // baseline: balanced 22% -> softer(quieter) more baseline, extreme less
    baseline = Math.max(0, Math.min(60, 22 - f * 18)) / 1
    // normalize to 0..0.6 fraction
    baseline = Math.max(0, Math.min(0.6, baseline))
    ripple = Math.max(0, Math.min(0.9, 0.25 + f * 0.25))
  }
  const strengthActive = $derived(strength !== null)


  function resetKnobs() {
    gamma = undefined
    floorVal = undefined
    gateP = undefined
    smoothMs = undefined
    target = undefined
    baseline = undefined
    ripple = undefined
    duty = undefined
    layerDepth = undefined
    layerRatio = undefined
    minGapMs = undefined
    accent = undefined
    kick = undefined
    floorRampMs = undefined
    sections = undefined
  }

  const sources = $derived(app.script ? availableSources(app.script) : [])
  const coupled = $derived(
    rows.length === 2 &&
      rows[0].source !== '' &&
      rows[0].source === rows[1].source &&
      rows[0].mode === rows[1].mode,
  )

  const showSplitKnobs = $derived(
    modesUsed.has('alternate') || (modesUsed.has('auto') && !coupled) ||
      (modesUsed.has('auto') && coupled),
  )
  const showLayerKnobs = $derived(modesUsed.has('layer') || modesUsed.has('auto'))
  const showStrokeKnobs = $derived(modesUsed.has('travel') || modesUsed.has('auto') || modesUsed.has('layer') || modesUsed.has('surge'))

  let stats = $state<ReturnType<typeof convertMapped> | null>(null)
  let error = $state('')

  // derived shaping values for the active auto profile (read-only display when 'auto')
  const derivedShaping = $derived.by(() => {
    if (!app.script || mappings.length === 0) return null
    const firstSource = mappings[0].source
    const src = (() => {
      try {
        if (firstSource === 'L0') return dedupe(app.script.actions)
        const ax = app.script.axes.find((a) => a.id.toLowerCase() === firstSource.toLowerCase())
        return ax ? dedupe(ax.actions) : null
      } catch {
        return null
      }
    })()
    if (!src || src.length < 2) return null
    return deriveAutoProfile(src, (autoProfile || 'balanced') as 'balanced' | 'softer' | 'stronger' | 'extreme', {}).shaping
  })

  const mappings = $derived.by(() =>
    rows
      .filter((r) => r.source !== '')
      .map((r) => ({ source: r.source, target: r.target, mode: r.mode })),
  )

  const preview = $derived.by(() => {
    if (!app.script || mappings.length === 0) return null
    try {
      const overrides: Partial<ConvertOptions> = {}
      if (gamma !== undefined) overrides.gamma = gamma
      if (floorVal !== undefined) overrides.floorVal = floorVal
      if (gateP !== undefined) overrides.gateP = gateP
      if (smoothMs !== undefined) overrides.smoothMs = smoothMs
      if (target !== undefined) overrides.target = target
      if (duty !== undefined) overrides.duty = duty
      if (layerDepth !== undefined) overrides.depth = layerDepth
      if (layerRatio !== undefined) overrides.layerRatio = layerRatio
      if (minGapMs !== undefined) overrides.minGapMs = minGapMs
      if (baseline !== undefined) overrides.baselineKnob = baseline
      if (ripple !== undefined) overrides.rippleKnob = ripple
      if (accent !== undefined) overrides.accent = accent
      if (kick !== undefined) overrides.kick = kick
      if (floorRampMs !== undefined) overrides.floorRampMs = floorRampMs
      if (sections !== undefined) overrides.sections = sections
      return convertMapped(app.script, {
        ...defaultOptions,
        mappings,
        autoProfile: (autoProfile || 'balanced') as 'balanced' | 'softer' | 'stronger' | 'extreme',
        ...overrides,
      })
    } catch {
      return null
    }
  })

  let lastAppliedSig = ''

  $effect(() => {
    if (preview) {
      stats = preview
      error = ''
      // auto-apply: the conversion result goes straight into the script & playback
      const sig = JSON.stringify([mappings, autoProfile, gamma, floorVal, gateP, smoothMs, target, baseline, ripple, duty, layerDepth, layerRatio, minGapMs, accent, kick, floorRampMs, sections])
      if (lastAppliedSig !== sig) {
        lastAppliedSig = sig
        setAxes(app.script!, preview.axes)
        app.generatedAxes = preview.axes.map((a) => a.id.toLowerCase())
        app.converted = true
        // M2.1: expose section map for the waveform overlay (when enabled)
        options.sections = options.sectionsEnabled ? detectSections(dedupe(app.script!.actions)) : []
        onapplied?.()
      }
    } else if (app.script && mappings.length > 0) {
      error = 'mapping produced no result (check sources)'
    }
  })

  function swap() {
    rows = [rows[1], rows[0]]
  }

  function apply() {
    if (!app.script || !preview) return
    setAxes(app.script, preview.axes)
    app.generatedAxes = preview.axes.map((a) => a.id.toLowerCase())
    app.converted = true
    onapplied?.()
  }

  function exportMulti() {
    if (!app.script || !preview) return
    apply()
    download(app.scriptName.replace(/\.funscript(\.json)?$/i, '') + '.vibe.funscript', serialize(app.script))
  }

  function srcLabel(id: string): string {
    const s = sources.find((x) => x.id.toLowerCase() === id.toLowerCase())
    return s ? `${s.id} (${s.actions}${s.vibeLike ? ', vibe-like' : ''})` : id
  }
</script>

<div class="panel">
  <h2>Trace mapping → V0 / V1</h2>
  <p class="muted">
    Connect any existing trace to a vibe axis and pick its conversion mode. Same source +
    same mode on both rows = coupled energy-preserving split. Different sources = each
    target runs independently from its own trace.
  </p>

  <div class="rows">
    {#each rows as row, i (row.target)}
      <div class="maprow">
        <span class="target">{row.target}</span>
        <span class="arrow">←</span>
        <select
          value={row.source}
          onchange={(e) => {
            rows[i].source = (e.currentTarget as HTMLSelectElement).value
            rows = [...rows]
          }}
        >
          <option value="">— unmapped —</option>
          {#each sources as s (s.id)}
            <option value={s.id}>{srcLabel(s.id)}</option>
          {/each}
        </select>
        <select
          value={row.mode}
          disabled={row.source === ''}
          onchange={(e) => {
            rows[i].mode = (e.currentTarget as HTMLSelectElement).value as Mode
            rows = [...rows]
          }}
        >
          {#each MODES as m (m.id)}
            <option value={m.id}>{m.label}</option>
          {/each}
        </select>
        {#if i === 0}
          <button title="swap V0/V1" onclick={swap}>⇅</button>
        {/if}
      </div>
    {/each}
  </div>

  {#if coupled}
    <p class="info">Coupled pair: one source, energy-preserving split (w0 + w1 = 1).</p>
  {:else}
    <p class="info">Independent rows: each target is shaped from its own trace.</p>
  {/if}

  <div class="row shaping-head">
    <label>
      Auto wave
      <select bind:value={autoProfile} onchange={resetKnobs}>
        <option value="balanced">balanced (default)</option>
        <option value="softer">softer — gentle glide</option>
        <option value="stronger">stronger — fuller waves</option>
        <option value="extreme">extreme — max punch</option>
      </select>
    </label>
    <button class="mini" onclick={() => (manual = !manual)}>{manual ? 'switch to auto drive' : 'switch to manual'}</button>
    <button class="mini" onclick={() => applyStrength(0)}>neutralize strength</button>
    {#if manual}
      <button class="mini" onclick={resetKnobs}>reset to auto</button>
    {/if}
  </div>

  {#if !manual}
    <div class="row shaping">
      <label>
        Strength {strength === null ? 'auto' : (strength > 0 ? '+' : '') + Math.round(strength * 100) + '%'}
        <input type="range" min="-1" max="1" step="0.05" value={strength ?? 0} oninput={(e) => applyStrength((e.currentTarget as HTMLInputElement).valueAsNumber)} />
      </label>
      <label>
        Target {target ?? (derivedShaping ? derivedShaping.target : 85)}
        <input type="range" min="50" max="95" step="1" value={target ?? 85} oninput={(e) => (target = (e.currentTarget as HTMLInputElement).valueAsNumber)} />
      </label>
      <label>
        Gamma {gamma !== undefined ? gamma.toFixed(2) : derivedShaping ? derivedShaping.gamma.toFixed(2) : '0.65'}
        <input type="range" min="0.4" max="1" step="0.05" value={gamma ?? 0.65} oninput={(e) => (gamma = (e.currentTarget as HTMLInputElement).valueAsNumber)} />
      </label>
      <label>
        Gate {gateP ?? (derivedShaping ? `${Math.round(derivedShaping.gateP * 100)}%` : '15%')}
        <input type="range" min="0.05" max="0.35" step="0.01" value={gateP ?? 0.15} oninput={(e) => (gateP = (e.currentTarget as HTMLInputElement).valueAsNumber)} />
      </label>
      <label>
        Smooth {smoothMs ?? (derivedShaping ? `${derivedShaping.smoothMs} ms` : '80 ms')}
        <input type="range" min="0" max="250" step="10" value={smoothMs ?? 80} oninput={(e) => (smoothMs = (e.currentTarget as HTMLInputElement).valueAsNumber)} />
      </label>
      <label>
        Floor {floorVal ?? (derivedShaping ? derivedShaping.floorVal : 12)}
        <input type="range" min="0" max="25" step="1" value={floorVal ?? 12} oninput={(e) => (floorVal = (e.currentTarget as HTMLInputElement).valueAsNumber)} />
      </label>
    </div>
    <p class="info">Auto drive: values derived from the trace (shown live). Touch a slider to pin it — switch profile to reset all.</p>
  {:else}
    <label class="row shaping" style="align-items:center">
      Strength {strength === null ? 'neutral' : (strength > 0 ? '+' : '') + Math.round(strength * 100) + '%'}
      <input type="range" min="-1" max="1" step="0.05" value={strength ?? 0} oninput={(e) => applyStrength((e.currentTarget as HTMLInputElement).valueAsNumber)} />
      <button class="mini" onclick={() => { strength = null; resetKnobs() }}>reset</button>
    </label>

    <details open>
      <summary>Wave shape</summary>
      <div class="knobs">
        <label> Target {target ?? (derivedShaping ? derivedShaping.target : 85)} <input type="range" min="40" max="95" step="1" value={target ?? 85} oninput={(e) => (target = (e.currentTarget as HTMLInputElement).valueAsNumber)} /> </label>
        <label> Gamma {gamma ?? (derivedShaping ? derivedShaping.gamma.toFixed(2) : '0.65')} <input type="range" min="0.3" max="1" step="0.05" value={gamma ?? 0.65} oninput={(e) => (gamma = (e.currentTarget as HTMLInputElement).valueAsNumber)} /> </label>
        <label> Baseline {baseline ?? (derivedShaping ? Math.round(derivedShaping.baseline * 100) : 22)}% <input type="range" min="0" max="60" step="1" value={(baseline ?? (derivedShaping ? derivedShaping.baseline * 100 : 22))} oninput={(e) => (baseline = (e.currentTarget as HTMLInputElement).valueAsNumber / 100)} /> </label>
        <label> Ripple {ripple ?? (derivedShaping ? Math.round(derivedShaping.ripple * 100) : 25)}% <input type="range" min="0" max="90" step="5" value={(ripple ?? (derivedShaping ? derivedShaping.ripple * 100 : 25))} oninput={(e) => (ripple = (e.currentTarget as HTMLInputElement).valueAsNumber / 100)} /> </label>
      </div>
    </details>

    <details open>
      <summary>Noise &amp; timing</summary>
      <div class="knobs">
        <label> Gate {gateP ?? (derivedShaping ? Math.round(derivedShaping.gateP * 100) + '%' : '15%')} <input type="range" min="0" max="0.4" step="0.01" value={gateP ?? 0.15} oninput={(e) => (gateP = (e.currentTarget as HTMLInputElement).valueAsNumber)} /> </label>
        <label> Smooth {smoothMs ?? (derivedShaping ? derivedShaping.smoothMs : 80)} ms <input type="range" min="0" max="500" step="10" value={smoothMs ?? 80} oninput={(e) => (smoothMs = (e.currentTarget as HTMLInputElement).valueAsNumber)} /> </label>
        <label> Floor {floorVal ?? (derivedShaping ? derivedShaping.floorVal : 12)} <input type="range" min="0" max="30" step="1" value={floorVal ?? 12} oninput={(e) => (floorVal = (e.currentTarget as HTMLInputElement).valueAsNumber)} /> </label>
        <label> Floor ramp {floorRampMs ?? 0} ms <input type="range" min="0" max="150" step="10" value={floorRampMs ?? 0} oninput={(e) => (floorRampMs = (e.currentTarget as HTMLInputElement).valueAsNumber)} /> </label>
        <label> Min gap {minGapMs ?? 40} ms <input type="range" min="20" max="200" step="5" value={minGapMs ?? 40} oninput={(e) => (minGapMs = (e.currentTarget as HTMLInputElement).valueAsNumber)} /> </label>
      </div>
    </details>

    {#if showSplitKnobs || showLayerKnobs || showStrokeKnobs}
      <details>
        <summary>Mode specifics</summary>
        <div class="knobs">
          {#if showSplitKnobs}
            <label> Duty (alternate) {duty ?? (derivedShaping ? Math.round(derivedShaping.duty * 100) : 70)}% <input type="range" min="0.5" max="0.95" step="0.01" value={duty ?? 0.7} oninput={(e) => (duty = (e.currentTarget as HTMLInputElement).valueAsNumber)} /> </label>
          {/if}
          {#if showLayerKnobs}
            <label> Layer depth {layerDepth ?? (derivedShaping ? derivedShaping.layerDepth.toFixed(2) : '0.35')} <input type="range" min="0.05" max="0.9" step="0.05" value={layerDepth ?? 0.35} oninput={(e) => (layerDepth = (e.currentTarget as HTMLInputElement).valueAsNumber)} /> </label>
            <label> Layer rate {layerRatio ?? (derivedShaping ? derivedShaping.layerRatio.toFixed(2) : '0.5')}× <input type="range" min="0.1" max="2" step="0.05" value={layerRatio ?? 0.5} oninput={(e) => (layerRatio = (e.currentTarget as HTMLInputElement).valueAsNumber)} /> </label>
          {/if}
          {#if showStrokeKnobs}
            <label> Stroke accent {accent ?? (derivedShaping ? Math.round(derivedShaping.accent * 100) : 0)}% <input type="range" min="0" max="30" step="1" value={(accent ?? (derivedShaping ? derivedShaping.accent * 100 : 0))} oninput={(e) => (accent = (e.currentTarget as HTMLInputElement).valueAsNumber / 100)} /> </label>
            <label> Reversal kick {kick ?? (derivedShaping ? derivedShaping.kick.toFixed(1) : '0.0')} <input type="range" min="0" max="1.5" step="0.1" value={kick ?? 0} oninput={(e) => (kick = (e.currentTarget as HTMLInputElement).valueAsNumber)} /> </label>
          {/if}
          <label class="check">
            Sections
            <input
              type="checkbox"
              checked={sections ?? false}
              onchange={(e) => {
                sections = (e.currentTarget as HTMLInputElement).checked
                options.sectionsEnabled = sections
              }}
            />
          </label>
        </div>
      </details>
    {/if}
    <p class="info">Manual mode: values shown are the active ones (auto-derived until you touch them). Irrelevant groups are hidden by the current mode selection.</p>
  {/if}

  {#if error}
    <p class="error">{error}</p>
  {:else if stats}
    <table>
      <thead>
        <tr><th>Target</th><th>Source</th><th>Mode</th><th>Actions</th><th>Active</th><th>Mean</th><th>Max</th></tr>
      </thead>
      <tbody>
        {#each stats.perAxis as pa (pa.target)}
          <tr>
            <td>{pa.target}</td>
            <td>{pa.source}</td>
            <td>{pa.mode}</td>
            <td>{pa.stats.axes[0].actions}</td>
            <td>{pa.stats.axes[0].activePct.toFixed(0)}%</td>
            <td>{pa.stats.axes[0].meanActive.toFixed(1)}</td>
            <td>{pa.stats.axes[0].max.toFixed(1)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  <div class="row">
    <button class="muted" disabled={!preview} onclick={apply}>Re-apply manually</button>
    <button disabled={!preview} onclick={exportMulti}>Download converted script</button>
  </div>
</div>

<style>
  .rows {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin: 0.6rem 0;
  }
  .maprow {
    display: grid;
    grid-template-columns: 34px 20px 1fr 1fr 34px;
    gap: 0.4rem;
    align-items: center;
  }
  .target {
    font-weight: 600;
    color: var(--accent-2);
  }
  .arrow {
    color: var(--muted);
  }
  .info {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .shaping {
    margin: 0.5rem 0;
  }
  .shaping-head {
    margin: 0.4rem 0;
  }
  .knobs {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 0.4rem 0.9rem;
    margin: 0.5rem 0;
  }
  .knobs label {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    font-size: 0.8rem;
  }
  .mini {
    font-size: 0.7rem;
    padding: 0.15rem 0.5rem;
  }
  .shaping label {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    font-size: 0.85rem;
  }
  .error {
    color: var(--danger);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
    margin: 0.5rem 0;
  }
  th,
  td {
    text-align: left;
    padding: 0.25rem 0.5rem;
    border-bottom: 1px solid #2b2b3d;
  }
</style>
