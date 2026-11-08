import { describe, expect, it } from 'vitest'
import { cuesForRange } from './cues'

const s = (start: number, end: number, text: string) => ({ start, end, text })

describe('cuesForRange', () => {
  it('keeps overlapping segments, clamps them and shifts the clip start to 0', () => {
    const segments = [s(0, 2, '一'), s(2, 5, '二'), s(5, 9, '三'), s(9, 12, '四')]
    expect(cuesForRange(segments, 3, 6)).toEqual([s(0, 2, '二'), s(2, 3, '三')])
  })

  it('returns whole segments inside the range unchanged apart from the shift', () => {
    expect(cuesForRange([s(10.5, 12.25, '好')], 10, 20)).toEqual([s(0.5, 2.25, '好')])
  })

  it('rounds away floating-point noise from the shift', () => {
    expect(cuesForRange([s(12.3, 13.7, '好')], 10.1, 20)).toEqual([s(2.2, 3.6, '好')])
  })

  it('drops pieces shorter than 0.2 s and segments that only touch the range', () => {
    const segments = [s(0, 3.1, '尾巴'), s(3.1, 5, '中間'), s(5, 5.15, '太短'), s(5.9, 8, '開頭'), s(8, 9, '外面')]
    expect(cuesForRange(segments, 3, 6)).toEqual([s(0.1, 2, '中間')])
    expect(cuesForRange([s(1, 2, '前')], 2, 4)).toEqual([])
    expect(cuesForRange([s(4, 5, '後')], 2, 4)).toEqual([])
    // Exactly 0.2 s is kept.
    expect(cuesForRange([s(1.3, 1.5, '剛好')], 0, 4)).toEqual([s(1.3, 1.5, '剛好')])
  })

  it('drops empty text and collapses whitespace', () => {
    expect(cuesForRange([s(0, 1, ''), s(1, 2, '   '), s(2, 3, '  好\n啊 ')], 0, 10)).toEqual([s(2, 3, '好 啊')])
  })

  it('sorts its input', () => {
    expect(cuesForRange([s(3, 4, 'b'), s(1, 2, 'a')], 0, 10)).toEqual([s(1, 2, 'a'), s(3, 4, 'b')])
  })

  it('makes overlapping cues consecutive', () => {
    expect(cuesForRange([s(0, 3, 'a'), s(2, 5, 'b')], 0, 10)).toEqual([s(0, 2, 'a'), s(2, 5, 'b')])
    // Trimming the first one would leave 0.1 s, so the second one starts later instead.
    expect(cuesForRange([s(1, 3, 'a'), s(1.1, 4, 'b')], 0, 10)).toEqual([s(1, 3, 'a'), s(3, 4, 'b')])
    // A duplicate that cannot be placed is dropped.
    expect(cuesForRange([s(1, 3, 'a'), s(1, 3, 'a2')], 0, 10)).toEqual([s(1, 3, 'a')])
  })

  it('returns nothing for an empty or inverted range', () => {
    expect(cuesForRange([s(0, 5, 'a')], 2, 2)).toEqual([])
    expect(cuesForRange([s(0, 5, 'a')], 3, 1)).toEqual([])
    expect(cuesForRange([], 0, 10)).toEqual([])
  })

  it('never returns overlapping or too short cues', () => {
    const segments = Array.from({ length: 50 }, (_, i) => s(i * 0.37, i * 0.37 + 0.2 + (i % 7) * 0.3, `第${i}句`))
    const cues = cuesForRange(segments, 1, 15)
    expect(cues.length).toBeGreaterThan(10)
    for (const [k, c] of cues.entries()) {
      expect(c.start).toBeGreaterThanOrEqual(0)
      expect(c.end).toBeLessThanOrEqual(14)
      expect(c.end - c.start).toBeGreaterThanOrEqual(0.2 - 1e-9)
      if (k > 0) expect(c.start).toBeGreaterThanOrEqual(cues[k - 1]!.end)
    }
  })
})
