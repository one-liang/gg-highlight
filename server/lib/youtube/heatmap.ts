// Replay heatmap Signal (design.md「重播熱度（heatmap 訊號）」): YouTube's "most replayed" buckets
// from yt-dlp → per-second 0–1 track. Pure functions; the raw markers come from the metadata read.
import type { HeatmapMarker } from '../signals/types'

/** Fewer valid buckets than this cannot be a real heatmap (YouTube sends 100). */
export const HEATMAP_MIN_MARKERS = 10
/** Buckets starting in the first 30 s are capped at the median (replays of the opening are a fake peak). */
export const HEATMAP_START_ARTIFACT_SEC = 30
/** top − median below this: no clear rise anywhere → the Signal is missing (重播熱度沒有明顯起伏). */
export const HEATMAP_MIN_SPREAD = 0.1
/** Relative height (v − m) ÷ (top − m) where scoring starts, and the extra height that reaches 1. */
const SCORE_FROM = 0.3
const SCORE_RANGE = 0.4

export interface ScoredHeatmapBucket {
  start: number
  end: number
  /** 0–1 (design.md step 4). */
  score: number
}

export type HeatmapBuckets =
  /** Fewer than HEATMAP_MIN_MARKERS usable markers. */
  | { kind: 'invalid' }
  /** top − median < HEATMAP_MIN_SPREAD. */
  | { kind: 'flat' }
  /** Valid buckets sorted by start, each with its score. */
  | { kind: 'buckets', buckets: ScoredHeatmapBucket[] }

export type HeatmapTrack =
  | { kind: 'invalid' }
  | { kind: 'flat' }
  /** values/covered have length ceil(durationSec); covered is 0 past the last bucket end + one bucket length. */
  | { kind: 'track', values: Float32Array, covered: Uint8Array }

/**
 * Steps 1–4: drops markers with non-finite fields or end ≤ start, sorts by start, clamps values to
 * 0–1, caps the first bucket and every bucket starting before 30 s at the median of all values, then
 * scores each bucket relative to the new median m and maximum top.
 */
export function scoreHeatmapBuckets(markers: readonly HeatmapMarker[]): HeatmapBuckets {
  const valid = markers
    .filter(m => Number.isFinite(m.start) && Number.isFinite(m.end) && Number.isFinite(m.value) && m.end > m.start)
    .sort((a, b) => a.start - b.start)
  if (valid.length < HEATMAP_MIN_MARKERS) return { kind: 'invalid' }

  const values = valid.map(m => clamp01(m.value))
  const median0 = median(values)
  // As in the reference prototype: bucket 0 is capped too, even if it were to start after 30 s.
  valid.forEach((m, i) => {
    if (i === 0 || m.start < HEATMAP_START_ARTIFACT_SEC) values[i] = Math.min(values[i]!, median0)
  })

  const m = median(values)
  const top = Math.max(...values)
  if (top - m < HEATMAP_MIN_SPREAD) return { kind: 'flat' }
  return {
    kind: 'buckets',
    buckets: valid.map((marker, i) => ({
      start: marker.start,
      end: marker.end,
      score: clamp01(((values[i]! - m) / (top - m) - SCORE_FROM) / SCORE_RANGE),
    })),
  }
}

/**
 * Per-second replay heatmap (design.md step 5): second k takes the value at k + 0.5, linearly
 * interpolated between bucket centres and held flat before the first / after the last centre.
 * Seconds whose position k + 0.5 lies past the last bucket end plus one bucket length (the last
 * bucket's) have no value (covered 0, value 0). No smoothing.
 */
export function heatmapTrack(markers: readonly HeatmapMarker[], durationSec: number): HeatmapTrack {
  const scored = scoreHeatmapBuckets(markers)
  if (scored.kind !== 'buckets') return scored

  const { buckets } = scored
  const length = Number.isFinite(durationSec) && durationSec > 0 ? Math.ceil(durationSec) : 0
  const values = new Float32Array(length)
  const covered = new Uint8Array(length)
  const centres = buckets.map(b => (b.start + b.end) / 2)
  const scores = buckets.map(b => b.score)
  const last = buckets[buckets.length - 1]!
  const lastEnd = Math.max(...buckets.map(b => b.end))
  const coveredUntil = lastEnd + (last.end - last.start)
  const firstCentre = centres[0]!
  const lastCentre = centres[centres.length - 1]!

  let j = 0
  for (let k = 0; k < length; k++) {
    const t = k + 0.5
    if (t > coveredUntil) break // every later second is past it too
    covered[k] = 1
    if (t <= firstCentre) values[k] = scores[0]!
    else if (t >= lastCentre) values[k] = scores[scores.length - 1]!
    else {
      while (centres[j + 1]! < t) j++
      const a = (t - centres[j]!) / (centres[j + 1]! - centres[j]!)
      values[k] = scores[j]! * (1 - a) + scores[j + 1]! * a
    }
  }
  return { kind: 'track', values, covered }
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
