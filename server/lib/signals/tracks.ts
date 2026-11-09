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
 * Weighted average of the given tracks (SIGNAL_WEIGHTS, renormalised over the tracks given, so a
 * missing signal does not lower the score), then a centred moving average of `smoothSec` seconds.
 * Values are clamped to 0–1 (NaN counts as 0); a track shorter than ceil(durationSec) counts as 0
 * past its end. No tracks → all zeros.
 */
export function combineTracks(tracks: NamedTrack[], durationSec: number, smoothSec = 5): SignalTrack {
  const length = trackLength(durationSec)
  const combined = new Float64Array(length)
  const totalWeight = tracks.reduce((sum, track) => sum + SIGNAL_WEIGHTS[track.kind], 0)
  if (totalWeight > 0) {
    for (const { kind, values } of tracks) {
      const weight = SIGNAL_WEIGHTS[kind] / totalWeight
      const count = Math.min(length, values.length)
      for (let i = 0; i < count; i++) combined[i] = combined[i]! + weight * clamp01(values[i])
    }
  }
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
