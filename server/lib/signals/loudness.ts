import type { LoudnessEnvelope, SignalTrack } from './types'

/**
 * Streams a PCM WAV file (16 kHz mono s16le as written by extractAudio; parse RIFF chunks, do not
 * assume a 44-byte header) and returns its short-term loudness per second (design.md「音量」).
 * Rejects with the abort reason when `signal` aborts.
 */
export async function readLoudnessEnvelope(
  _wavPath: string,
  _opts: { signal?: AbortSignal, onProgress?: (fraction: number) => void } = {},
): Promise<LoudnessEnvelope> {
  throw new Error('not implemented')
}

/** Loudness envelope → 0–1 per second: 3 dB above the ±150 s rolling median starts scoring, 12 dB is 1, below -50 dBFS is 0. */
export function loudnessTrack(_envelope: LoudnessEnvelope, _durationSec: number): SignalTrack {
  throw new Error('not implemented')
}
