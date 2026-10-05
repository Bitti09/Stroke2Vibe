// Intiface Central (buttplug.io) connection via the official buttplug.js client.
// buttplug v5 API: connect via ButtplugBrowserWebsocketClientConnector (browser) and drive
// devices through DeviceOutput.Vibrate.percent(...) per feature.

import {
  ButtplugClient,
  ButtplugBrowserWebsocketClientConnector,
  DeviceOutput,
  OutputType,
} from 'buttplug'
import type { ButtplugClientDevice, IButtplugClientDeviceFeature } from 'buttplug'

export { ButtplugClient }

export interface DeviceInfo {
  index: number
  name: string
  vibeFeatures: number[] // feature indices with Vibrate output
}

export interface ConnectedDevice {
  info: DeviceInfo
  /** values: one intensity 0..1 per V0/V1 axis; extra values map to further vibe features */
  vibrate: (values: number[]) => Promise<void>
  stop: () => Promise<void>
  /** fully disconnect the buttplug client (closes the websocket to Intiface) */
  disconnect: () => Promise<void>
}

function deviceInfo(d: ButtplugClientDevice): DeviceInfo {
  const vibeFeatures: number[] = []
  for (const f of d.features.values() as IterableIterator<IButtplugClientDeviceFeature>) {
    if (f.hasOutput(OutputType.Vibrate)) vibeFeatures.push(f.index)
  }
  return { index: d.index, name: d.displayName ?? d.name, vibeFeatures }
}

export async function scanDevices(url: string, ms = 2500): Promise<DeviceInfo[]> {
  const client = new ButtplugClient('Stroke2Vibe Web')
  await client.connect(new ButtplugBrowserWebsocketClientConnector(url))
  await client.startScanning()
  await new Promise((r) => setTimeout(r, ms))
  await client.stopScanning()
  const infos: DeviceInfo[] = []
  for (const d of client.devices.values() as IterableIterator<ButtplugClientDevice>) {
    const info = deviceInfo(d)
    if (info.vibeFeatures.length > 0) infos.push(info)
  }
  await client.disconnect()
  return infos
}

export async function connectDevice(url: string, deviceIndex: number | null, onDisconnect: () => void): Promise<{ client: ButtplugClient; device: ConnectedDevice }> {
  const client = new ButtplugClient('Stroke2Vibe Web')
  await client.connect(new ButtplugBrowserWebsocketClientConnector(url))
  client.addListener('disconnect', onDisconnect)

  await client.startScanning()
  await new Promise((r) => setTimeout(r, 2500))
  await client.stopScanning()

  let target: ButtplugClientDevice | undefined
  for (const d of client.devices.values() as IterableIterator<ButtplugClientDevice>) {
    const info = deviceInfo(d)
    if (info.vibeFeatures.length === 0) continue
    if (deviceIndex === null || deviceIndex === d.index) {
      target = d
      break
    }
  }
  if (!target) {
    await client.disconnect()
    throw new Error(deviceIndex === null ? 'no vibration device found (is the toy on?)' : 'selected device not found or has no vibe motors')
  }

  const info = deviceInfo(target)
  const features: IButtplugClientDeviceFeature[] = []
  for (const f of target.features.values() as IterableIterator<IButtplugClientDeviceFeature>) {
    if (f.hasOutput(OutputType.Vibrate)) features.push(f)
  }

  const device: ConnectedDevice = {
    info,
    vibrate: async (values) => {
      const n = Math.min(values.length, features.length)
      const jobs: Array<Promise<void>> = []
      for (let i = 0; i < n; i++) {
        jobs.push(features[i].runOutput(DeviceOutput.Vibrate.percent(Math.max(0, Math.min(1, values[i])))))
      }
      if (jobs.length > 0) await Promise.all(jobs)
    },
    stop: async () => {
      await target!.stop()
    },
    disconnect: async () => {
      await client.disconnect()
    },
  }
  return { client, device }
}
