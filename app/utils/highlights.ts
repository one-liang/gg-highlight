// Highlight helpers: ordering, filtering, range validation.
import { MAX_SHORTS_SECONDS, type Highlight, type HighlightOrigin, type HighlightStatus } from '../../shared/types/domain'
import { highlightStatusLabels } from './labels'
import { formatTimeInput } from './time'

export type HighlightFilter = 'all' | HighlightStatus

export const MIN_HIGHLIGHT_SECONDS = 0.5

/**
 * How far past the video length an end time may be typed. The length is shown rounded (to 0.1 s,
 * to whole seconds past an hour, or as a whole-second duration in the header), so the value the
 * user sees can be up to 0.5 s above the real one. The server accepts the same slack and clamps
 * such an end to the length.
 */
export const END_SLACK_SECONDS = 0.5

export function sortHighlights<T extends Pick<Highlight, 'start' | 'end'>>(list: readonly T[]): T[] {
  return list.slice().sort((a, b) => a.start - b.start || a.end - b.end)
}

/** Highlight Score high to low; scoreless (manual) ones last; ties by start. */
export function sortByScore<T extends Pick<Highlight, 'start' | 'end' | 'score'>>(list: readonly T[]): T[] {
  return list.slice().sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.start - b.start || a.end - b.end)
}

/** One tab of the Highlight list: 候選 by Highlight Score (best first), the others by start. */
export function highlightsForTab<T extends Pick<Highlight, 'start' | 'end' | 'score' | 'status'>>(list: readonly T[], filter: HighlightFilter): T[] {
  const shown = filterHighlights(list, filter)
  return filter === 'candidate' ? sortByScore(shown) : sortHighlights(shown)
}

export interface EmptyText {
  title: string
  description?: string
}

export interface HighlightListState {
  /** The Analysis reached its candidates step at least once (AnalysisState.signals is set). */
  analysisRan: boolean
  /** A highlights-only run is queued or running. */
  analysisActive: boolean
}

const MARK_HINT = '用上方的起點／終點標出想剪的段落；點逐字稿的時間可以快速跳到那裡。'

/** Empty state of the whole list (no Highlights at all). */
export function emptyListText(state: HighlightListState): EmptyText {
  if (state.analysisActive) return { title: '正在找精華片段', description: `完成後候選精華片段會出現在這裡；也可以先${MARK_HINT}` }
  if (state.analysisRan) return { title: '這次分析沒有找到候選精華片段', description: `可以自己${MARK_HINT}` }
  return { title: '還沒有精華片段', description: MARK_HINT }
}

/** Text for a tab with nothing in it while other tabs have Highlights. */
export function emptyTabText(
  filter: HighlightStatus,
  list: readonly Pick<Highlight, 'origin'>[],
  state: HighlightListState,
): string {
  const label = highlightStatusLabels[filter]
  if (filter === 'candidate' && !list.some(h => h.origin === 'analysis')) {
    if (state.analysisActive) return '正在找精華片段，完成後候選會出現在這裡'
    if (state.analysisRan) return '這次分析沒有找到候選精華片段'
  }
  return `沒有「${label}」的精華片段`
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
  // Messages name the length rounded down, so the value they show is itself accepted.
  const shownLength = formatTimeInput(Math.floor(duration * 10) / 10)
  if (duration > 0 && start >= duration) return `起點超過影片長度（${shownLength}）`
  if (duration > 0 && end > duration + END_SLACK_SECONDS) return `終點超過影片長度（${shownLength}）`
  const clampedEnd = duration > 0 ? Math.min(end, duration) : end
  if (clampedEnd <= start) return '終點必須晚於起點'
  if (clampedEnd - start < MIN_HIGHLIGHT_SECONDS) return `精華片段至少要 ${MIN_HIGHLIGHT_SECONDS} 秒`
  return null
}

export function isOverShortsLimit(start: number, end: number): boolean {
  return end - start > MAX_SHORTS_SECONDS
}

export const SHORTS_WARNING = '超過 3 分鐘，可能無法上傳成 Shorts／Reels'

/**
 * Status buttons offered for a Highlight, in display order. A manual Highlight was never a
 * Candidate (only the analysis makes those), so it only switches between 選用 and 捨棄.
 */
export function statusTransitions(status: HighlightStatus, origin: HighlightOrigin = 'analysis'): HighlightStatus[] {
  const all: HighlightStatus[] = status === 'candidate'
    ? ['selected', 'dismissed']
    : status === 'selected' ? ['dismissed', 'candidate'] : ['selected', 'candidate']
  return origin === 'manual' ? all.filter(s => s !== 'candidate') : all
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
