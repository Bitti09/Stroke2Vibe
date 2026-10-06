<script lang="ts">
  import { state as app, options } from '../appstate.svelte'
  import { playbackSources, allTraces } from './sync'
  import Waveform from './Waveform.svelte'

  interface Props {
    onvideoref?: (el: HTMLVideoElement) => void
  }
  let { onvideoref }: Props = $props()

  let videoEl = $state<HTMLVideoElement | undefined>(undefined)
  let fileInput = $state<HTMLInputElement | undefined>()
  let dragOver = $state(false)
  // media state mirrors: HTMLMediaElement.currentTime is NOT reactive — these are
  // updated by a rAF loop (playing) plus events (seek/pause/metadata) so all
  // derived UI (waveform playhead, ruler, heatmap) tracks the video smoothly.
  let currentTimeMs = $state(0)
  let durationMs = $state(0)
  let playing = $state(false)

  const duration = $derived(durationMs / 1000)
  const currentTime = $derived(currentTimeMs / 1000)

  $effect(() => {
    const v = videoEl
    if (!v) return
    const sync = () => {
      currentTimeMs = v.currentTime * 1000
      durationMs = Number.isFinite(v.duration) ? v.duration * 1000 : 0
      playing = !v.paused && !v.ended
    }
    sync()
    v.addEventListener('loadedmetadata', sync)
    v.addEventListener('play', sync)
    v.addEventListener('pause', sync)
    v.addEventListener('seeked', sync)
    v.addEventListener('ended', sync)
    v.addEventListener('timeupdate', sync)
    let raf = 0
    const rafLoop = () => {
      currentTimeMs = v.currentTime * 1000
      playing = !v.paused && !v.ended
      raf = requestAnimationFrame(rafLoop)
    }
    raf = requestAnimationFrame(rafLoop)
    return () => {
      cancelAnimationFrame(raf)
      v.removeEventListener('loadedmetadata', sync)
      v.removeEventListener('play', sync)
      v.removeEventListener('pause', sync)
      v.removeEventListener('seeked', sync)
      v.removeEventListener('ended', sync)
      v.removeEventListener('timeupdate', sync)
    }
  })


  function loadVideo(file: File) {
    if (app.videoUrl) URL.revokeObjectURL(app.videoUrl)
    app.videoUrl = URL.createObjectURL(file)
    app.videoName = file.name
    // auto-pick funscript with the same base name from the same selection? (browser can't scan dirs)
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    dragOver = false
    const f = e.dataTransfer?.files?.[0]
    if (f && f.type.startsWith('video/')) loadVideo(f)
  }

  function toggle() {
    if (!videoEl) return
    if (videoEl.paused) void videoEl.play()
    else videoEl.pause()
  }

  function fmt(s: number): string {
    if (!isFinite(s)) return '0:00'
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${String(sec).padStart(2, '0')}`
  }

  function seek(ms: number) {
    if (videoEl) videoEl.currentTime = Math.max(0, Math.min(videoEl.duration || 0, ms / 1000))
  }
</script>

<div
  class="panel dropzone"
  class:drag={dragOver}
  role="region"
  aria-label="video player"
  ondragover={(e) => {
    e.preventDefault()
    dragOver = true
  }}
  ondragleave={() => (dragOver = false)}
  ondrop={onDrop}
>
  {#if !app.videoUrl}
    <div class="placeholder">
      <p>Drop a video file here</p>
      <button class="primary" onclick={() => fileInput?.click()}>Choose video…</button>
      <input
        hidden
        type="file"
        accept="video/*"
        bind:this={fileInput}
        onchange={(e) => {
          const f = (e.target as HTMLInputElement).files?.[0]
          if (f) loadVideo(f)
          e.currentTarget.value = ''
        }}
      />
      <p class="muted">The video never leaves your browser.</p>
    </div>
  {:else}
    <video
      bind:this={videoEl}
      src={app.videoUrl}
      controls
      playsinline
      onplay={() => onvideoref?.(videoEl!)}
      onloadedmetadata={() => onvideoref?.(videoEl!)}
      onkeydown={(e) => {
        if (e.key === ' ') {
          e.preventDefault()
          toggle()
        }
      }}
    >
      <track kind="captions" />
    </video>

    <div class="row" style="justify-content:space-between">
      <span class="muted">{app.videoName}</span>
      <button onclick={() => fileInput?.click()}>Load other video…</button>
      <input
        hidden
        type="file"
        accept="video/*"
        bind:this={fileInput}
        onchange={(e) => {
          const f = (e.target as HTMLInputElement).files?.[0]
          if (f) loadVideo(f)
          e.currentTarget.value = ''
        }}
      />
    </div>

    {#if app.script}
      <Waveform
        traces={allTraces(app.script)}
        activeIds={playbackSources(app.script).map((s) => s.id)}
        currentTimeMs={currentTime * 1000}
        durationMs={duration * 1000}
        sections={options.sectionsEnabled ? options.sections : undefined}
        onseek={seek}
      />
    {/if}

    <div class="row status">
      <span class="muted">{app.videoName}</span>
      <span class="muted">{fmt(currentTime)} / {fmt(duration)}</span>
      <span class="muted">{playing ? '▶ playing' : '⏸ paused'}</span>
    </div>
  {/if}
</div>

<style>
  .dropzone {
    min-height: 200px;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .dropzone.drag {
    border-color: var(--accent);
  }
  .placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 2rem 0;
  }
  video {
    width: 100%;
    border-radius: var(--radius);
    background: black;
    max-height: 60vh;
  }
  .status {
    justify-content: space-between;
  }
</style>
