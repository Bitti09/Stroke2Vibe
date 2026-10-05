<script lang="ts">
  import { state as app, options } from '../appstate.svelte'
  import { connectDevice, scanDevices } from '../intiface/client'
  import { createSyncDriver, playbackSources, type SyncDriver, type SyncOptions } from '../player/sync'
  import { onAxisValue } from '../axisBus'
  import RangeSlider from './RangeSlider.svelte'
  import { onMount } from 'svelte'

  let url = $state('ws://localhost:12345')
  let busy = $state(false)
  let liveVals = $state<[number, number]>([0, 0])
  let driver: SyncDriver | null = null
  let rafId = 0
  let unsub: (() => void) | null = null

  async function scan() {
    busy = true
    app.intifaceError = null
    try {
      app.devices = await scanDevices(url)
      if (app.devices.length === 0) app.intifaceError = 'no vibration devices found'
    } catch (e) {
      app.intifaceError = (e as Error).message
    } finally {
      busy = false
    }
  }

  async function connect(index: number | null) {
    busy = true
    app.intifaceError = null
    try {
      const { device } = await connectDevice(url, index, () => {
        app.connected = false
        app.device = null
        stopLoop()
      })
      app.device = device
      app.deviceInfo = device.info
      app.connected = true
      app.safetyEnabled = false
      startLoop()
    } catch (e) {
      app.intifaceError = (e as Error).message
    } finally {
      busy = false
    }
  }

  async function disconnect() {
    stopLoop()
    try {
      await app.device?.stop()
    } catch { /* ignore */ }
    try {
      await app.device?.disconnect()
    } catch { /* ignore */ }
    app.device = null
    app.deviceInfo = null
    app.devices = []
    app.connected = false
  }

  // video element reference handed over from the player panel
  let video: HTMLVideoElement | null = null

  export function registerVideo(el: HTMLVideoElement) {
    video = el
    // video arrives late (user loads it after connecting) — arm the loop if we can
    if (app.connected && app.script) startLoop()
  }

  /** call when playback axes changed (e.g. after remap/convert apply) */
  export function restart() {
    if (app.connected && app.script) startLoop()
  }

  const syncOpts: SyncOptions = $derived({
    intensity: options.intensity,
    rampMs: options.rampMs,
    pauseStops: options.pauseStops,
    motorMin: options.motorMin,
    motorMax: options.motorMax,
  })

  $effect(() => {
    // live-update the driver when options change (no restart needed)
    if (driver) {
      driver.updateOptions(syncOpts)
    }
  })

  function startLoop() {
    if (!app.device || !app.script) return
    stopLoop()
    const sources = playbackSources(app.script)
    driver = createSyncDriver(
      sources,
      async (values) => {
        // consent gate: mute all device output while disabled
        if (!app.safetyEnabled) {
          await app.device!.stop()
          return
        }
        await app.device!.vibrate(values)
      },
      syncOpts,
    )
    const loop = () => {
      if (!driver) return
      const t = (video?.currentTime ?? 0) * 1000
      const playing = !!video && !video.paused && !video.ended
      // consent gate only mutes the SEND path (stop()), not the playing flag itself
      void driver.tick(t, playing, video?.playbackRate ?? 1)
      rafId = requestAnimationFrame(loop)
    }
    rafId = requestAnimationFrame(loop)
  }

  function stopLoop() {
    if (rafId) cancelAnimationFrame(rafId)
    rafId = 0
    driver?.dispose()
    driver = null
  }

  async function killSwitch() {
    app.safetyEnabled = false
    await app.device?.stop()
  }

  async function toggleConsent(enabled: boolean) {
    app.safetyEnabled = enabled
    if (enabled) {
      // (re)arm: zero the ramp start so playback begins from the script value, not a stale level
      if (driver) driver.stop()
      startLoop()
    } else {
      await app.device?.stop()
      stopLoop()
    }
  }

  const pct = (v: number) => `${Math.round(v * 100)}%`

  onMount(() => {
    unsub = onAxisValue((v0, v1) => {
      liveVals = [v0, v1]
    })
    return () => {
      unsub?.()
      stopLoop()
    }
  })

</script>

<div class="panel">
  <h2>Intiface</h2>
  <div class="row">
    <input style="flex:1" bind:value={url} placeholder="ws://localhost:12345" />
    <button class="primary" disabled={busy || app.connected} onclick={() => connect(null)}>
      {busy ? '…' : 'Connect'}
    </button>
    <button disabled={busy || app.connected} onclick={scan}>Scan</button>
  </div>

  {#if app.intifaceError}
    <p class="error">{app.intifaceError}</p>
  {/if}

  {#if app.connected && app.deviceInfo}
    <p class="ok">✓ {app.deviceInfo.name} — {app.deviceInfo.vibeFeatures.length} vibe motor(s)</p>
    <label class="check">
      <input
        type="checkbox"
        checked={app.safetyEnabled}
        onchange={(e) => toggleConsent((e.currentTarget as HTMLInputElement).checked)}
      />
      Control enabled (consent)
    </label>
    <div class="bars">
      <div class="bar"><span>V0</span><div><i style="width:{liveVals[0]}%"></i></div></div>
      <div class="bar"><span>V1</span><div><i style="width:{liveVals[1]}%"></i></div></div>
    </div>
    <div class="row">
      <button class="danger" onclick={killSwitch}>STOP</button>
      <button onclick={disconnect}>Disconnect</button>
    </div>
    <details>
      <summary class="muted">Playback options</summary>
      <label> Intensity {options.intensity.toFixed(2)}× <input type="range" min="0.2" max="1.5" step="0.05" bind:value={options.intensity} /> </label>
      <label> Ramp {options.rampMs} ms <input type="range" min="20" max="250" step="10" bind:value={options.rampMs} /> </label>
      <label class="check"><input type="checkbox" bind:checked={options.pauseStops} /> ramp to 0 on pause</label>
      <div class="limits">
        <span class="muted">Motor power limits</span>
        <div class="limitrow">
          <span class="mtr">V0</span>
          <RangeSlider bind:valueMin={options.motorMin[0]} bind:valueMax={options.motorMax[0]} />
        </div>
        <div class="limitrow">
          <span class="mtr">V1</span>
          <RangeSlider bind:valueMin={options.motorMin[1]} bind:valueMax={options.motorMax[1]} />
        </div>
        <p class="hint muted">
          range slider: left thumb = min, right = max — min lifts running values (idle buzz
          helper, motor stays off at true 0), max hard-caps the motor
        </p>
      </div>
    </details>
  {:else if app.devices.length > 0}
    <ul class="devices">
      {#each app.devices as d}
        <li>
          <button onclick={() => connect(d.index)}>Connect</button>
          {d.name} ({d.vibeFeatures.length} vibe)
        </li>
      {/each}
    </ul>
  {/if}
  <p class="muted">
    Requires Intiface Central running with the websocket server enabled. Browser needs
    localhost (or HTTPS) to reach the websocket.
  </p>
</div>

<style>
  .error {
    color: var(--danger);
  }
  .ok {
    color: var(--ok);
  }
  .bars {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin: 0.6rem 0;
  }
  .bar {
    display: grid;
    grid-template-columns: 28px 1fr;
    gap: 0.4rem;
    align-items: center;
    font-size: 0.8rem;
  }
  .bar > div {
    background: var(--panel-2);
    border-radius: 6px;
    height: 12px;
    overflow: hidden;
  }
  .bar i {
    display: block;
    height: 100%;
    background: linear-gradient(to right, var(--accent), var(--accent-2));
  }
  .devices {
    list-style: none;
    padding: 0;
  }
  .devices li {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    padding: 0.25rem 0;
  }
  .check {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    margin: 0.4rem 0;
  }
  .limits {
    margin: 0.5rem 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .limitrow {
    display: grid;
    grid-template-columns: 28px 1fr;
    gap: 0.5rem;
    align-items: center;
    font-size: 0.8rem;
  }
  .mtr {
    font-weight: 700;
    color: var(--accent-2);
  }
  .hint {
    font-size: 0.75rem;
    margin: 0.1rem 0 0 0;
  }
  details label {
    display: block;
    margin: 0.35rem 0;
    font-size: 0.85rem;
  }
</style>
