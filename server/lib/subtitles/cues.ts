// Transcript segments → clip-relative subtitle cues.
import type { TranscriptSegment } from '../../../shared/types/domain'
import type { Cue } from './types'

/** Pieces shorter than this are not worth showing. */
export const MIN_CUE_SECONDS = 0.2

const round3 = (x: number) => Math.round(x * 1000) / 1000
// Times are rounded to milliseconds; compare durations with a little slack.
const EPS = 1e-6

/**
 * Transcript segments overlapping [start, end] of the source, clamped to the range and shifted
 * so 0 is the clip start. Drops pieces shorter than 0.2 s and empty text.
 */
export function cuesForRange(segments: Array<Pick<TranscriptSegment, 'start' | 'end' | 'text'>>, start: number, end: number): Cue[] {
  if (!(end > start)) return []
  const pieces: Cue[] = []
  for (const seg of segments) {
    const text = (seg.text ?? '').replace(/\s+/gu, ' ').trim()
    if (!text || !(seg.end > start) || !(seg.start < end)) continue
    const s = round3(Math.max(seg.start, start) - start)
    const e = round3(Math.min(seg.end, end) - start)
    if (e - s < MIN_CUE_SECONDS - EPS) continue
    pieces.push({ start: s, end: e, text })
  }
  pieces.sort((a, b) => a.start - b.start || a.end - b.end)

  // Consecutive cues must not overlap: trim the earlier one, or start the later one after it.
  const cues: Cue[] = []
  for (const cue of pieces) {
    const prev = cues[cues.length - 1]
    if (prev && cue.start < prev.end) {
      if (cue.start - prev.start >= MIN_CUE_SECONDS - EPS) {
        prev.end = cue.start
      }
      else if (cue.end - prev.end >= MIN_CUE_SECONDS - EPS) {
        cue.start = prev.end
      }
      else {
        continue
      }
    }
    cues.push(cue)
  }
  return cues
}
