// Validation of what the Python CLI prints and writes (shapes from protocol.ts).
import { z } from 'zod'
import type { RawTranscript, TranscriberEvent } from './protocol'

export const transcriberEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('progress'), progress: z.number() }),
  z.object({ type: z.literal('log'), message: z.string() }),
  z.object({ type: z.literal('done'), output: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
])

export const transcriberCheckSchema = z.object({
  type: z.literal('check'),
  python: z.string(),
  fasterWhisper: z.string(),
  ctranslate2: z.string(),
  cudaDevices: z.number().int().nonnegative(),
})

const rawWordSchema = z.object({
  start: z.number(),
  end: z.number(),
  word: z.string(),
  probability: z.number(),
})

const rawSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
  words: z.array(rawWordSchema),
  // Added in milestone 2; transcripts written before that have none of them.
  avgLogprob: z.number().optional(),
  noSpeechProb: z.number().optional(),
  compressionRatio: z.number().optional(),
})

export const rawTranscriptSchema = z.object({
  language: z.string(),
  durationSec: z.number(),
  model: z.string(),
  device: z.string(),
  segments: z.array(rawSegmentSchema),
})

// Compile-time check that the schemas produce the protocol types.
type Assert<T extends true> = T
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
export type _EventMatches = Assert<Same<z.infer<typeof transcriberEventSchema>, TranscriberEvent>>
export type _TranscriptMatches = Assert<Same<z.infer<typeof rawTranscriptSchema>, RawTranscript>>

/** Parses a JSON object out of one stdout line. Tolerates a BOM and junk printed before `{"type"`. */
export function parseJsonLine(line: string): unknown {
  const text = line.replace(/^﻿/, '').trim()
  if (!text.includes('{')) return undefined
  const candidates = [text]
  const at = text.indexOf('{"type"')
  if (at > 0) candidates.push(text.slice(at))
  for (const candidate of candidates) {
    if (!candidate.startsWith('{') || !candidate.endsWith('}')) continue
    try {
      return JSON.parse(candidate)
    }
    catch {
      // try the next candidate
    }
  }
  return undefined
}
