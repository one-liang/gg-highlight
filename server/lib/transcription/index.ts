// Runs the Python transcriber CLI and reads its JSON-lines protocol (see protocol.ts).
import type { Language } from '../../../shared/types/domain'
import type { RawTranscript, TranscriberEvent } from './protocol'

export type { RawSegment, RawTranscript, RawWord, TranscriberEvent } from './protocol'

export interface TranscribeRequest {
  audioPath: string
  language: Language
  outPath: string
  model: string
  device: 'auto' | 'cuda' | 'cpu'
}

export interface TranscribeOptions {
  signal?: AbortSignal
  onProgress?: (progress: number) => void
  onLog?: (message: string) => void
}

/** Parses one stdout line; returns null for blank or non-protocol lines. */
export function parseTranscriberLine(line: string): TranscriberEvent | null {
  throw new Error('not implemented')
}

/**
 * Spawns `[...command, 'transcribe', ...]`, forwards progress/log events, and resolves with the
 * parsed RawTranscript from outPath. Rejects with the CLI's error message (or stderr tail) on failure.
 */
export function runTranscriber(command: string[], request: TranscribeRequest, opts?: TranscribeOptions): Promise<RawTranscript> {
  throw new Error('not implemented')
}

export interface TranscriberCheck {
  python: string
  fasterWhisper: string
  ctranslate2: string
  cudaDevices: number
}

/** Runs `[...command, 'check']`. */
export function checkTranscriber(command: string[]): Promise<TranscriberCheck> {
  throw new Error('not implemented')
}
