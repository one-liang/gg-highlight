// Runs the Python transcriber CLI and reads its JSON-lines protocol (see protocol.ts).
import fs from 'node:fs/promises'
import type { Language } from '../../../shared/types/domain'
import { failureReason, runCli } from './process'
import type { RawTranscript, TranscriberEvent } from './protocol'
import { parseJsonLine, rawTranscriptSchema, transcriberCheckSchema, transcriberEventSchema } from './schema'

export type { RawSegment, RawTranscript, RawWord, TranscriberEvent } from './protocol'
export { abortError, isAbortError, SPAWN_NOT_FOUND_MESSAGE } from './process'

export interface TranscribeRequest {
  audioPath: string
  language: Language
  outPath: string
  model: string
  device: 'auto' | 'cuda' | 'cpu'
  /** Optional Whisper initial prompt (names, game terms). */
  initialPrompt?: string
}

export interface TranscribeOptions {
  signal?: AbortSignal
  onProgress?: (progress: number) => void
  onLog?: (message: string) => void
}

const FAILURE_PREFIX = '語音辨識失敗：'

/** Parses one stdout line; returns null for blank or non-protocol lines. */
export function parseTranscriberLine(line: string): TranscriberEvent | null {
  const value = parseJsonLine(line)
  if (value === undefined) return null
  const parsed = transcriberEventSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function errorOf(line: string): string | null {
  const event = parseTranscriberLine(line)
  return event?.type === 'error' ? event.message : null
}

function safeCall<T>(fn: ((value: T) => void) | undefined, value: T) {
  if (!fn) return
  try {
    fn(value)
  }
  catch (err) {
    console.warn('[transcription] listener failed:', err)
  }
}

function forwardEvents(opts: TranscribeOptions) {
  return (line: string) => {
    const event = parseTranscriberLine(line)
    if (!event) return
    if (event.type === 'progress') {
      if (Number.isFinite(event.progress)) safeCall(opts.onProgress, Math.min(1, Math.max(0, event.progress)))
    }
    else if (event.type === 'log') {
      safeCall(opts.onLog, event.message)
    }
  }
}

/** Reads and validates a RawTranscript JSON file (transcript.raw.json). */
export async function readRawTranscript(filePath: string): Promise<RawTranscript> {
  let text: string
  try {
    text = await fs.readFile(filePath, 'utf8')
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${FAILURE_PREFIX}轉錄程式沒有產生逐字稿檔案`, { cause: err })
    throw new Error(`${FAILURE_PREFIX}無法讀取逐字稿檔案（${(err as Error).message}）`, { cause: err })
  }
  let value: unknown
  try {
    value = JSON.parse(text.replace(/^﻿/, ''))
  }
  catch (err) {
    throw new Error(`${FAILURE_PREFIX}逐字稿檔案不是正確的 JSON`, { cause: err })
  }
  const parsed = rawTranscriptSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue ? `${issue.path.join('.') || '(root)'}：${issue.message}` : ''
    throw new Error(`${FAILURE_PREFIX}逐字稿檔案格式不正確${where ? `（${where}）` : ''}`, { cause: parsed.error })
  }
  return parsed.data
}

/**
 * Spawns `[...command, 'transcribe', ...]`, forwards progress/log events, and resolves with the
 * parsed RawTranscript from outPath. Rejects with the CLI's error message (or stderr tail) on failure.
 */
export async function runTranscriber(command: string[], request: TranscribeRequest, opts: TranscribeOptions = {}): Promise<RawTranscript> {
  const args = [
    'transcribe',
    '--audio', request.audioPath,
    '--language', request.language,
    '--model', request.model,
    '--device', request.device,
    '--out', request.outPath,
  ]
  // `=` form so a prompt starting with "-" is not taken for an option.
  if (request.initialPrompt) args.push(`--initial-prompt=${request.initialPrompt}`)
  const result = await runCli(command, args, { signal: opts.signal, onLine: forwardEvents(opts), errorOf })
  if (result.code !== 0) throw new Error(`${FAILURE_PREFIX}${failureReason(result)}`)
  return readRawTranscript(request.outPath)
}

export interface TranscriberCheck {
  python: string
  fasterWhisper: string
  ctranslate2: string
  cudaDevices: number
}

/** Runs `[...command, 'check']`. */
export async function checkTranscriber(command: string[]): Promise<TranscriberCheck> {
  const found: { check: TranscriberCheck | null } = { check: null }
  const result = await runCli(command, ['check'], {
    errorOf,
    onLine: (line) => {
      const parsed = transcriberCheckSchema.safeParse(parseJsonLine(line))
      if (parsed.success) {
        const { type: _type, ...info } = parsed.data
        found.check = info
      }
    },
  })
  if (result.code === 0 && found.check) return found.check
  const reason = result.code === 0 ? '沒有輸出檢查結果' : failureReason(result)
  throw new Error(`轉錄程式檢查失敗：${reason}`)
}

/**
 * Runs `[...command, 'download', '--model', model]` and resolves with the local model folder.
 * Lets the UI or setup fetch the multi-GB models before the first Analysis.
 */
export async function downloadTranscriberModel(command: string[], model: string, opts: TranscribeOptions = {}): Promise<string> {
  const found: { output: string | null } = { output: null }
  const forward = forwardEvents(opts)
  const result = await runCli(command, ['download', '--model', model], {
    signal: opts.signal,
    errorOf,
    onLine: (line) => {
      const event = parseTranscriberLine(line)
      if (event?.type === 'done') found.output = event.output
      forward(line)
    },
  })
  if (result.code === 0 && found.output) return found.output
  const reason = result.code === 0 ? '沒有回報模型位置' : failureReason(result)
  throw new Error(`下載語音辨識模型失敗：${reason}`)
}
