import { describe, expect, it } from 'vitest'
import type { Highlight, HighlightStatus } from '../../shared/types/domain'
import {
  countHighlights,
  filterHighlights,
  isOverShortsLimit,
  sortHighlights,
  statusActionLabels,
  statusTransitions,
  upsertHighlight,
  validateHighlightRange,
  validRange,
} from './highlights'

function h(id: string, start: number, end: number, status: HighlightStatus = 'selected'): Highlight {
  return { id, videoId: 'v', start, end, status, origin: 'manual', score: null, reason: null, createdAt: '', updatedAt: '' }
}

describe('ordering and filtering', () => {
  const list = [h('c', 30, 40, 'candidate'), h('a', 10, 20), h('b', 10, 15, 'dismissed')]

  it('sorts by start then end', () => {
    expect(sortHighlights(list).map(x => x.id)).toEqual(['b', 'a', 'c'])
    expect(list[0]!.id).toBe('c')
  })

  it('filters by status', () => {
    expect(filterHighlights(list, 'all')).toHaveLength(3)
    expect(filterHighlights(list, 'selected').map(x => x.id)).toEqual(['a'])
    expect(filterHighlights(list, 'dismissed').map(x => x.id)).toEqual(['b'])
  })

  it('counts by status', () => {
    expect(countHighlights(list)).toEqual({ all: 3, selected: 1, candidate: 1, dismissed: 1 })
  })

  it('upserts keeping order', () => {
    const added = upsertHighlight(list, h('d', 5, 8))
    expect(added.map(x => x.id)).toEqual(['d', 'b', 'a', 'c'])
    const moved = upsertHighlight(added, h('d', 50, 60))
    expect(moved.map(x => x.id)).toEqual(['b', 'a', 'c', 'd'])
    expect(moved).toHaveLength(4)
  })
})

describe('validateHighlightRange', () => {
  it('accepts a valid range', () => {
    expect(validateHighlightRange(10, 20, 100)).toBeNull()
    expect(validateHighlightRange(0, 100, 100)).toBeNull()
    expect(validateHighlightRange(10, 10.5, 100)).toBeNull()
  })

  it('rejects missing values', () => {
    expect(validateHighlightRange(null, 20, 100)).toContain('起點')
    expect(validateHighlightRange(10, null, 100)).toContain('終點')
  })

  it('rejects ranges outside the video', () => {
    expect(validateHighlightRange(100, 110, 100)).toBe('起點超過影片長度（1:40.0）')
    expect(validateHighlightRange(90, 101, 100)).toBe('終點超過影片長度（1:40.0）')
  })

  it('rejects reversed and too-short ranges', () => {
    expect(validateHighlightRange(20, 10, 100)).toBe('終點必須晚於起點')
    expect(validateHighlightRange(20, 20, 100)).toBe('終點必須晚於起點')
    expect(validateHighlightRange(20, 20.4, 100)).toBe('精華片段至少要 0.5 秒')
  })
})

describe('status helpers', () => {
  it('flags ranges longer than Shorts allow', () => {
    expect(isOverShortsLimit(0, 180)).toBe(false)
    expect(isOverShortsLimit(0, 180.1)).toBe(true)
  })

  it('offers the other two statuses', () => {
    expect(statusTransitions('candidate')).toEqual(['selected', 'dismissed'])
    expect(statusTransitions('selected')).toEqual(['dismissed', 'candidate'])
    expect(statusTransitions('dismissed')).toEqual(['selected', 'candidate'])
    expect(statusActionLabels.candidate).toBe('改回候選')
  })

  it('builds a drawable range only when complete', () => {
    expect(validRange(1, 2)).toEqual({ start: 1, end: 2 })
    expect(validRange(null, 2)).toBeNull()
    expect(validRange(3, 2)).toBeNull()
  })
})
