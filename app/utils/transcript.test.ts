import { describe, expect, it } from 'vitest'
import type { TranscriptSegment } from '../../shared/types/domain'
import { findSegmentAt, highlightParts, replaceSegment, searchSegments, segmentOverlaps, singleLine, validateSegmentText } from './transcript'

function seg(idx: number, start: number, end: number, text = `段落 ${idx}`): TranscriptSegment {
  return { idx, start, end, text, edited: false }
}

const segments = [seg(0, 0.5, 2), seg(1, 2, 4.5), seg(2, 6, 8), seg(3, 8, 9.2)]

describe('findSegmentAt', () => {
  it('finds the segment containing the time', () => {
    expect(findSegmentAt(segments, 0.5)).toBe(0)
    expect(findSegmentAt(segments, 1.99)).toBe(0)
    expect(findSegmentAt(segments, 2)).toBe(1)
    expect(findSegmentAt(segments, 7)).toBe(2)
    expect(findSegmentAt(segments, 8)).toBe(3)
  })

  it('returns -1 before, between and after segments', () => {
    expect(findSegmentAt(segments, 0)).toBe(-1)
    expect(findSegmentAt(segments, 5)).toBe(-1)
    expect(findSegmentAt(segments, 9.2)).toBe(-1)
    expect(findSegmentAt([], 1)).toBe(-1)
  })

  it('stays correct on a long transcript', () => {
    const many = Array.from({ length: 5000 }, (_, i) => seg(i, i * 3, i * 3 + 2.5))
    expect(findSegmentAt(many, 3 * 4321 + 1)).toBe(4321)
    expect(findSegmentAt(many, 3 * 4321 + 2.7)).toBe(-1)
  })
})

describe('segmentOverlaps', () => {
  it('uses open intervals', () => {
    expect(segmentOverlaps(seg(0, 2, 4), 3, 10)).toBe(true)
    expect(segmentOverlaps(seg(0, 2, 4), 4, 10)).toBe(false)
    expect(segmentOverlaps(seg(0, 2, 4), 0, 2)).toBe(false)
    expect(segmentOverlaps(seg(0, 2, 4), 2.5, 3)).toBe(true)
  })
})

describe('search', () => {
  const list = [seg(0, 0, 1, '大家好，今天來玩 Minecraft'), seg(1, 1, 2, '這把 minecraft 好難'), seg(2, 2, 3, '結束')]

  it('filters case-insensitively', () => {
    expect(searchSegments(list, 'MINECRAFT').map(s => s.idx)).toEqual([0, 1])
    expect(searchSegments(list, '  ').length).toBe(3)
    expect(searchSegments(list, '不存在')).toEqual([])
  })

  it('splits text around matches', () => {
    expect(highlightParts('這把 minecraft 好難 Minecraft', 'minecraft')).toEqual([
      { text: '這把 ', match: false },
      { text: 'minecraft', match: true },
      { text: ' 好難 ', match: false },
      { text: 'Minecraft', match: true },
    ])
    expect(highlightParts('abc', '')).toEqual([{ text: 'abc', match: false }])
    expect(highlightParts('abc', 'x')).toEqual([{ text: 'abc', match: false }])
    expect(highlightParts('aaa', 'a')).toHaveLength(3)
  })
})

describe('editing', () => {
  it('keeps text single-line', () => {
    expect(singleLine('第一行\n第二行\r\n第三行')).toBe('第一行 第二行 第三行')
  })

  it('validates text', () => {
    expect(validateSegmentText('  ')).toBe('文字不可空白')
    expect(validateSegmentText('好')).toBeNull()
    expect(validateSegmentText('字'.repeat(200))).toBeNull()
    expect(validateSegmentText('字'.repeat(201))).toBe('最多 200 字（目前 201 字）')
  })

  it('replaces a segment by idx without mutating', () => {
    const updated = { ...segments[1]!, text: '改過', edited: true }
    const next = replaceSegment(segments, updated)
    expect(next[1]).toBe(updated)
    expect(next[0]).toBe(segments[0])
    expect(segments[1]!.text).toBe('段落 1')
  })
})
