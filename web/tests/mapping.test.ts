import { describe, expect, it } from 'vitest'
import { parseFunscript, hasAxis } from '../src/lib/funscript'
import { convertMapped, availableSources, defaultOptions } from '../src/lib/convert/engine'
import type { AxisMapping } from '../src/lib/convert/engine'

// script with an L0 stroke section and an r0 twist section + an existing v0-ish track
const SCRIPT = JSON.stringify({
  version: '1.1',
  metadata: { topic_creator: 'LordKamek' },
  actions: [
    { at: 1000, pos: 50 }, { at: 2000, pos: 80 }, { at: 3000, pos: 30 }, { at: 4000, pos: 70 }, { at: 5000, pos: 40 },
  ],
  axes: [
    { id: 'r0', actions: [{ at: 1000, pos: 40 }, { at: 2500, pos: 90 }, { at: 4000, pos: 20 }, { at: 5000, pos: 60 }] },
    { id: 'v0', actions: [{ at: 1000, pos: 80 }, { at: 2000, pos: 80 }, { at: 3000, pos: 10 }, { at: 4000, pos: 10 }, { at: 5000, pos: 90 }] },
  ],
})

describe('availableSources', () => {
  it('lists L0 + all axes with vibe detection', () => {
    const fs = parseFunscript(SCRIPT)
    const s = availableSources(fs)
    expect(s.map((x) => x.id)).toEqual(['L0', 'r0', 'v0'])
    expect(s.find((x) => x.id === 'v0')!.vibeLike).toBe(true)
    expect(s.find((x) => x.id === 'r0')!.vibeLike).toBe(false)
  })
})

describe('convertMapped', () => {
  it('default mapping (L0→both, same mode) uses the coupled split', () => {
    const fs = parseFunscript(SCRIPT)
    const r = convertMapped(fs, { ...defaultOptions, rawOutput: true, mappings: [
      { source: 'L0', target: 'V0', mode: 'travel' },
      { source: 'L0', target: 'V1', mode: 'travel' },
    ] })
    expect(r.perAxis.map((p) => p.mode)).toEqual(['coupled', 'coupled'])
    expect(r.axes.map((a) => a.id)).toEqual(['V0', 'V1'])
    // energy preservation: corr vs envelope ~1
    expect(r.perAxis[0].stats.corr).toBeGreaterThan(0.9)
  })

  it('remaps r0 → V1 independently while L0 → V0', () => {
    const fs = parseFunscript(SCRIPT)
    const r = convertMapped(fs, { ...defaultOptions, rawOutput: true, mappings: [
      { source: 'L0', target: 'V0', mode: 'travel' },
      { source: 'r0', target: 'V1', mode: 'surge' },
    ] })
    expect(r.perAxis[0].coupled).toBe(false)
    expect(r.perAxis[1].coupled).toBe(false)
    expect(r.perAxis[1].source).toBe('r0')
    // independent L0 row with travel mode = full envelope
    expect(r.perAxis[0].stats.axes[0].meanActive).toBeGreaterThan(0)
    // r0 row ends with a stop
    const v1 = r.axes.find((a) => a.id === 'V1')!.actions
    expect(v1[v1.length - 1].pos).toBe(0)
  })

  it('alternate mode pulses at the source tempo', () => {
    const fs = parseFunscript(SCRIPT)
    const r = convertMapped(fs, { ...defaultOptions, rawOutput: true, mappings: [
      { source: 'r0', target: 'V0', mode: 'alternate' },
      { source: 'L0', target: 'V1', mode: 'layer' },
    ] })
    const v0 = r.axes.find((a) => a.id === 'V0')!.actions.map((a) => a.pos)
    // alternate never fully silent (floor keeps passive beats audible)
    expect(Math.min(...v0.filter((p) => p > 0))).toBeGreaterThanOrEqual(defaultOptions.floorVal)
  })

  it('vibe-like source passes intensity directly (no speed differential)', () => {
    const fs = parseFunscript(SCRIPT)
    const r = convertMapped(fs, { ...defaultOptions, rawOutput: true, mappings: [
      { source: 'v0', target: 'V0', mode: 'surge' },
      { source: 'L0', target: 'V1', mode: 'surge' },
    ] })
    const v0 = r.axes.find((a) => a.id === 'V0')!.actions
    // source v0 pos was 80,80,10,10,90 — direct mapping keeps levels (not speed peaks)
    const maxPos = Math.max(...v0.map((a) => a.pos))
    expect(maxPos).toBeLessThanOrEqual(90)
    expect(v0.some((a) => a.pos === 90)).toBe(true)
  })

  it('unmapped targets are omitted', () => {
    const fs = parseFunscript(SCRIPT)
    const r = convertMapped(fs, { ...defaultOptions, rawOutput: true, mappings: [
      { source: 'L0', target: 'V0', mode: 'surge' },
    ] })
    expect(r.axes.map((a) => a.id)).toEqual(['V0'])
  })

  it('throws on unknown source', () => {
    const fs = parseFunscript(SCRIPT)
    expect(() =>
      convertMapped(fs, { ...defaultOptions, rawOutput: true, mappings: [
        { source: 'l9', target: 'V0', mode: 'surge' },
      ] }),
    ).toThrow(/not found/)
  })
})

describe('remapping round-trip through setAxes', () => {
  it('replaces existing v0 with the mapped result, keeps r0', async () => {
    const { setAxes, hasAxis: hx } = await import('../src/lib/funscript')
    const fs = parseFunscript(SCRIPT)
    expect(hx(fs, 'v0')).toBe(true)
    const r = convertMapped(fs, { ...defaultOptions, rawOutput: true, mappings: [
      { source: 'r0', target: 'V0', mode: 'surge' },
      { source: 'L0', target: 'V1', mode: 'surge' },
    ] })
    setAxes(fs, r.axes)
    expect(hasAxis(fs, 'r0')).toBe(true)
    // existing v0 (lowercase) got replaced by V0 mapping
    expect(hx(fs, 'V0')).toBe(true)
    const v0 = fs.axes.find((a) => a.id.toLowerCase() === 'v0')!
    expect(v0.id).toBe('V0')
    expect(v0.actions.length).toBeGreaterThan(0)
  })
})
