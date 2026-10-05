import { describe, expect, it } from 'vitest'
import { createSyncDriver, type SyncDriver } from '../src/lib/player/sync'
import type { Action } from '../src/lib/funscript'

const src: Array<{ id: string; actions: Action[] }> = [
  { id: 'V0', actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }] },
  { id: 'V1', actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 50 }] },
]

function make(opts: Partial<Parameters<typeof createSyncDriver>[2]>) {
  let sent: number[][] = []
  const driver: SyncDriver = createSyncDriver(src, async (v) => { sent.push([...v]) }, {
    intensity: 1,
    rampMs: 20,
    pauseStops: true,
    motorMin: [0, 0],
    motorMax: [1, 1],
    ...opts,
  })
  return { driver, sent: () => sent }
}

describe('per-motor power limits in sync driver', () => {
  it('caps motor output at motorMax', async () => {
    const { driver, sent } = make({ motorMax: [0.6, 1], rampMs: 1 })
    // t=1000 -> V0 raw 1.0; ramp converges quickly with rampMs=1 (real dt >> rampMs)
    for (let i = 0; i < 100; i++) await driver.tick(1000, true, 1)
    const last = sent().at(-1)!
    // the last recorded send respects the hard cap (device holds the scalar, so the cap
    // matters on every recorded send, not just at convergence)
    expect(last[0]).toBeLessThanOrEqual(0.61)
    expect(last[0]).toBeGreaterThan(0)
    for (const v of sent()) expect(v[0]).toBeLessThanOrEqual(0.61)
    driver.dispose()
  })

  it('lifts running values to motorMin but keeps off at zero', async () => {
    const { driver, sent } = make({ motorMin: [0.3, 0.3], rampMs: 1 })
    // t=0 -> both 0: must stay 0 (min must not create idle buzz)
    await driver.tick(0, true, 1)
    const atZero = sent().at(-1) ?? [0, 0]
    expect(atZero[0]).toBe(0)
    // t=1000 -> V0 target 1.0; V1 target 0.5: both above min when converged
    for (let i = 0; i < 100; i++) await driver.tick(1000, true, 1)
    const last = sent().at(-1)!
    expect(last[0]).toBeGreaterThanOrEqual(0.3)
    expect(last[1]).toBeGreaterThanOrEqual(0.3)
    driver.dispose()
  })

  it('low values below min are lifted, not zeroed', async () => {
    const { driver, sent } = make({ motorMin: [0.4, 0.4], rampMs: 1 })
    // V1 target is 0.5 at t=1000; converged output must sit at/above the 0.4 floor
    for (let i = 0; i < 100; i++) await driver.tick(1000, true, 1)
    const last = sent().at(-1)!
    expect(last[1]).toBeGreaterThanOrEqual(0.39)
    driver.dispose()
  })
})
