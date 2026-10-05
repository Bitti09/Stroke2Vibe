import { describe, expect, it } from 'vitest'
import { parseFunscript } from '../src/lib/funscript'
import { generateVacuum, defaultVacuumOptions } from '../src/lib/convert/engine'

// 3-second stroke script at 1 Hz (half strokes 500ms), full range 20..80
const L0 = Array.from({ length: 13 }, (_, i) => ({
  at: 1000 + i * 500,
  pos: i % 2 === 0 ? 20 : 80,
}))

const FS = JSON.stringify({ version: '1.0', actions: L0, axes: [] })

describe('generateVacuum', () => {
  it('stroke mode: suction tracks stroke position, releases at end', () => {
    const fs = parseFunscript(FS)
    const r = generateVacuum(fs, { mode: 'stroke', depth: 1 })
    expect(r.axisId).toBe('A0')
    // at the bottom of the stroke (pos 20) suction should be high, at top (80) low
    const first = r.actions[0] // t=1000, pos=20 (inserted deep)
    const second = r.actions[1] // t=1500, pos=80 (top)
    expect(first.pos).toBeGreaterThan(second.pos)
    // final action is the release stop
    expect(r.actions[r.actions.length - 1].pos).toBe(0)
  })

  it('invert flips the correlation', () => {
    const fs = parseFunscript(FS)
    const r = generateVacuum(fs, { mode: 'stroke', depth: 1, invert: true })
    expect(r.actions[0].pos).toBeLessThan(r.actions[1].pos)
  })

  it('pump pulses: on/off pattern, no held level (Sam Neo style)', () => {
    const fs = parseFunscript(FS)
    const r = generateVacuum(fs, { pumpPulses: true, pulseHz: 2, duty: 0.3, mode: 'stroke' })
    // pulses alternate peak/0
    const positions = r.actions.map((a) => a.pos)
    const zeros = positions.filter((p) => p === 0)
    const peaks = positions.filter((p) => p > 0)
    expect(zeros.length).toBeGreaterThan(2)
    expect(peaks.length).toBeGreaterThan(2)
    // no two consecutive nonzero actions (that would be a held level)
    for (let i = 1; i < r.actions.length; i++) {
      if (r.actions[i].pos > 0) {
        expect(r.actions[i - 1].pos).toBe(0)
      }
    }
  })

  it('pump pulses stop during source silence (no orphan pumping)', () => {
    // add a 10s gap in the middle
    const withGap = [
      ...L0.slice(0, 6),
      ...L0.slice(6).map((a) => ({ ...a, at: a.at + 10000 })),
    ]
    const fs = parseFunscript(JSON.stringify({ version: '1.0', actions: withGap, axes: [] }))
    const r = generateVacuum(fs, { pumpPulses: true, pulseHz: 2, mode: 'stroke' })
    // no pulse peak inside the gap window (5000..15000)
    // second part starts at 14000 (L0[6].at 4000 + 10000 gap); gap = [3500, 14000)
    const inGap = r.actions.filter((a) => a.at > 3500 && a.at < 13999 && a.pos > 0)
    expect(inGap).toHaveLength(0)
  })

  it('pulse rate is respected', () => {
    const fs = parseFunscript(FS)
    const r = generateVacuum(fs, { pumpPulses: true, pulseHz: 4, duty: 0.3, mode: 'stroke' })
    const peaks = r.actions.filter((a) => a.pos > 0)
    expect(peaks.length).toBeGreaterThanOrEqual(2)
    const gaps = peaks.slice(1).map((p, i) => p.at - peaks[i].at)
    // 4Hz pulses -> peak spacing ~250ms (within jitter tolerance from ramp edges)
    expect(Math.min(...gaps)).toBeLessThan(400)
  })

  it('depth scales suction range', () => {
    const fs = parseFunscript(FS)
    const soft = generateVacuum(fs, { mode: 'stroke', depth: 0.3 })
    const full = generateVacuum(fs, { mode: 'stroke', depth: 1 })
    const softMax = Math.max(...soft.actions.map((a) => a.pos))
    const fullMax = Math.max(...full.actions.map((a) => a.pos))
    expect(softMax).toBeLessThan(fullMax)
    expect(fullMax).toBeLessThanOrEqual(100)
  })

  it('respects min gap between actions', () => {
    const fs = parseFunscript(FS)
    const r = generateVacuum(fs, { minGapMs: 600 })
    for (let i = 1; i < r.actions.length; i++) {
      expect(r.actions[i].at - r.actions[i - 1].at).toBeGreaterThanOrEqual(600)
    }
  })
})
