import { describe, expect, it } from 'vitest'
import type { Highlight, HighlightOrigin, HighlightStatus } from '../../shared/types/domain'
import { formatDuration, formatTime, parseTime } from './time'
import {
  countHighlights,
  emptyListText,
  emptyTabText,
  END_SLACK_SECONDS,
  filterHighlights,
  goneHighlightRefs,
  highlightsForTab,
  isOverShortsLimit,
  sortByScore,
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

function scored(id: string, start: number, score: number | null, status: HighlightStatus = 'candidate', origin: HighlightOrigin = 'analysis'): Highlight {
  return { ...h(id, start, start + 20, status), origin, score, reason: score === null ? null : '理由' }
}

describe('tabs', () => {
  const list = [
    scored('low', 10, 0.41),
    scored('manual', 5, null, 'selected', 'manual'),
    scored('top', 300, 0.92),
    scored('mid-late', 200, 0.7),
    scored('mid-early', 100, 0.7),
    scored('picked', 50, 0.88, 'selected'),
    scored('dropped', 20, 0.95, 'dismissed'),
  ]

  it('sorts by Highlight Score, best first; equal scores by start; scoreless last', () => {
    expect(sortByScore(list).map(x => x.id)).toEqual(['dropped', 'top', 'picked', 'mid-early', 'mid-late', 'low', 'manual'])
    expect(list[0]!.id).toBe('low')
  })

  it('orders the 候選 tab by Highlight Score and the other tabs by start', () => {
    expect(highlightsForTab(list, 'candidate').map(x => x.id)).toEqual(['top', 'mid-early', 'mid-late', 'low'])
    expect(highlightsForTab(list, 'all').map(x => x.id)).toEqual(['manual', 'low', 'dropped', 'picked', 'mid-early', 'mid-late', 'top'])
    expect(highlightsForTab(list, 'selected').map(x => x.id)).toEqual(['manual', 'picked'])
    expect(highlightsForTab(list, 'dismissed').map(x => x.id)).toEqual(['dropped'])
  })
})

describe('empty states', () => {
  const idle = { analysisRan: false, analysisActive: false }
  const ran = { analysisRan: true, analysisActive: false }
  const active = { analysisRan: true, analysisActive: true }

  it('explains an empty list', () => {
    expect(emptyListText(idle).title).toBe('還沒有精華片段')
    expect(emptyListText(idle).description).toContain('起點／終點')
    // the analysis ran its candidates step and found nothing
    expect(emptyListText(ran).title).toBe('這次分析沒有找到候選精華片段')
    expect(emptyListText(ran).description).toContain('自己用上方的起點／終點')
    // a highlights-only run is still going
    expect(emptyListText(active).title).toBe('正在找精華片段')
  })

  it('explains an empty 候選 tab when the analysis found nothing', () => {
    const manualOnly = [scored('m', 5, null, 'selected', 'manual')]
    expect(emptyTabText('candidate', manualOnly, ran)).toBe('這次分析沒有找到候選精華片段')
    expect(emptyTabText('candidate', manualOnly, active)).toBe('正在找精華片段，完成後候選會出現在這裡')
    // a milestone-1 video never had candidates
    expect(emptyTabText('candidate', manualOnly, idle)).toBe('沒有「候選」的精華片段')
  })

  it('names the tab when its Highlights were all moved elsewhere', () => {
    const decided = [scored('a', 5, 0.8, 'selected'), scored('b', 50, 0.6, 'dismissed')]
    expect(emptyTabText('candidate', decided, ran)).toBe('沒有「候選」的精華片段')
    expect(emptyTabText('selected', [scored('c', 5, 0.8)], ran)).toBe('沒有「選用」的精華片段')
    expect(emptyTabText('dismissed', [scored('c', 5, 0.8)], ran)).toBe('沒有「捨棄」的精華片段')
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

  it('accepts the rounded length the page shows as the end (it can be above the real length)', () => {
    // 0:17.86 is shown as 0:17.9 (formatTime) and 0:18 (formatDuration in the header)
    expect(validateHighlightRange(1, parseTime(formatTime(17.86)), 17.86)).toBeNull()
    expect(validateHighlightRange(1, parseTime(formatDuration(17.86)), 17.86)).toBeNull()
    // past an hour formatTime drops the tenths: 1:02:05.6 is shown as 1:02:06
    expect(formatTime(3725.6)).toBe('1:02:06')
    expect(validateHighlightRange(3700, 3726, 3725.6)).toBeNull()
    expect(validateHighlightRange(7000, parseTime(formatDuration(7199.7)), 7199.7)).toBeNull()
    expect(validateHighlightRange(1, 17.86 + END_SLACK_SECONDS, 17.86)).toBeNull()
  })

  it('names a length in its messages that it accepts itself', () => {
    expect(validateHighlightRange(1, 18.4, 17.86)).toBe('終點超過影片長度（0:17.8）')
    expect(validateHighlightRange(17.88, 18, 17.86)).toBe('起點超過影片長度（0:17.8）')
    expect(validateHighlightRange(3700, 3727, 3725.6)).toBe('終點超過影片長度（1:02:05.6）')
    for (const duration of [17.86, 59.99, 3725.6, 7199.7, 100]) {
      const message = validateHighlightRange(0, duration + 5, duration)
      const shown = /（(.+)）/.exec(message ?? '')?.[1]
      expect(shown, message ?? '').toBeTruthy()
      expect(validateHighlightRange(0, parseTime(shown!), duration), `${duration}: ${shown}`).toBeNull()
    }
  })

  it('checks the length after clamping an end past the video', () => {
    expect(validateHighlightRange(17.5, 17.9, 17.86)).toBe('精華片段至少要 0.5 秒')
    expect(validateHighlightRange(17.3, 17.9, 17.86)).toBeNull()
  })

  it('accepts every displayed form of every length as the end', () => {
    for (let tenth = 6; tenth < 80_000; tenth += 7) {
      const duration = tenth / 10 + (tenth % 3) * 0.033
      for (const shown of [formatTime(duration), formatDuration(duration)]) {
        expect(validateHighlightRange(0, parseTime(shown), duration), `${duration} shown as ${shown}`).toBeNull()
      }
    }
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
    expect(statusTransitions('dismissed', 'analysis')).toEqual(['selected', 'candidate'])
    expect(statusActionLabels.candidate).toBe('改回候選')
  })

  it('never offers 改回候選 for a manual Highlight (it was never a Candidate)', () => {
    expect(statusTransitions('selected', 'manual')).toEqual(['dismissed'])
    expect(statusTransitions('dismissed', 'manual')).toEqual(['selected'])
    // a manual one stored as candidate (API) can still be decided
    expect(statusTransitions('candidate', 'manual')).toEqual(['selected', 'dismissed'])
  })

  it('builds a drawable range only when complete', () => {
    expect(validRange(1, 2)).toEqual({ start: 1, end: 2 })
    expect(validRange(null, 2)).toBeNull()
    expect(validRange(3, 2)).toBeNull()
  })
})

describe('goneHighlightRefs (a highlights-only run replaced candidates)', () => {
  const list = [{ id: 'kept' }, { id: 'new' }]

  it('flags the Highlight being adjusted, exported or focused when it is no longer listed', () => {
    expect(goneHighlightRefs(list, { editing: 'old', exporting: 'old', focused: 'old' })).toEqual({ editing: true, exporting: true, focused: true })
    expect(goneHighlightRefs([], { editing: 'old', exporting: null, focused: null })).toEqual({ editing: true, exporting: false, focused: false })
  })

  it('leaves references to listed Highlights, and empty ones, alone', () => {
    expect(goneHighlightRefs(list, { editing: 'kept', exporting: 'new', focused: 'kept' })).toEqual({ editing: false, exporting: false, focused: false })
    expect(goneHighlightRefs(list, { editing: null, exporting: null, focused: null })).toEqual({ editing: false, exporting: false, focused: false })
  })
})
