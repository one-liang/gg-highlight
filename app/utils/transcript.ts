// Transcript helpers for the transcript panel.
import type { TranscriptSegment } from '../../shared/types/domain'

export const MAX_SEGMENT_CHARS = 200

/**
 * Array position of the segment playing at `time` (start <= time < end), or -1.
 * Segments must be sorted by start (they come from the API in order).
 */
export function findSegmentAt(segments: readonly Pick<TranscriptSegment, 'start' | 'end'>[], time: number): number {
  let lo = 0
  let hi = segments.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (segments[mid]!.start <= time) {
      found = mid
      lo = mid + 1
    }
    else {
      hi = mid - 1
    }
  }
  if (found < 0) return -1
  return time < segments[found]!.end ? found : -1
}

export function segmentOverlaps(seg: Pick<TranscriptSegment, 'start' | 'end'>, start: number, end: number): boolean {
  return seg.start < end && seg.end > start
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase()
}

export function searchSegments<T extends Pick<TranscriptSegment, 'text'>>(segments: readonly T[], query: string): T[] {
  const q = normalizeQuery(query)
  if (!q) return segments.slice()
  return segments.filter(s => s.text.toLowerCase().includes(q))
}

export interface TextPart {
  text: string
  match: boolean
}

/** Splits text around case-insensitive matches of `query`, for <mark> rendering. */
export function highlightParts(text: string, query: string): TextPart[] {
  const q = normalizeQuery(query)
  if (!q) return [{ text, match: false }]
  const lower = text.toLowerCase()
  const parts: TextPart[] = []
  let pos = 0
  while (pos < text.length) {
    const hit = lower.indexOf(q, pos)
    if (hit < 0) break
    if (hit > pos) parts.push({ text: text.slice(pos, hit), match: false })
    parts.push({ text: text.slice(hit, hit + q.length), match: true })
    pos = hit + q.length
  }
  if (pos < text.length) parts.push({ text: text.slice(pos), match: false })
  return parts.length ? parts : [{ text, match: false }]
}

/** Segments are single-line: newlines (e.g. from paste) become spaces. */
export function singleLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, ' ')
}

export function validateSegmentText(text: string): string | null {
  const t = text.trim()
  if (!t) return '文字不可空白'
  if (t.length > MAX_SEGMENT_CHARS) return `最多 ${MAX_SEGMENT_CHARS} 字（目前 ${t.length} 字）`
  return null
}

/** Returns a new array with the segment of the same idx replaced. */
export function replaceSegment(segments: readonly TranscriptSegment[], updated: TranscriptSegment): TranscriptSegment[] {
  return segments.map(s => (s.idx === updated.idx ? updated : s))
}
