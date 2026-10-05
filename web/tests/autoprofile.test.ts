import { describe, expect, it } from 'vitest'
import { parseFunscript } from '../src/lib/funscript'
import { convertScript, convertMapped, defaultOptions, deriveAutoProfile } from '../src/lib/convert/engine'
import type { Action } from '../src/lib/funscript'

// rhythmic 1Hz stroke script (metronome, 30..70)
function metronome(count = 40, period = 1000): Action[] {
  return Array.from({ length: count }, (_, i) => ({
    at: 1000 + i * period,
    pos: i % 2 === 0 ? 70 : 30,
  }))
}
// hammer: 4x faster, tiny period -> speedLoad ~ high
function hammer(): Action[] {
  return Array.from({ length: 120 }, (_, i) => ({
    at: 1000 + i * 150,
    pos: i % 2 === 0 ? 85 : 15,
  }))
}

const FS = (actions: Action[]) => parseFunscript(JSON.stringify({ version: '1.0', actions, axes: [] }))

describe('deriveAutoProfile', () => {
  it('hammer source derives heavier gate/smoothing + lower target', () => {
    const { shaping } = deriveAutoProfile(hammer(), 'balanced', {})
    expect(shaping.gateP).toBeGreaterThan(defaultOptions.gateP)
    expect(shaping.smoothMs).toBeGreaterThan(defaultOptions.smoothMs)
    expect(shaping.target).toBeLessThan(defaultOptions.target)
  })

  it('profiles are ordered: softer < balanced < stronger < extreme for baseline/ripple contrast', () => {
    const a = deriveAutoProfile(metronome(), 'softer', {}).shaping
    const b = deriveAutoProfile(metronome(), 'balanced', {}).shaping
    const s = deriveAutoProfile(metronome(), 'stronger', {}).shaping
    const e = deriveAutoProfile(metronome(), 'extreme', {}).shaping
    expect(a.baseline).toBeGreaterThan(b.baseline)
    expect(b.baseline).toBeGreaterThan(e.baseline)
    expect(a.ripple).toBeLessThan(s.ripple)
    expect(s.ripple).toBeLessThan(e.ripple)
    expect(e.target).toBeGreaterThan(a.target)
  })

  it('user overrides win over derived values', () => {
    const { applied } = deriveAutoProfile(hammer(), 'balanced', { target: 55, smoothMs: 111 })
    expect(applied.target).toBe(55)
    expect(applied.smoothMs).toBe(111)
  })
})

describe('auto wave in conversion', () => {
  it('produces a gliding wave: no mid-action dropouts on rhythmic source', () => {
    const r = convertScript(FS(metronome()), { mode: 'auto', autoProfile: 'balanced' })
    const v0 = r.axes[0].actions
    // interior actions (after ramp-in; envelope settles at ~1.6s here) never drop to 0
    const interior = v0.filter((a) => a.at >= 2000 && a.at <= v0[v0.length - 1].at - 1000)
    expect(interior.length).toBeGreaterThan(10)
    expect(interior.every((a) => a.pos > 0)).toBe(true)
  })

  it('profiles differ measurably in output dynamics', () => {
    const softer = convertScript(FS(metronome()), { autoProfile: 'softer' })
    const extreme = convertScript(FS(metronome()), { autoProfile: 'extreme' })
    const rangeOf = (r: ReturnType<typeof convertScript>) => {
      const vals = r.axes[0].actions.filter((a) => a.pos > 0).map((a) => a.pos)
      return Math.max(...vals) - Math.min(...vals)
    }
    // extreme: deeper dips -> wider value range; softer: tighter range
    expect(rangeOf(extreme)).toBeGreaterThan(rangeOf(softer))
  })

  it('works through the mapping path too', () => {
    const fs = parseFunscript(JSON.stringify({ version: '1.0', actions: metronome(), axes: [] }))
    const r = convertMapped(fs, {
      ...defaultOptions,
      autoProfile: 'stronger',
      mappings: [
        { source: 'L0', target: 'V0', mode: 'auto' },
        { source: 'L0', target: 'V1', mode: 'auto' },
      ],
    })
    expect(r.axes).toHaveLength(2)
    expect(r.perAxis.length).toBeGreaterThan(0)
    expect(r.perAxis[0].stats.axes[0].actions).toBeGreaterThan(0)
  })
})
