// Sentence snapping for candidate Highlights (design.md「候選精華片段」step 4).
import { EPS, rangeLength } from './ranges'
import type { TimeRange } from './types'

export interface SnapLimits {
  padSec: number
  /** Effective minimum length: min(minSec, durationSec). */
  minLen: number
  maxSec: number
}

/**
 * The segment (ordered by start, not overlapping) holding `sec` as a start (seg.start ≤ sec < seg.end)
 * or as an end (seg.start < sec ≤ seg.end); null in a gap between segments.
 */
export function segmentAt(segments: readonly TimeRange[], sec: number, edge: 'start' | 'end'): TimeRange | null {
  let lo = 0
  let hi = segments.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const start = segments[mid]!.start
    if (edge === 'start' ? start <= sec + EPS : start < sec - EPS) lo = mid + 1
    else hi = mid
  }
  const segment = segments[lo - 1]
  if (!segment) return null
  const inside = edge === 'start' ? sec < segment.end - EPS : sec <= segment.end + EPS
  return inside ? segment : null
}

/**
 * Moves the start of `window` to the start of the segment it falls in and the end to the end of its
 * segment, then pads both by `padSec`, staying inside `bounds` (video edges and occupied ranges).
 * When that is longer than `maxSec`, the partial sentence on the side that reaches further past the
 * window is dropped (cut at its segment boundary), then the one on the other side; a cut never drops
 * the `peak` second. If no cut makes it fit, the window itself is used, padded as far as `maxSec` allows.
 */
export function snapToSentences(
  window: TimeRange,
  peak: TimeRange,
  segments: readonly TimeRange[],
  bounds: TimeRange,
  limits: SnapLimits,
): TimeRange {
  const first = segmentAt(segments, window.start, 'start')
  const last = segmentAt(segments, window.end, 'end')
  let start = first?.start ?? window.start
  let end = last?.end ?? window.end
  const padded = (): TimeRange => ({
    start: Math.max(bounds.start, start - limits.padSec),
    end: Math.min(bounds.end, end + limits.padSec),
  })
  const fits = (range: TimeRange) => rangeLength(range) <= limits.maxSec + EPS && rangeLength(range) >= limits.minLen - EPS

  const outward = padded()
  if (fits(outward)) return outward

  const cutStart = () => {
    if (!first || first.end > peak.start + EPS) return false
    start = first.end
    return true
  }
  const cutEnd = () => {
    if (!last || last.start < peak.end - EPS) return false
    end = last.start
    return true
  }
  const [farCut, nearCut] = window.start - start > end - window.end ? [cutStart, cutEnd] : [cutEnd, cutStart]
  if (farCut()) {
    if (fits(padded())) return padded()
    if (nearCut() && fits(padded())) return padded()
  }
  return paddedWindow(window, bounds, limits)
}

/** The window padded by up to `padSec` on each side without going over `maxSec` or outside `bounds`. */
function paddedWindow(window: TimeRange, bounds: TimeRange, limits: SnapLimits): TimeRange {
  const pad = Math.min(limits.padSec, Math.max(0, limits.maxSec - rangeLength(window)) / 2)
  return { start: Math.max(bounds.start, window.start - pad), end: Math.min(bounds.end, window.end + pad) }
}
