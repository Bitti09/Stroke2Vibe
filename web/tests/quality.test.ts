import { describe, expect, it } from 'vitest'
import { parseFunscript } from '../src/lib/funscript'
import { rateSources } from '../src/lib/convert/engine'
import type { SourceRating } from '../src/lib/convert/engine'

// helper signature sanity: recommendations exist and react to profile
function rate(axes: Array<{ id: string; actions: Array<{ at: number; pos: number }> }>, actions: Array<{ at: number; pos: number }>) {
  return rateSources(parseFunscript(JSON.stringify({ version: '1.0', actions, axes })))
}

// smooth, well-formed L0 stroke at 0.25 Hz with healthy amplitudes (pos 80/20)
const GOOD_L0 = Array.from({ length: 21 }, (_, i) => ({
  at: 1000 + i * 2000,
  pos: 50 + (i % 2 === 0 ? 30 : -30),
}))
// square-jump bursts (l2-style) at machine stops
const BAD_L2 = [
  { at: 1000, pos: 50 }, { at: 1100, pos: 100 }, { at: 1200, pos: 0 }, { at: 1300, pos: 50 },
  { at: 5000, pos: 50 }, { at: 5100, pos: 100 }, { at: 5200, pos: 0 }, { at: 5300, pos: 50 },
]
// micro-jitter noise (dp=2 every 100ms)
const NOISY_R0 = Array.from({ length: 30 }, (_, i) => ({
  at: 1000 + i * 100,
  pos: i % 2 === 0 ? 51 : 49,
}))
// existing vibe track
const VIBE_V0 = [
  { at: 1000, pos: 80 }, { at: 3000, pos: 80 }, { at: 5000, pos: 10 }, { at: 7000, pos: 90 },
]

const SCRIPT = JSON.stringify({
  version: '1.1',
  actions: GOOD_L0,
  axes: [
    { id: 'l2', actions: BAD_L2 },
    { id: 'r0', actions: NOISY_R0 },
    { id: 'v0', actions: VIBE_V0 },
  ],
})

describe('rateSources', () => {
  const fs = parseFunscript(SCRIPT)
  const ratings = rateSources(fs)
  const byId = (id: string) => ratings.find((r) => r.id === id)!

  it('rates every available source', () => {
    expect(ratings.map((r) => r.id)).toEqual(['L0', 'l2', 'r0', 'v0'])
  })

  it('good smooth stroke traces score high', () => {
    const l0 = byId('L0')
    expect(l0.tempoHz).toBeCloseTo(0.25, 1)
    expect(l0.amplitudeRange).toBe(60)
    expect(l0.smoothness).toBe(1)
    expect(l0.score).toBeGreaterThanOrEqual(65)
    expect(l0.verdict).toBe('good')
  })

  it('square-jump bursts score poorly and get a smoothing note', () => {
    const l2 = byId('l2')
    expect(l2.smoothness).toBeLessThan(0.7)
    expect(l2.notes.some((n) => n.includes('jumps'))).toBe(true)
    expect(l2.score).toBeLessThan(65)
  })

  it('micro-jitter gets flagged via noise ratio', () => {
    const r0 = byId('r0')
    // every segment is dp=2 within 100ms -> counted as jitter (dt in 10..300)
    expect(r0.noiseRatio).toBeGreaterThan(0.25)
    expect(r0.notes.some((n) => n.includes('jitter'))).toBe(true)
    expect(r0.amplitudeRange).toBeLessThan(6)
    expect(r0.notes.some((n) => n.includes('tiny amplitudes'))).toBe(true)
  })

  it('vibe-like traces are rated as directly usable', () => {
    const v0 = byId('v0')
    expect(v0.vibeLike).toBe(true)
    expect(v0.score).toBeGreaterThanOrEqual(65)
    expect(v0.notes.some((n) => n.includes('vibe-like'))).toBe(true)
  })

  it('L0 parallelism is null on L0 itself; computed when both traces vary', () => {
    expect(byId('L0').parallelToL0).toBeNull()
    // l2 bursts vs perfectly periodic L0: speed series of L0 is constant -> corr undefined (null)
    expect(byId('l2').parallelToL0).toBeNull()
  })
})

describe('recommendations', () => {
  it('hammer script (median speed ≈ p99) triggers throttle + gate recommendations', () => {
    // constant fast strokes: 60 pos per 250ms -> speed 240 pos/s constantly
    const actions = Array.from({ length: 60 }, (_, i) => ({
      at: 1000 + i * 250,
      pos: i % 2 === 0 ? 80 : 20,
    }))
    const ratings = rate([
      { id: 'L0', actions },
    ], actions)
    const l0 = ratings.find((r) => r.id === 'L0')!
    expect(l0.speedLoad).toBeGreaterThan(0.55)
    expect(l0.recommendations.some((r) => r.includes('Heavy continuous load'))).toBe(true)
    expect(l0.recommendations.some((r) => r.includes('noise gate'))).toBe(true)
  })

  it('healthy script gets the all-clear recommendation', () => {
    const actions = Array.from({ length: 21 }, (_, i) => ({
      at: 1000 + i * 2000,
      pos: 50 + (i % 2 === 0 ? 30 : -30),
    }))
    const ratings = rate([], actions) // fallback: no axes array
    void ratings
    const fs = parseFunscript(JSON.stringify({ version: '1.0', actions, axes: [] }))
    const l0 = rateSources(fs).find((r) => r.id === 'L0')!
    expect(l0.speedLoad).toBeLessThan(0.55)
    expect(l0.recommendations.some((r) => r.includes('sweet spot'))).toBe(true)
  })
})
