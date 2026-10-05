<script lang="ts">
  import { state as app } from '../appstate.svelte'
  import { parseFunscript, hasAxis, setAxes } from '../funscript'
  import { convertMapped, availableSources, defaultOptions } from '../convert/engine'

  interface Props {
    onapplied?: () => void
  }
  let { onapplied }: Props = $props()

  let fileInput = $state<HTMLInputElement | undefined>()
  let error = $state('')

  function load(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        error = ''
        const fs = parseFunscript(String(reader.result))
        // auto-convert on the fly when the script has no vibe axes
        if (!hasAxis(fs, 'V0') && !hasAxis(fs, 'V1')) {
          // best motion source: L0 if it has actions, else the largest non-vibe
          // axis (multi-axis files can have an empty top-level L0)
          const sources = availableSources(fs)
          const motion = sources.filter((s) => s.actions > 0 && !s.vibeLike)
          const source = motion.find((s) => s.id === 'L0')?.id ?? motion.sort((a, b) => b.actions - a.actions)[0]?.id
          if (!source) throw new Error('script has no usable motion axis to convert')
          const result = convertMapped(fs, {
            ...defaultOptions,
            autoProfile: 'balanced',
            mappings: [
              { source, target: 'V0', mode: 'auto' },
              { source, target: 'V1', mode: 'auto' },
            ],
          })
          setAxes(fs, result.axes)
          app.generatedAxes = result.axes.map((a) => a.id.toLowerCase())
          app.converted = true
        } else {
          app.converted = false
        }
        app.script = fs
        app.scriptName = file.name
        onapplied?.()
      } catch (e) {
        error = (e as Error).message
        app.script = null
        app.generatedAxes = []
        app.converted = false
      }
    }
    reader.readAsText(file)
  }

  const actionCount = $derived(app.script?.actions.length ?? 0)
  const axisList = $derived((app.script?.axes ?? []).map((a) => `${a.id} (${a.actions.length})`).join(', '))
  const vibes = $derived(app.script ? hasAxis(app.script, 'V0') || hasAxis(app.script, 'V1') : false)
</script>

<div class="panel">
  <h2>Funscript</h2>
  <div class="row">
    <button class="primary" onclick={() => fileInput?.click()}>Load funscript…</button>
    <input
      hidden
      type="file"
      accept=".funscript,.json,application/json"
      bind:this={fileInput}
      onchange={(e) => {
        const f = (e.target as HTMLInputElement).files?.[0]
        if (f) load(f)
      }}
    />
    {#if app.script}
      <button
          onclick={() => {
            app.script = null
            app.generatedAxes = []
            app.converted = false
          }}>Clear</button>
    {/if}
  </div>
  {#if error}
    <p class="error">{error}</p>
  {:else if app.script}
    <p class="muted">
      {app.scriptName} — {actionCount} L0 actions, version {app.script.version}
      {#if axisList}, axes: {axisList}{/if}
    </p>
    {#if vibes}
      <p class="ok">✓ V0/V1 present{app.converted ? ' (converted on the fly from L0)' : ''} — dual-motor playback active</p>
    {:else}
      <p class="muted">No V0/V1 axes and conversion unavailable for this script.</p>
    {/if}
  {:else}
    <p class="muted">No script loaded. Same basename as the video is the usual convention.</p>
  {/if}
</div>

<style>
  .error {
    color: var(--danger);
  }
  .ok {
    color: var(--ok);
  }
</style>
