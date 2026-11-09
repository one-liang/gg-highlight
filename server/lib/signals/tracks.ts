import type { NamedTrack, SignalTrack, TranscriptMoment } from './types'

/** LLM moments → per-second track: each moment's seconds get its score, overlaps take the max. */
export function momentsTrack(_moments: TranscriptMoment[], _durationSec: number): SignalTrack {
  throw new Error('not implemented')
}

/**
 * Weighted average of the given tracks (SIGNAL_WEIGHTS, renormalised over the tracks given, so a
 * missing signal does not lower the score), then a centred moving average of `smoothSec` seconds.
 */
export function combineTracks(_tracks: NamedTrack[], _durationSec: number, _smoothSec = 5): SignalTrack {
  throw new Error('not implemented')
}
