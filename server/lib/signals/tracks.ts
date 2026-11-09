// Turning Signals into per-second tracks and combining them (design.md「訊號」).
import { SIGNAL_WEIGHTS } from './types'
import type { NamedTrack, SignalTrack, TranscriptMoment } from './types'

/** Seconds in a track for this duration: ceil(durationSec), or 0 for a missing or invalid duration. */
export function trackLength(durationSec: number): number {
  return Number.isFinite(durationSec) && durationSec > 0 ? Math.ceil(durationSec) : 0
}

/** 0–1, with NaN (and other non-numbers) as 0. */
function clamp01(value: number | undefined): number {
  return value !== undefined && value > 0 ? Math.min(1, value) : 0
}

/**
 * LLM moments → per-second track: each moment's seconds get its score, overlaps take the max.
 * A moment covers every second it touches (index i covers [i, i + 1)); a zero-length moment covers
 * the second it falls in. Scores are clamped to 0–1; moments with non-finite numbers are skipped.
 */
export function momentsTrack(moments: TranscriptMoment[], durationSec: number): SignalTrack {
  const track = new Float32Array(trackLength(durationSec))
  for (const moment of moments) {
    if (![moment.start, moment.end, moment.score].every(Number.isFinite)) continue
    const from = Math.min(moment.start, moment.end)
    const to = Math.max(moment.start, moment.end)
    const first = Math.max(0, Math.floor(from))
    const last = Math.min(track.length - 1, Math.max(Math.floor(from), Math.ceil(to) - 1))
    const score = Math.fround(clamp01(moment.score))
    for (let i = first; i <= last; i++) {
      if (track[i]! < score) track[i] = score
    }
  }
  return track
}

/**
 * Per-second coverage mask: 0 for every second that touches one of `gaps` (as in momentsTrack),
 * 1 elsewhere. Spans with non-finite numbers are skipped.
 */
export function coverageMask(gaps: Array<{ start: number, end: number }>, durationSec: number): Uint8Array {
  const mask = new Uint8Array(trackLength(durationSec)).fill(1)
  for (const gap of gaps) {
    if (!Number.isFinite(gap.start) || !Number.isFinite(gap.end) || gap.end <= gap.start) continue
    const first = Math.max(0, Math.floor(gap.start))
    const last = Math.min(mask.length - 1, Math.ceil(gap.end) - 1)
    for (let i = first; i <= last; i++) mask[i] = 0
  }
  return mask
}

/**
 * Weighted average of the given tracks (SIGNAL_WEIGHTS, renormalised per second over the tracks that
 * cover that second, so a missing signal, or a second a signal has no value for, does not lower the
 * score), then a centred moving average of `smoothSec` seconds. Values are clamped to 0–1 (NaN counts
 * as 0); a track shorter than ceil(durationSec) counts as 0 past its end. No tracks → all zeros.
 */
export function combineTracks(tracks: NamedTrack[], durationSec: number, smoothSec = 5): SignalTrack {
  const length = trackLength(durationSec)
  const sums = new Float64Array(length)
  const weights = new Float64Array(length)
  for (const { kind, values, covered } of tracks) {
    const weight = SIGNAL_WEIGHTS[kind]
    for (let i = 0; i < length; i++) {
      if (covered && covered[i] === 0) continue
      weights[i] = weights[i]! + weight
      if (i < values.length) sums[i] = sums[i]! + weight * clamp01(values[i])
    }
  }
  const combined = new Float64Array(length)
  for (let i = 0; i < length; i++) combined[i] = weights[i]! > 0 ? sums[i]! / weights[i]! : 0
  return movingAverage(combined, smoothSec)
}

/**
 * Centred moving average over `windowSec` values (rounded, at least 1): an odd window has as many
 * values before as after; an even one has one more after. Near the ends only the values that exist
 * are averaged, so a constant track stays constant.
 */
export function movingAverage(values: ArrayLike<number>, windowSec: number): Float32Array {
  const count = values.length
  const window = Number.isFinite(windowSec) ? Math.max(1, Math.round(windowSec)) : 1
  const before = Math.floor((window - 1) / 2)
  const after = window - 1 - before
  const prefix = new Float64Array(count + 1)
  for (let i = 0; i < count; i++) prefix[i + 1] = prefix[i]! + values[i]!
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const lo = Math.max(0, i - before)
    const hi = Math.min(count, i + after + 1)
    out[i] = clamp01((prefix[hi]! - prefix[lo]!) / (hi - lo))
  }
  return out
}
