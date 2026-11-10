// Candidate Highlight generation (design.md「候選精華片段」).
import type { NamedTrack, TranscriptMoment } from '../signals/types'

export interface TimeRange {
  start: number
  end: number
}

export interface CandidateInput {
  durationSec: number
  /** Transcript segments (sentence boundaries to snap to), ordered by start. May be empty. */
  segments: TimeRange[]
  /** Signals available this run (missing ones are simply absent). */
  tracks: NamedTrack[]
  /** LLM moments, for Highlight Reasons. */
  moments: TranscriptMoment[]
  /** Ranges of Highlights kept from earlier (manual, selected, dismissed, or with clips): candidates never overlap them. */
  occupied: TimeRange[]
}

export interface CandidateOptions {
  /** Shortest candidate; the effective minimum is min(minSec, durationSec). */
  minSec: number
  maxSec: number
  /** Padding around the snapped sentence boundaries. */
  padSec: number
  /** Cap = ceil(hours × perHour). */
  perHour: number
  /**
   * Stop when the best remaining second scores below this. Scaled down when the run's Signal weights
   * add up to more than loudness + transcript (effectiveMinPeak).
   */
  minPeak: number
  /** Expand while the score stays at or above this fraction of the peak. */
  expandRatio: number
  /** Extra gap blocked around each chosen candidate. */
  gapSec: number
  /** Moving-average window applied to the combined score. */
  smoothSec: number
}

export const DEFAULT_CANDIDATE_OPTIONS: Readonly<CandidateOptions> = {
  minSec: 15,
  maxSec: 60,
  padSec: 1,
  perHour: 10,
  minPeak: 0.2,
  expandRatio: 0.6,
  gapSec: 5,
  smoothSec: 5,
}

export interface CandidateDraft {
  start: number
  end: number
  /** Highlight Score 0–1: 0.7 × peak + 0.3 × mean over the range. */
  score: number
  /** Highlight Reason (zh-TW). */
  reason: string
}

/**
 * Reasons used when no LLM moment overlaps a candidate: the one of the Signal with the largest
 * weight × peak value inside the range (design.md「候選精華片段」step 6).
 */
export const LOUDNESS_REASON = '音量突然升高，可能是大叫、爆笑或激動的反應'
export const CHAT_REASON = '聊天室突然熱烈起來'
export const HEATMAP_REASON = '很多觀眾重看這一段（YouTube 重播熱度）'
