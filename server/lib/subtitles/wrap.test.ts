import { describe, expect, it } from 'vitest'
import { textUnits } from './text'
import { wrapLines } from './wrap'

describe('wrapLines', () => {
  it('keeps text that fits on one line', () => {
    expect(wrapLines('這個遊戲太厲害了', 13)).toEqual(['這個遊戲太厲害了'])
    expect(wrapLines('Good game, well played.', 13)).toEqual(['Good game, well played.'])
    expect(wrapLines('一二三四五六七八九十一二三', 13)).toEqual(['一二三四五六七八九十一二三'])
  })

  it('returns no lines for empty text and collapses whitespace', () => {
    expect(wrapLines('', 13)).toEqual([])
    expect(wrapLines('   ', 13)).toEqual([])
    expect(wrapLines('  好\n  啊  ', 13)).toEqual(['好 啊'])
  })

  it('balances CJK text over two lines', () => {
    expect(wrapLines('一二三四五六七八九十一二三四五六七八九十', 13)).toEqual(['一二三四五六七八九十', '一二三四五六七八九十'])
    // Uneven: the top line is the shorter one.
    expect(wrapLines('一二三四五六七八九十一二三四五', 13)).toEqual(['一二三四五六七', '八九十一二三四五'])
  })

  it('prefers breaking at a space when that is about as balanced', () => {
    expect(wrapLines('這個遊戲太厲害了 我們再來一局吧好不好', 13)).toEqual(['這個遊戲太厲害了', '我們再來一局吧好不好'])
  })

  it('breaks latin text only at spaces', () => {
    const text = 'Hello everyone, welcome back to the stream. Today we play'
    const lines = wrapLines(text, 26)
    expect(lines).toEqual(['Hello everyone, welcome back', 'to the stream. Today we play'])
    expect(lines.join(' ')).toBe(text)
  })

  it('never splits a latin word inside mixed text', () => {
    const lines = wrapLines('我用 iPhone 15 Pro Max 拍的影片真的超級清楚的啦', 13)
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(textUnits(line)).toBeLessThanOrEqual(13)
    expect(lines.join('').replace(/\s/g, '')).toBe('我用iPhone15ProMax拍的影片真的超級清楚的啦')
    for (const word of ['iPhone', 'Pro', 'Max']) expect(lines.some(l => l.includes(word))).toBe(true)
  })

  it('does not start a line with closing punctuation or end one with opening punctuation', () => {
    // The most balanced cut would put 」 at the start of the second line.
    const closing = wrapLines('甲乙丙丁戊己庚辛壬癸」子丑寅卯辰巳午未', 10)
    expect(closing).toEqual(['甲乙丙丁戊己庚辛壬', '癸」子丑寅卯辰巳午未'])
    const question = wrapLines('一二三四五六七八九？十一二三四五六七八', 10)
    expect(question.every(l => !l.startsWith('？'))).toBe(true)
    expect(question).toEqual(['一二三四五六七八九？', '十一二三四五六七八'])
    // The most balanced cut would leave 「 at the end of the first line.
    const opening = wrapLines('甲乙丙丁戊己庚辛壬「子丑寅卯辰巳午未申', 10)
    expect(opening.every(l => !l.endsWith('「'))).toBe(true)
    expect(opening).toEqual(['甲乙丙丁戊己庚辛壬', '「子丑寅卯辰巳午未申'])
  })

  it('never returns more than maxLines lines', () => {
    const long = '一二三四五六七八九十'.repeat(5)
    const two = wrapLines(long, 13)
    expect(two).toHaveLength(2)
    expect(two.map(textUnits)).toEqual([25, 25])
    const three = wrapLines(long, 13, 3)
    expect(three).toHaveLength(3)
    expect(Math.max(...three.map(textUnits))).toBe(17)
    expect(three.join('')).toBe(long)
    expect(wrapLines(long, 13, 1)).toEqual([long])
  })

  it('uses the fewest lines that fit', () => {
    const text = '一二三四五六七八九十一二三四五六七八九十'
    expect(wrapLines(text, 13, 4)).toHaveLength(2)
    expect(wrapLines(text, 7, 4)).toHaveLength(3)
  })

  it('leaves a single unbreakable word alone', () => {
    expect(wrapLines('Supercalifragilisticexpialidocious', 8)).toEqual(['Supercalifragilisticexpialidocious'])
  })
})
