// Highlight helpers: ordering, filtering, range validation.
import { MAX_SHORTS_SECONDS, type Highlight, type HighlightStatus } from '../../shared/types/domain'
import { formatTime } from './time'

export type HighlightFilter = 'all' | HighlightStatus

export const MIN_HIGHLIGHT_SECONDS = 0.5

export function sortHighlights<T extends Pick<Highlight, 'start' | 'end'>>(list: readonly T[]): T[] {
  return list.slice().sort((a, b) => a.start - b.start || a.end - b.end)
}

export function filterHighlights<T extends Pick<Highlight, 'status'>>(list: readonly T[], filter: HighlightFilter): T[] {
  return filter === 'all' ? list.slice() : list.filter(h => h.status === filter)
}

export function countHighlights(list: readonly Pick<Highlight, 'status'>[]): Record<HighlightFilter, number> {
  const counts: Record<HighlightFilter, number> = { all: list.length, candidate: 0, selected: 0, dismissed: 0 }
  for (const h of list) counts[h.status]++
  return counts
}

/** Inserts or replaces by id, keeping start order. */
export function upsertHighlight(list: readonly Highlight[], h: Highlight): Highlight[] {
  const others = list.filter(x => x.id !== h.id)
  return sortHighlights([...others, h])
}

/** Error text for a range the user typed, or null when it can be saved. */
export function validateHighlightRange(start: number | null, end: number | null, duration: number): string | null {
  if (start === null) return '請輸入起點，例如 1:23.4'
  if (end === null) return '請輸入終點，例如 1:45.0'
  if (start < 0) return '起點不可小於 0'
  if (duration > 0 && start >= duration) return `起點超過影片長度（${formatTime(duration)}）`
  if (duration > 0 && end > duration + 0.001) return `終點超過影片長度（${formatTime(duration)}）`
  if (end <= start) return '終點必須晚於起點'
  if (end - start < MIN_HIGHLIGHT_SECONDS) return `精華片段至少要 ${MIN_HIGHLIGHT_SECONDS} 秒`
  return null
}

export function isOverShortsLimit(start: number, end: number): boolean {
  return end - start > MAX_SHORTS_SECONDS
}

export const SHORTS_WARNING = '超過 3 分鐘，可能無法上傳成 Shorts／Reels'

/** Status buttons offered for a Highlight, in display order. */
export function statusTransitions(status: HighlightStatus): HighlightStatus[] {
  switch (status) {
    case 'candidate': return ['selected', 'dismissed']
    case 'selected': return ['dismissed', 'candidate']
    case 'dismissed': return ['selected', 'candidate']
  }
}

export const statusActionLabels: Record<HighlightStatus, string> = {
  selected: '選用',
  dismissed: '捨棄',
  candidate: '改回候選',
}

/** A range is only drawn / used for marking once both ends are valid. */
export function validRange(start: number | null, end: number | null): { start: number, end: number } | null {
  if (start === null || end === null || end <= start) return null
  return { start, end }
}
