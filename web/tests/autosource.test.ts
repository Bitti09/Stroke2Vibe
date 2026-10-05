import { describe, expect, it } from 'vitest'
import { parseFunscript, hasAxis } from '../src/lib/funscript'
import { convertMapped, availableSources, defaultOptions } from '../src/lib/convert/engine'

// regression: multi-axis file with EMPTY top-level actions threw
// "script has no actions" during on-the-fly auto-conversion
const NO_L0 = JSON.stringify({
  version: '1.0',
  actions: [],
  axes: [
    { id: 'r0', actions: [
      { at: 1000, pos: 40 }, { at: 2000, pos: 80 }, { at: 3000, pos: 30 },
      { at: 4000, pos: 70 }, { at: 5000, pos: 35 }, { at: 6000, pos: 75 },
    ] },
    { id: 'l2', actions: [{ at: 1000, pos: 50 }, { at: 3000, pos: 90 }, { at: 5000, pos: 10 }] },
  ],
})

// normal file: L0 present
const WITH_L0 = JSON.stringify({
  version: '1.0',
  actions: [
    { at: 1000, pos: 50 }, { at: 2000, pos: 80 }, { at: 3000, pos: 30 }, { at: 4000, pos: 70 },
  ],
  axes: [],
})

describe('auto-conversion source selection', () => {
  it('falls back to the largest non-vibe axis when L0 is empty', () => {
    const fs = parseFunscript(NO_L0)
    const sources = availableSources(fs).filter((s) => s.actions > 0 && !s.vibeLike)
    const source = sources.find((s) => s.id === 'L0')?.id ?? sources.sort((a, b) => b.actions - a.actions)[0]?.id
    expect(source).toBe('r0') // r0 has 6 actions > l2's 3
  })

  it('converts an L0-less multi-axis file via the mapping path', () => {
    const fs = parseFunscript(NO_L0)
    const r = convertMapped(fs, {
      ...defaultOptions,
      autoProfile: 'balanced',
      mappings: [
        { source: 'r0', target: 'V0', mode: 'auto' },
        { source: 'r0', target: 'V1', mode: 'auto' },
      ],
    })
    expect(r.axes).toHaveLength(2)
    expect(r.axes[0].actions.length).toBeGreaterThan(0)
    expect(r.perAxis[0].source).toBe('r0')
  })

  it('prefers L0 when it has actions', () => {
    const fs = parseFunscript(WITH_L0)
    const sources = availableSources(fs).filter((s) => s.actions > 0 && !s.vibeLike)
    expect(sources.find((s) => s.id === 'L0')).toBeDefined()
    expect(hasAxis(fs, 'V0')).toBe(false)
  })

  it('errors clearly when nothing is convertible', () => {
    const fs = parseFunscript(JSON.stringify({ version: '1.0', actions: [], axes: [] }))
    const sources = availableSources(fs).filter((s) => s.actions > 0 && !s.vibeLike)
    expect(sources).toHaveLength(0)
  })
})
