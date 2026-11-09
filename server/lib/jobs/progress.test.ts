import { describe, expect, it } from 'vitest'
import { ANALYSIS_STEPS, SIGNALS_STEP_SHARES } from './analysis'
import { createStepProgress, createThrottledProgress } from './progress'

function clock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('createThrottledProgress', () => {
  it('writes at most once per interval, never goes down, and force writes at once', () => {
    const c = clock()
    const writes: number[] = []
    const p = createThrottledProgress(v => writes.push(v), c.now, 250)
    p.report(0.1)
    p.report(0.2)
    p.report(0.15)
    expect(writes).toEqual([0.1])
    c.advance(300)
    p.report(0.15)
    expect(writes).toEqual([0.1, 0.2])
    p.report(0.5, true)
    expect(writes).toEqual([0.1, 0.2, 0.5])
    p.report(2, true)
    expect(writes.at(-1)).toBe(1)
    expect(p.value).toBe(1)
  })

  it('ignores NaN and repeated values', () => {
    const c = clock()
    const writes: number[] = []
    const p = createThrottledProgress(v => writes.push(v), c.now, 0)
    p.report(Number.NaN)
    p.report(0.3)
    p.report(0.3)
    expect(writes).toEqual([0, 0.3])
  })
})

describe('createStepProgress', () => {
  it('weights the full analysis steps 2/5/60/10/21/2 % and the highlights-only steps 10/85/5 %', () => {
    expect(ANALYSIS_STEPS.full).toEqual([
      ['probe', 0.02], ['extract-audio', 0.05], ['transcribe', 0.6], ['prepare-preview', 0.1], ['signals', 0.21], ['candidates', 0.02],
    ])
    expect(ANALYSIS_STEPS.highlights).toEqual([['extract-audio', 0.1], ['signals', 0.85], ['candidates', 0.05]])
    for (const steps of Object.values(ANALYSIS_STEPS)) {
      expect(steps.reduce((sum, [, w]) => sum + w, 0)).toBeCloseTo(1)
    }
    expect(SIGNALS_STEP_SHARES.loudness + SIGNALS_STEP_SHARES.transcript).toBeCloseTo(1)

    const c = clock()
    const writes: Array<[string, number]> = []
    const p = createStepProgress(ANALYSIS_STEPS.full, (step, v) => writes.push([step, v]), c.now, 250)
    p.update(0.5)
    expect(writes).toEqual([['probe', 0.01]])
    p.step('extract-audio')
    expect(writes.at(-1)).toEqual(['extract-audio', 0.02])
    p.update(1)
    // Throttled (same instant), the step write already happened.
    expect(writes.at(-1)).toEqual(['extract-audio', 0.02])
    p.step('transcribe')
    expect(writes.at(-1)).toEqual(['transcribe', 0.07])
    c.advance(1000)
    p.update(0.5)
    expect(writes.at(-1)).toEqual(['transcribe', 0.37])
    p.step('prepare-preview')
    expect(writes.at(-1)).toEqual(['prepare-preview', 0.67])
    p.step('signals')
    expect(writes.at(-1)).toEqual(['signals', 0.77])
    c.advance(1000)
    p.update(0.5)
    expect(writes.at(-1)).toEqual(['signals', 0.875])
    p.step('candidates')
    expect(writes.at(-1)).toEqual(['candidates', 0.98])
    c.advance(1000)
    p.update(1)
    expect(writes.at(-1)).toEqual(['candidates', 1])
    expect(p.overall).toBe(1)
    expect(p.current).toBe('candidates')
    const values = writes.map(([, v]) => v)
    expect([...values].sort((a, b) => a - b)).toEqual(values)
  })

  it('a highlights-only run that skips extract-audio jumps straight to 10 %', () => {
    const writes: Array<[string, number]> = []
    const p = createStepProgress(ANALYSIS_STEPS.highlights, (step, v) => writes.push([step, v]), () => 0, 0)
    p.step('signals')
    p.update(SIGNALS_STEP_SHARES.loudness)
    p.step('candidates')
    expect(writes).toEqual([['signals', 0.1], ['signals', 0.185], ['candidates', 0.95]])
  })

  it('limits writes to a few per second under a flood of updates', () => {
    const c = clock()
    let count = 0
    const p = createStepProgress(ANALYSIS_STEPS.full, () => count++, c.now, 250)
    p.step('transcribe')
    for (let i = 1; i <= 1000; i++) {
      c.advance(1)
      p.update(i / 1000)
    }
    // One step write plus one write per 250 ms over one second.
    expect(count).toBeLessThanOrEqual(6)
  })

  it('rejects unknown steps', () => {
    const p = createStepProgress(ANALYSIS_STEPS.highlights, () => {}, () => 0, 0)
    expect(() => p.step('transcribe' as never)).toThrow()
  })
})
