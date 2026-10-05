# Stroke2Vibe Web

Local video + funscript player with **on-the-fly L0 → V0/V1 conversion** and direct
**Intiface Central (buttplug.io)** device control. 100% client-side: video and scripts
never leave the browser; no backend, no uploads.

## Stack

Svelte 5 (runes) + Vite + TypeScript, [`buttplug`](https://github.com/buttplugio/buttplug-js)
(the official buttplug.io client) for the Intiface websocket connection.

```
web/src/lib/
  funscript.ts        parser/serializer (multi-axis "axes" aware)
  convert/engine.ts   TS port of the C++ conversion pipeline (same defaults & math)
  player/sync.ts      playhead sampling, output ramping, heatmap
  player/VideoPanel   local video (drag&drop / file picker) + heatmap strip
  player/ScriptPanel  funscript loader
  convert/ConvertPanel appears when a script has no V0/V1: live conversion preview
  intiface/           connection, device scan, consent switch, STOP button, options
```

## Run

```
cd web
npm install
npm run dev        # http://localhost:5173
npm test           # converter parity tests vs the C++ reference values
```

## Screenshots

- `docs/screenshot-start.png` — start view: video drop zone, funscript loader, Intiface connect
- `docs/screenshot-panels.png` — with a script loaded: trace mapping (V0/V1), trace quality
  rating with recommendations, convert panel with live preview

## Waveform display

Under the video: one lane per active playback axis (V0/V1), drawn as a filled waveform
with a live playhead marker.

- **Click / drag** anywhere to seek
- **Mouse wheel** zooms into the point under the cursor (2 s … full range)
- **− / + buttons** zoom around the playhead, **60s / Ns** toggles full view
- While zoomed, the view **auto-follows** the playhead when it leaves the window
  (manual drag/zoom sets a short cooldown so it doesn't fight you)

## Using it

1. Start **Intiface Central** and enable its websocket server (default
   `ws://localhost:12345`).
2. Drop a video into the page, load the matching `.funscript`.
3. If the script has no V0/V1 axes, the **convert panel** appears: pick a mode
   (auto/travel/alternate/layer/surge), tune gamma/floor/duty, watch the live preview,
   then *Use V0/V1 for playback* — or download the converted multi-axis funscript.
4. Connect to Intiface, pick your device, flip the **Control enabled** consent switch.
5. Play. Pause ramps motors to 0 (optional), seek updates instantly, the red **STOP**
   button kills all outputs.

## Notes

- The browser can only reach `ws://localhost…` from a secure (or localhost) origin.
  Run the page locally (`npm run dev`) or serve it over HTTPS.
- Device mapping: V0 → first vibe feature, V1 → second vibe feature (multi-motor
  devices like dual-vibe masturbators). Devices with one motor get the blended signal.
- Converted scripts are embedded as a standard single-file multi-axis `axes` array
  (SLR/MFP convention) — the original L0 actions stay untouched.
- **Vacuum/suction track generator** (`Vacuum trace` panel): derive an A0-class suction
  track from any existing trace. Modes: *stroke position* (suction deepest when inserted),
  *tempo-locked pulsing*, *action intensity*. **Pump pulses** toggle for devices that can't
  hold a vacuum (e.g. Svakom Sam Neo): emits rhythmic on/off pump strokes (rate/duty
  adjustable) that follow the source intensity and stop during script pauses. Controls:
  depth, duty, base position, invert, axis id (default `A0`); add to script or download as
  `<base>.a0.funscript`.
- **Auto wave profiles** (mapping panel): pick `balanced` / `softer` / `stronger` /
  `extreme` and all shaping (target, gamma, gate, smoothing, floor, output grid) is
  derived automatically from the measured trace profile — always aiming for one clean
  gliding wave that mirrors the original line (raised baseline + slow swell + bounded
  ripple, never per-stroke hammering). Sliders act as overrides: touch one to pin it,
  switch profile to reset all.
- **Trace quality panel:** every existing trace gets a 0–100 usability rating (tempo,
  amplitude range, smoothness/square jumps, micro-jitter, density, redundancy vs L0)
  with human-readable notes — so you can decide before mapping what is worth converting.
  Includes **actionable recommendations**: heavy continuous load (constant fast strokes,
  e.g. Dauerhammer scripts) → lower target / raise gate & smoothing; fast tempo → use
  layer/surge modes; tiny amplitudes, jitter, L0-redundancy each get concrete fixes.
- **Trace mapping panel:** connect *any* existing axis (L0, `l2`, `r0`, an existing `v0`
  track, …) to V0/V1 and choose the conversion mode per trace. Same source + same mode on
  both targets = coupled energy-preserving split; different sources = each target is shaped
  from its own trace (`auto/travel/surge` = full envelope, `alternate` = tempo-locked pulse,
  `layer` = breathing). Vibe-like sources (`v*`) pass their intensity directly.
