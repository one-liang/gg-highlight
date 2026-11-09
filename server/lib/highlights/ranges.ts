// Time-range helpers for candidate Highlights (seconds, floating point).
import type { TimeRange } from './types'

/** Tolerance for comparing seconds computed in floating point. */
export const EPS = 1e-6

export function rangeLength(range: TimeRange): number {
  return range.end - range.start
}

/** Strict overlap: ranges that only touch do not overlap. */
export function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end - EPS && b.start < a.end - EPS
}

/** Finite ranges with start ≤ end (reversed ones swapped), clipped to [0, durationSec], non-empty, sorted by start. */
export function cleanRanges(ranges: readonly TimeRange[], durationSec: number): TimeRange[] {
  const out: TimeRange[] = []
  for (const range of ranges) {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) continue
    const start = Math.max(0, Math.min(range.start, range.end))
    const end = Math.min(durationSec, Math.max(range.start, range.end))
    if (end > start) out.push({ start, end })
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end)
}

/** The free stretch around `inner` (which overlaps none of `taken`): from the nearest taken range or video edge on each side. */
export function freeAround(inner: TimeRange, taken: readonly TimeRange[], durationSec: number): TimeRange {
  let start = 0
  let end = durationSec
  for (const range of taken) {
    if (range.end <= inner.start + EPS) start = Math.max(start, range.end)
    else if (range.start >= inner.end - EPS) end = Math.min(end, range.start)
  }
  return { start, end }
}

/** Track indexes (second i covers [i, i + 1)) that a range touches, clipped to the track; last < first when none. */
export function secondsOf(range: TimeRange, trackLength: number): { first: number, last: number } {
  return {
    first: Math.max(0, Math.floor(range.start + EPS)),
    last: Math.min(trackLength - 1, Math.ceil(range.end - EPS) - 1),
  }
}

const floorTenth = (sec: number) => Math.floor(sec * 10 + EPS) / 10
const ceilTenth = (sec: number) => Math.ceil(sec * 10 - EPS) / 10

/**
 * Rounds a range outward to 0.1 s (so it never gets shorter), but keeps it inside `bounds` and no
 * longer than `maxSec`. Null when nothing is left.
 */
export function roundToTenths(range: TimeRange, bounds: TimeRange, maxSec: number): TimeRange | null {
  let start = floorTenth(range.start)
  if (start < bounds.start - EPS) start = ceilTenth(bounds.start)
  let end = ceilTenth(range.end)
  if (end > bounds.end + EPS) end = floorTenth(bounds.end)
  if (end - start > maxSec + EPS) end = floorTenth(start + maxSec)
  return end - start > EPS ? { start, end } : null
}
