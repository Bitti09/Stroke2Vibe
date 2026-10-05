import { describe, expect, it } from 'vitest'
import { parseFunscript, normalizeActions, hasAxis } from '../src/lib/funscript'
import { convertScript, defaultOptions } from '../src/lib/convert/engine'
import expected from './fixtures/expected.json'
// trimmed ReflectiveDesire example (2 sections + gap), same fixture as auto/tests
const SCRIPT = JSON.stringify({
  metadata: { duration: 872.208, topic_creator: 'LordKamek', tags: ['ai-generated'] },
  actions: [
    { at: 118000, pos: 51 }, { at: 118625, pos: 71 }, { at: 120125, pos: 40 }, { at: 121625, pos: 64 },
    { at: 123125, pos: 37 }, { at: 124625, pos: 68 }, { at: 126125, pos: 45 }, { at: 127625, pos: 67 },
    { at: 129125, pos: 38 }, { at: 130625, pos: 63 }, { at: 132125, pos: 40 }, { at: 133625, pos: 66 },
    { at: 135125, pos: 43 }, { at: 136625, pos: 66 }, { at: 138125, pos: 42 }, { at: 139625, pos: 67 },
    { at: 141125, pos: 41 }, { at: 142625, pos: 74 }, { at: 144125, pos: 42 }, { at: 145625, pos: 74 },
    { at: 147125, pos: 41 }, { at: 148625, pos: 68 }, { at: 150125, pos: 41 }, { at: 151625, pos: 67 },
    { at: 153125, pos: 44 },
    { at: 800000, pos: 26 }, { at: 800750, pos: 64 }, { at: 801500, pos: 24 }, { at: 802250, pos: 71 },
    { at: 803000, pos: 20 }, { at: 803750, pos: 71 }, { at: 804500, pos: 28 }, { at: 805250, pos: 65 },
    { at: 806000, pos: 19 }, { at: 806750, pos: 67 }, { at: 807500, pos: 22 }, { at: 808250, pos: 72 },
    { at: 809000, pos: 28 }, { at: 809750, pos: 73 },
  ],
  axes: [{ id: 'l2', actions: [{ at: 150000, pos: 50 }, { at: 151000, pos: 100 }, { at: 151500, pos: 0 }, { at: 152000, pos: 50 }] }],
  version: '1.1',
})

describe('funscript parsing', () => {
  it('parses actions + axes and preserves the doc', () => {
    const fs = parseFunscript(SCRIPT)
    expect(fs.version).toBe('1.1')
    expect(fs.actions.length).toBe(39)
    expect(hasAxis(fs, 'l2')).toBe(true)
    expect(fs.metadata).toEqual({ duration: 872.208, topic_creator: 'LordKamek', tags: ['ai-generated'] })
  })
  it('dedupes duplicate timestamps keeping last', () => {
    expect(normalizeActions([{ at: 100, pos: 10 }, { at: 100, pos: 20 }, { at: 50, pos: 5 }])).toEqual([
      { at: 50, pos: 5 },
      { at: 100, pos: 20 },
    ])
  })
  it('rejects malformed input', () => {
    expect(() => parseFunscript('{not json')).toThrow()
    expect(() => parseFunscript('{"actions":[{"pos":1}]}')).toThrow()
  })
})

describe('converter parity with C++ reference', () => {
  const fs = parseFunscript(SCRIPT)
  const exp = expected as typeof expected & { envelope: { scale: number; gate: number; T: number; fStroke: number }, modes: Record<string, { v0: Array<[number, number]>; v1: Array<[number, number]> }> }

  it('envelope matches reference (scale/gate/tempo)', () => {
    const r = convertScript(fs)
    expect(r.stats.scale).toBeCloseTo(exp.envelope.scale, 3)
    expect(r.stats.gate).toBeCloseTo(exp.envelope.gate, 3)
    expect(r.stats.tempo.halfStrokeMs).toBeCloseTo(exp.envelope.T, 3)
    expect(r.stats.tempo.fStroke).toBeCloseTo(exp.envelope.fStroke, 3)
  })

  for (const mode of ['travel', 'alternate', 'layer', 'surge'] as const) {
    it(`mode ${mode} matches C++ expected values`, () => {
      const r = convertScript(fs, { mode, rawOutput: true }, ['V0', 'V1'])
      const e = exp.modes[mode]
      expect(r.axes[0].actions.map((a) => [a.at, a.pos])).toEqual(e.v0)
      expect(r.axes[1].actions.map((a) => [a.at, a.pos])).toEqual(e.v1)
    })
  }
})

describe('converter guarantees', () => {
  it('ends both axes at 0', () => {
    const fs = parseFunscript(SCRIPT)
    const r = convertScript(fs)
    expect(r.axes[0].actions[r.axes[0].actions.length - 1].pos).toBe(0)
    expect(r.axes[1].actions[r.axes[1].actions.length - 1].pos).toBe(0)
  })
  it('enforces rate cap', () => {
    const fs = parseFunscript(SCRIPT)
    const r = convertScript(fs, { minGapMs: 700, rawOutput: true })
    for (let i = 1; i < r.axes[0].actions.length; i++) {
      expect(r.axes[0].actions[i].at - r.axes[0].actions[i - 1].at).toBeGreaterThanOrEqual(700)
    }
  })
  it('keeps combined intensity equal to envelope (energy preservation, travel)', () => {
    const fs = parseFunscript(SCRIPT)
    const r = convertScript(fs, { mode: 'travel' })
    expect(r.stats.corr).toBeGreaterThan(0.99)
  })
  it('defaults are used', () => {
    expect(defaultOptions.mode).toBe('auto')
    expect(defaultOptions.floorVal).toBe(12)
  })
})
