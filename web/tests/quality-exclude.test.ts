import { describe, expect, it } from 'vitest'
import { parseFunscript } from '../src/lib/funscript'
import { rateSources } from '../src/lib/convert/engine'

// multi-axis script: L0 stroke + r0 twist + an existing v0 track
const FS = JSON.stringify({
  version: '1.0',
  actions: [
    { at: 1000, pos: 50 }, { at: 2000, pos: 80 }, { at: 3000, pos: 30 }, { at: 4000, pos: 70 }, { at: 5000, pos: 40 },
  ],
  axes: [
    { id: 'r0', actions: [{ at: 1000, pos: 40 }, { at: 2500, pos: 90 }, { at: 4000, pos: 20 }, { at: 5000, pos: 60 }] },
    { id: 'v0', actions: [{ at: 1000, pos: 80 }, { at: 3000, pos: 10 }, { at: 5000, pos: 90 }] },
  ],
})

describe('rateSources exclusion of generated axes', () => {
  it('rates everything when nothing is excluded', () => {
    const fs = parseFunscript(FS)
    expect(rateSources(fs).map((r) => r.id)).toEqual(['L0', 'r0', 'v0'])
  })

  it('excludes generated V0/V1 (case-insensitive) after on-the-fly conversion', () => {
    const fs = parseFunscript(FS)
    // simulate: app converted L0 -> V0/V1 and embedded them
    fs.axes.push({ id: 'V0', actions: fs.actions }, { id: 'V1', actions: fs.actions })
    const ratings = rateSources(fs, ['v0', 'v1'])
    // only original traces are rated; the file's own "v0" would ALSO match the exclusion
    // (it shares the id with the generated V0) — that is intended: same id = same axis slot
    expect(ratings.map((r) => r.id)).toEqual(['L0', 'r0'])
  })

  it('exclusion is case-insensitive', () => {
    const fs = parseFunscript(FS)
    const ratings = rateSources(fs, ['R0'])
    expect(ratings.map((r) => r.id)).toEqual(['L0', 'v0'])
  })

  it('empty exclusion list behaves as before', () => {
    const fs = parseFunscript(FS)
    expect(rateSources(fs, []).length).toBe(3)
  })
})
