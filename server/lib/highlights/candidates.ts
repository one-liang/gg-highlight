// Candidate Highlights from Signals (design.md「候選精華片段」).
import type { SignalKind } from '../../../shared/types/domain'
import { combineTracks } from '../signals/tracks'
import { SIGNAL_WEIGHTS } from '../signals/types'
import type { NamedTrack, SignalTrack, TranscriptMoment } from '../signals/types'
import { cleanRanges, EPS, freeAround, overlaps, rangeLength, roundToTenths, secondsOf } from './ranges'
import { snapToSentences } from './snap'
import type { SnapLimits } from './snap'
import { CHAT_REASON, DEFAULT_CANDIDATE_OPTIONS, HEATMAP_REASON, LOUDNESS_REASON } from './types'
import type { CandidateDraft, CandidateInput, CandidateOptions, TimeRange } from './types'

/** Highlight Score = PEAK_WEIGHT × peak + MEAN_WEIGHT × mean over the range. */
const PEAK_WEIGHT = 0.7
const MEAN_WEIGHT = 0.3
const SECONDS_PER_HOUR = 3600
/** Signal weight total the plain minPeak is meant for: loudness (1) + transcript (2). */
const MIN_PEAK_WEIGHT_TOTAL = 3

/** Signals whose own reason explains a candidate without an LLM moment, in tie-break order. */
const FALLBACK_REASONS: ReadonlyArray<readonly [SignalKind, string]> = [
  ['loudness', LOUDNESS_REASON],
  ['chat', CHAT_REASON],
  ['heatmap', HEATMAP_REASON],
]

interface Limits extends SnapLimits {
  durationSec: number
}

interface ScoredRange extends TimeRange {
  score: number
}

/**
 * Seconds that cannot be used. `kept`: touched by an occupied range, never entered. `near`: inside
 * or within gapSec of a chosen candidate (or an already tried window), no new peak or expansion there.
 */
interface Blocked {
  kept: Uint8Array
  near: Uint8Array
}

/** Pure: combined score → peaks → windows snapped to sentences → capped, non-overlapping candidates, ordered by start. */
export function buildCandidates(input: CandidateInput, options: Partial<CandidateOptions> = {}): CandidateDraft[] {
  const opts: CandidateOptions = { ...DEFAULT_CANDIDATE_OPTIONS, ...options }
  const durationSec = input.durationSec
  if (!Number.isFinite(durationSec) || durationSec <= 0 || input.tracks.length === 0) return []

  // Step 1–2: combined score, cap and length limits.
  const scores = combineTracks(input.tracks, durationSec, opts.smoothSec)
  const cap = candidateCap(durationSec, opts.perHour)
  const limits: Limits = {
    durationSec,
    padSec: opts.padSec,
    minLen: Math.min(opts.minSec, durationSec, opts.maxSec),
    maxSec: opts.maxSec,
  }
  const occupied = cleanRanges(input.occupied, durationSec)
  const segments = cleanRanges(input.segments, durationSec)
  const blocked: Blocked = { kept: new Uint8Array(scores.length), near: new Uint8Array(scores.length) }
  for (const range of occupied) markSeconds(blocked.kept, range)

  const minPeak = effectiveMinPeak(opts.minPeak, input.tracks)
  let chosen: ScoredRange[] = []
  for (const peak of secondsByScore(scores)) {
    const peakScore = scores[peak]!
    if (chosen.length >= cap || peakScore < minPeak || peakScore <= 0) break
    if (blocked.kept[peak] || blocked.near[peak]) continue

    // Step 3: expand around the peak.
    const window = growWindow(scores, peak, blocked, limits, opts.expandRatio)
    markSeconds(blocked.near, window)
    if (rangeLength(window) < limits.minLen - EPS) continue

    // Step 4: snap to sentences, inside the free stretch between occupied ranges.
    const bounds = freeAround(window, occupied, durationSec)
    const peakRange = { start: peak, end: Math.min(peak + 1, durationSec) }
    const range = roundToTenths(snapToSentences(window, peakRange, segments, bounds, limits), bounds, limits.maxSec)
    if (!range) continue

    // Step 5–6: block the surroundings, merge with overlapping candidates, score.
    markSeconds(blocked.near, { start: range.start - opts.gapSec, end: range.end + opts.gapSec })
    chosen = addCandidate(chosen, { ...range, score: rangeScore(scores, range) }, limits.maxSec, scores)
  }

  // Step 7: ordered by start.
  return chosen
    .sort((a, b) => a.start - b.start)
    .map(({ start, end, score }) => ({ start, end, score, reason: reasonFor({ start, end }, input) }))
}

/**
 * Step 3's peak threshold: minPeak × min(1, 3 ÷ total SIGNAL_WEIGHTS of the run's tracks). Loudness and
 * transcript (total 3) keep minPeak; YouTube's extra chat and heatmap lower it, so one Signal's high
 * point is not stopped just because more Signals share the weighting.
 */
export function effectiveMinPeak(minPeak: number, tracks: ReadonlyArray<Pick<NamedTrack, 'kind'>>): number {
  const total = tracks.reduce((sum, track) => sum + SIGNAL_WEIGHTS[track.kind], 0)
  return total > MIN_PEAK_WEIGHT_TOTAL ? minPeak * (MIN_PEAK_WEIGHT_TOTAL / total) : minPeak
}

/** ceil(hours × perHour), at least 1 for any video when perHour > 0. */
export function candidateCap(durationSec: number, perHour: number): number {
  if (!(durationSec > 0) || !(perHour > 0)) return 0
  // The epsilon keeps exact multiples (1 h × 10) from rounding up through floating-point noise.
  return Math.max(1, Math.ceil((durationSec * perHour) / SECONDS_PER_HOUR - 1e-9))
}

/** Highlight Score: 0.7 × peak + 0.3 × mean of `scores` over the seconds the range touches; 0–1, 3 decimals. */
export function rangeScore(scores: SignalTrack, range: TimeRange): number {
  const { first, last } = secondsOf(range, scores.length)
  if (last < first) return 0
  let peak = 0
  let sum = 0
  for (let i = first; i <= last; i++) {
    peak = Math.max(peak, scores[i]!)
    sum += scores[i]!
  }
  const score = PEAK_WEIGHT * peak + (MEAN_WEIGHT * sum) / (last - first + 1)
  return Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000
}

/**
 * Highlight Reason: the reason of the highest-scoring LLM moment overlapping the range (the first on a
 * tie). Without one, the reason of the loudness / chat / heatmap track with the largest weight × peak
 * value inside the range (ties in that order); LOUDNESS_REASON when the run has none of those tracks.
 */
export function reasonFor(range: TimeRange, input: Pick<CandidateInput, 'moments' | 'tracks'>): string {
  let best: TranscriptMoment | null = null
  for (const moment of input.moments) {
    if (!moment.reason.trim() || !Number.isFinite(moment.score)) continue
    const span = { start: Math.min(moment.start, moment.end), end: Math.max(moment.start, moment.end) }
    if (!overlaps(range, span)) continue
    if (!best || moment.score > best.score) best = moment
  }
  if (best) return best.reason.trim()

  let reason = LOUDNESS_REASON
  let bestValue = -1
  for (const [kind, kindReason] of FALLBACK_REASONS) {
    for (const track of input.tracks) {
      if (track.kind !== kind) continue
      const value = SIGNAL_WEIGHTS[kind] * peakIn(track, range)
      if (value > bestValue) {
        bestValue = value
        reason = kindReason
      }
    }
  }
  return reason
}

/** Highest value (clamped to 0–1, NaN as 0) of a track over the seconds the range touches, skipping uncovered seconds; 0 when none. */
function peakIn(track: NamedTrack, range: TimeRange): number {
  const { first, last } = secondsOf(range, track.values.length)
  let peak = 0
  for (let i = first; i <= last; i++) {
    if (track.covered && track.covered[i] === 0) continue
    const value = track.values[i]!
    if (value > peak) peak = Math.min(1, value)
  }
  return peak
}

/** Track indexes from the highest score to the lowest; equal scores keep time order. */
function secondsByScore(scores: SignalTrack): number[] {
  return Array.from(scores.keys()).sort((a, b) => scores[b]! - scores[a]! || a - b)
}

/** Marks the seconds a range touches. */
function markSeconds(seconds: Uint8Array, range: TimeRange): void {
  const { first, last } = secondsOf(range, seconds.length)
  seconds.fill(1, first, Math.max(first, last + 1))
}

/**
 * Step 3: grows [peak, peak + 1) one second at a time toward the higher neighbour while it scores at
 * least expandRatio × peak, is not blocked, and the window stays within maxSec. Shorter than the
 * minimum → keeps growing toward the higher neighbour regardless of score, stopped only by occupied
 * ranges and the video's edges (near seconds are allowed: an overlap is merged later). The result
 * can still be shorter than the minimum when occupied ranges leave too little room.
 */
function growWindow(scores: SignalTrack, peak: number, blocked: Blocked, limits: Limits, expandRatio: number): TimeRange {
  const threshold = scores[peak]! * expandRatio
  let first = peak
  let last = peak
  const span = (from: number, to: number) => Math.min(to + 1, limits.durationSec) - from
  const usable = (i: number, nearOk: boolean) =>
    i >= 0 && i < scores.length && !blocked.kept[i] && (nearOk || !blocked.near[i])
  const grow = (left: boolean) => {
    if (left) first--
    else last++
  }

  for (;;) {
    const canLeft = usable(first - 1, false) && scores[first - 1]! >= threshold && span(first - 1, last) <= limits.maxSec + EPS
    const canRight = usable(last + 1, false) && scores[last + 1]! >= threshold && span(first, last + 1) <= limits.maxSec + EPS
    if (!canLeft && !canRight) break
    grow(growsLeft(scores, peak, first, last, canLeft, canRight))
  }
  while (span(first, last) < limits.minLen - EPS) {
    const canLeft = usable(first - 1, true)
    const canRight = usable(last + 1, true)
    if (!canLeft && !canRight) break
    grow(growsLeft(scores, peak, first, last, canLeft, canRight))
  }
  return { start: first, end: Math.min(last + 1, limits.durationSec) }
}

/** The higher neighbour wins; on a tie the side with fewer seconds so far (keeps the peak centred), then the later side. */
function growsLeft(scores: SignalTrack, peak: number, first: number, last: number, canLeft: boolean, canRight: boolean): boolean {
  if (!canLeft || !canRight) return canLeft
  const left = scores[first - 1]!
  const right = scores[last + 1]!
  if (left !== right) return left > right
  return peak - first < last - peak
}

/**
 * Step 5: adds a candidate, merged with the chosen ones it overlaps. When the merge would be longer
 * than maxSec, only the higher-scoring side is kept (the earlier candidates win a tie).
 */
function addCandidate(chosen: ScoredRange[], candidate: ScoredRange, maxSec: number, scores: SignalTrack): ScoredRange[] {
  const overlapping = chosen.filter(c => overlaps(c, candidate))
  if (overlapping.length === 0) return [...chosen, candidate]
  const rest = chosen.filter(c => !overlapping.includes(c))
  const merged = {
    start: Math.min(candidate.start, ...overlapping.map(c => c.start)),
    end: Math.max(candidate.end, ...overlapping.map(c => c.end)),
  }
  if (rangeLength(merged) <= maxSec + EPS) return [...rest, { ...merged, score: rangeScore(scores, merged) }]
  if (overlapping.every(c => candidate.score > c.score)) return [...rest, candidate]
  return chosen
}
