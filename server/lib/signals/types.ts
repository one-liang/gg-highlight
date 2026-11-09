// Signals: per-second 0–1 values that say how exciting each second is (GLOSSARY: 訊號).
import type { SignalKind } from '../../../shared/types/domain'

/** One value per second (index i covers [i, i + 1) s), each in 0–1. Length = ceil(durationSec). */
export type SignalTrack = Float32Array

export interface NamedTrack {
  kind: SignalKind
  values: SignalTrack
  /**
   * 1 for the seconds this Signal has a value for, 0 where it has none (e.g. an LLM chunk that could
   * not be read): there it is left out of the weighting like a missing Signal. Absent = every second.
   */
  covered?: Uint8Array
}

/** Fixed relative weights (design.md「訊號」); only the tracks present in a run are renormalized. */
export const SIGNAL_WEIGHTS: Readonly<Record<SignalKind, number>> = {
  loudness: 1,
  transcript: 2,
  chat: 1.5,
  heatmap: 2,
}

/** Short-term loudness of the analysis audio, one value per second. */
export interface LoudnessEnvelope {
  /** dBFS of a 3 s window centred on each second; silence is clamped to -100. Length = ceil(duration). */
  db: number[]
}

/** A range the local LLM judged worth clipping, already converted from line numbers to seconds. */
export interface TranscriptMoment {
  start: number
  end: number
  /** 0–1, from the model's 1–10 score as (score - 1) / 9. */
  score: number
  /** One zh-TW sentence (OpenCC-normalised, at most 40 characters). */
  reason: string
}

/** data/videos/<id>/signals.json: cached raw signal results of the last run. */
export interface SignalsFile {
  version: 1
  loudness: LoudnessEnvelope | null
  transcript: { model: string, moments: TranscriptMoment[] } | null
}
