<script lang="ts">
  import { onMount } from 'svelte'
  import VideoPanel from './lib/player/VideoPanel.svelte'
  import ScriptPanel from './lib/player/ScriptPanel.svelte'
  import ConvertPanel from './lib/convert/ConvertPanel.svelte'
  import IntifacePanel from './lib/intiface/IntifacePanel.svelte'
  import MappingPanel from './lib/convert/MappingPanel.svelte'
  import VacuumPanel from './lib/convert/VacuumPanel.svelte'
  import QualityPanel from './lib/convert/QualityPanel.svelte'
  import { state as app } from './lib/appstate.svelte'

  let intiface: { registerVideo: (el: HTMLVideoElement) => void; restart: () => void } | null = $state(null)

  const hasVibes = $derived(
    app.script ? app.script.axes.some((a) => a.id.toLowerCase() === 'v0' || a.id.toLowerCase() === 'v1') : false,
  )
</script>

<main>
  <header>
    <h1>Stroke2Vibe <span class="muted">web</span></h1>
    <p class="muted">
      Local video + funscript player with on-the-fly L0 → V0/V1 conversion. Everything stays in
      your browser; device control goes straight to Intiface Central. 18+ only.
    </p>
  </header>

  <div class="grid">
    <div class="col wide">
      <VideoPanel onvideoref={(el: HTMLVideoElement) => intiface?.registerVideo(el)} />
      <ScriptPanel onapplied={() => intiface?.restart()} />
      {#if app.script}
        <MappingPanel onapplied={() => intiface?.restart()} />
        <VacuumPanel onapplied={() => intiface?.restart()} />
        <QualityPanel />
        {#if !app.converted && !hasVibes}
          <ConvertPanel />
        {/if}
      {/if}
    </div>
    <div class="col side">
      <IntifacePanel bind:this={intiface} />
    </div>
  </div>
</main>

<style>
  main {
    max-width: 1200px;
    margin: 0 auto;
    padding: 1rem;
  }
  header h1 {
    margin: 0 0 0.25rem 0;
    font-size: 1.5rem;
  }
  .grid {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr);
    gap: 1rem;
    margin-top: 1rem;
  }
  .col {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-width: 0;
  }
  @media (max-width: 900px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
</style>
