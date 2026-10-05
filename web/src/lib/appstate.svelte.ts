// Shared reactive state (Svelte 5 runes module)
import type { Funscript } from './funscript'
import type { DeviceInfo, ConnectedDevice } from './intiface/client'

export interface AppState {
  videoUrl: string | null
  videoName: string
  script: Funscript | null
  scriptName: string
  device: ConnectedDevice | null
  deviceInfo: DeviceInfo | null
  devices: DeviceInfo[]
  intifaceError: string | null
  connected: boolean
  safetyEnabled: boolean
  converted: boolean
  /** lowercase ids of axes the app generated (converted/mapped/vacuum) — excluded from source ratings */
  generatedAxes: string[]
}

export const state: AppState = $state({
  videoUrl: null,
  videoName: '',
  script: null,
  scriptName: '',
  device: null,
  deviceInfo: null,
  devices: [],
  intifaceError: null,
  connected: false,
  safetyEnabled: false,
  converted: false,
  generatedAxes: [],
})

export const options = $state({
  intensity: 1.0,
  rampMs: 60,
  pauseStops: true,
  /** per-motor power limits, 0..1 (applied after intensity, before sending) */
  motorMin: [0, 0] as [number, number],
  motorMax: [1, 1] as [number, number],
  /** M2.1: show section bands in the waveform */
  sectionsEnabled: false,
  /** M2.1: section boundaries (set by the convert pipeline) */
  sections: [] as Array<{ start: number; end: number; profile: 'softer' | 'balanced' | 'stronger' | 'extreme' }>,
})

/** Dev/demo helper: replace the loaded script programmatically. */
export function setScript(fs: Funscript, name = 'demo.funscript') {
  state.script = fs
  state.scriptName = name
  state.generatedAxes = []
  state.converted = false
}
