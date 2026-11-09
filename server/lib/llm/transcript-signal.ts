// The transcript Signal: the local LLM reads the Transcript in chunks and names highlight line ranges
// (design.md「訊號」→ 逐字稿, ADR-0002). Line numbers become seconds here, never in the model.
import { z } from 'zod'
import { type Language, type SignalState, TRANSCRIPT_SIGNAL_EMPTY_REASON } from '../../../shared/types/domain'
import type { TranscriptMoment } from '../signals/types'
import { toTaiwanTraditional } from '../subtitles'
import { chatStream, describeOllamaProbe, OllamaError, OllamaStreamError, OllamaTimeoutError, probeOllama, unloadModel } from './ollama'
import type { ChatMessage, ChatRequest } from './ollama'
import type { OllamaConfig, ReadTranscriptOptions, TimeSpan, TranscriptLine, TranscriptSignalResult } from './types'

export const CHUNK_WINDOW_SEC = 600
export const CHUNK_OVERLAP_SEC = 60
/**
 * Safety cap on the text of one chunk so prompt + answer stay inside num_ctx 16384 even when edited
 * segments are long (10 minutes of dense speech is about 3,000 Chinese characters).
 */
export const CHUNK_MAX_CHARS = 12_000
export const MAX_HIGHLIGHTS_PER_CHUNK = 5
export const MAX_REASON_CHARS = 40
/** Highlights the model scores below this (1–10) are dropped. */
export const MIN_SCORE = 6
export const CHUNK_TIMEOUT_MS = 10 * 60_000
/** On cancel, wait at most this long for the unload reply so cancelling stays quick. */
const ABORT_UNLOAD_TIMEOUT_MS = 1000
/**
 * How long Ollama keeps the model loaded after a request. Chunk requests go back to back, so the model
 * never expires mid-run; if the app dies before its unload (window closed mid-step), the ~7 GB leave
 * the 8 GB card after a minute instead of competing with the next game, OBS or transcription.
 */
export const KEEP_ALIVE = '1m'
/** Sampling options for every chunk; num_ctx never changes so Ollama never reloads the model. */
export const CHAT_OPTIONS = Object.freeze({
  num_ctx: 16384,
  temperature: 0.2,
  top_p: 0.8,
  top_k: 20,
  presence_penalty: 0,
  num_predict: 768,
  seed: 42,
})
const FALLBACK_REASON = 'AI 判斷這段很精彩'

/** A run of consecutive Transcript lines sent to the model in one request. */
export interface TranscriptChunk {
  /** 0-based index of `lines[0]` among the non-blank Transcript lines. */
  firstLine: number
  lines: TranscriptLine[]
}

/**
 * Splits the Transcript into windows of `windowSec` that overlap the previous one by `overlapSec`
 * (by line start time). Blank lines are left out. A window also ends early after `maxChars` of text.
 */
export function chunkTranscript(
  lines: TranscriptLine[],
  opts: { windowSec?: number, overlapSec?: number, maxChars?: number } = {},
): TranscriptChunk[] {
  const windowSec = opts.windowSec ?? CHUNK_WINDOW_SEC
  const overlapSec = opts.overlapSec ?? CHUNK_OVERLAP_SEC
  const maxChars = opts.maxChars ?? CHUNK_MAX_CHARS
  const content = lines.filter(line => line.text.trim() !== '')
  const chunks: TranscriptChunk[] = []
  let first = 0
  while (first < content.length) {
    const windowEnd = content[first]!.start + windowSec
    let next = first
    let chars = 0
    while (next < content.length && content[next]!.start < windowEnd) {
      chars += content[next]!.text.length
      if (next > first && chars > maxChars) break
      next++
    }
    chunks.push({ firstLine: first, lines: content.slice(first, next) })
    if (next >= content.length) break
    // The next window starts `overlapSec` before this one ended, but always moves forward.
    const cutAt = Math.min(windowEnd, content[next]!.start) - overlapSec
    let start = first + 1
    while (start < next && content[start]!.start < cutAt) start++
    first = start
  }
  return chunks
}

const SYSTEM_PROMPT = [
  '你是遊戲實況的剪輯助手。使用者會給你一段實況逐字稿，每行格式是「行號|文字」。逐字稿是語音辨識產生的，會有錯字或重複的字。',
  '任務：找出最值得剪成 15 到 60 秒短影片的精彩片段，例如：大笑、尖叫或驚呼、失誤或逆轉、互相鬥嘴、過關或勝利、好笑的對話。',
  '不要選：打招呼、閒聊、等待、念聊天室或感謝訂閱、講解設定或技術細節、沒有反應的平淡內容。',
  '規則：',
  '1. 用 startLine 與 endLine（包含）表示片段，只能用這段逐字稿裡的行號，startLine 不可大於 endLine。',
  `2. 片段之間不可重疊，最多 ${MAX_HIGHLIGHTS_PER_CHUNK} 個；這段沒有精彩內容就回傳空陣列。`,
  `3. score 是 1 到 10 的整數：9–10 是整場最精彩，7–8 值得剪，${MIN_SCORE} 是可以考慮；${MIN_SCORE - 1} 分以下（含 ${MIN_SCORE - 1} 分）不要回傳。`,
  '4. reason 用一句台灣繁體中文（正體字，不要簡體字），20 字以內，說明這段為什麼好看。',
  '只輸出 JSON，格式：{"highlights":[{"startLine":起始行號,"endLine":結束行號,"reason":"一句理由","score":分數}]}',
].join('\n')

const ENGLISH_NOTE = '這段實況說的是英文，逐字稿也是英文；reason 仍然用台灣繁體中文。'

/** System prompt (constant, so Ollama can reuse its cache) and the chunk as numbered 'n|text' lines. */
export function buildChunkMessages(chunk: TranscriptChunk, language?: Language): ChatMessage[] {
  const n = chunk.lines.length
  const numbered = chunk.lines.map((line, i) => `${i + 1}|${line.text.replace(/\s+/gu, ' ').trim()}`)
  return [
    { role: 'system', content: language === 'en' ? `${SYSTEM_PROMPT}\n${ENGLISH_NOTE}` : SYSTEM_PROMPT },
    { role: 'user', content: [`以下是逐字稿，共 ${n} 行（行號 1 到 ${n}）：`, ...numbered].join('\n') },
  ]
}

/** JSON schema for Ollama's `format`: llama.cpp's grammar enforces the ranges, lengths and key order. */
export function chunkSchema(lineCount: number) {
  const line = { type: 'integer', minimum: 1, maximum: Math.max(1, lineCount) }
  return {
    type: 'object',
    properties: {
      highlights: {
        type: 'array',
        maxItems: MAX_HIGHLIGHTS_PER_CHUNK,
        items: {
          type: 'object',
          properties: {
            startLine: line,
            endLine: line,
            // reason before score: the model explains first, then scores.
            reason: { type: 'string', maxLength: MAX_REASON_CHARS },
            score: { type: 'integer', minimum: 1, maximum: 10 },
          },
          required: ['startLine', 'endLine', 'reason', 'score'],
        },
      },
    },
    required: ['highlights'],
  }
}

/** The model's answer did not have the expected shape (worth one retry). */
export class ChunkResponseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ChunkResponseError'
  }
}

const responseSchema = z.object({
  highlights: z.array(z.object({
    startLine: z.number(),
    endLine: z.number(),
    reason: z.string(),
    score: z.number(),
  })),
})

const QUOTES_AND_BRACKETS = /["'`“”‘’「」『』《》〈〉【】〔〕〖〗（）()［］[\]{}｛｝<>＜＞]/gu
const SENTENCE_END = /[。！？!?；;…\n\r]|\.(?=\s|$)/u
const EDGE_PUNCTUATION = /^[\s，,、：:—-]+|[\s，,、：:—-]+$/gu

/** OpenCC → Taiwan Traditional, no quotes or brackets, first sentence only, at most 40 characters. */
export function cleanReason(raw: string): string {
  const text = toTaiwanTraditional(raw).replace(QUOTES_AND_BRACKETS, '')
  const sentence = text.split(SENTENCE_END).map(s => s.replace(EDGE_PUNCTUATION, '')).find(s => s !== '') ?? ''
  const clipped = Array.from(sentence).slice(0, MAX_REASON_CHARS).join('').replace(EDGE_PUNCTUATION, '')
  return clipped || FALLBACK_REASON
}

/**
 * Validates the model's JSON and converts line ranges to TranscriptMoments: reversed ranges are
 * swapped, line numbers clamped to the chunk, scores below MIN_SCORE dropped, score → (s − 1) / 9.
 * Throws ChunkResponseError when the content is not the expected JSON.
 */
export function parseChunkResponse(content: string, chunk: TranscriptChunk): TranscriptMoment[] {
  let value: unknown
  try {
    value = JSON.parse(content)
  }
  catch (err) {
    throw new ChunkResponseError('回應不是正確的 JSON', { cause: err })
  }
  const parsed = responseSchema.safeParse(value)
  if (!parsed.success) throw new ChunkResponseError('回應的 JSON 欄位不對', { cause: parsed.error })

  const n = chunk.lines.length
  if (n === 0) return []
  const clampLine = (v: number) => Math.min(n, Math.max(1, Math.round(v)))
  const moments: TranscriptMoment[] = []
  for (const h of parsed.data.highlights) {
    const score = Math.min(10, Math.max(1, Math.round(h.score)))
    if (score < MIN_SCORE) continue
    let from = clampLine(h.startLine)
    let to = clampLine(h.endLine)
    if (from > to) [from, to] = [to, from]
    moments.push({
      start: chunk.lines[from - 1]!.start,
      end: chunk.lines[to - 1]!.end,
      score: (score - 1) / 9,
      reason: cleanReason(h.reason),
    })
  }
  return moments
}

/**
 * Removes exact duplicates (same start and end, e.g. one event reported by two overlapping chunks
 * with the same lines), keeping the higher score (the earlier one on a tie); sorted by start.
 * Overlapping moments are all kept: momentsTrack takes the maximum per second and the candidates
 * step picks the best-scoring reason, so a range cut off at a chunk edge never hides the full one.
 */
export function dedupeMoments(moments: TranscriptMoment[]): TranscriptMoment[] {
  const best = new Map<string, TranscriptMoment>()
  for (const moment of moments) {
    const key = `${moment.start}|${moment.end}`
    const seen = best.get(key)
    if (!seen || moment.score > seen.score) best.set(key, moment)
  }
  return [...best.values()].sort((a, b) => a.start - b.start || a.end - b.end)
}

/** From the first line's start to the latest line end of a chunk. */
function chunkSpan(chunk: TranscriptChunk): TimeSpan {
  return { start: chunk.lines[0]!.start, end: Math.max(...chunk.lines.map(line => line.end)) }
}

/** The parts of `spans` outside every span of `minus`, sorted and merged. */
export function subtractSpans(spans: TimeSpan[], minus: TimeSpan[]): TimeSpan[] {
  const out: TimeSpan[] = []
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    let pieces: TimeSpan[] = [{ ...span }]
    for (const cut of minus) {
      pieces = pieces.flatMap((p) => {
        if (cut.end <= p.start || cut.start >= p.end) return [p]
        return [{ start: p.start, end: cut.start }, { start: cut.end, end: p.end }].filter(q => q.end > q.start)
      })
    }
    for (const p of pieces) {
      const last = out.at(-1)
      if (last && p.start <= last.end) last.end = Math.max(last.end, p.end)
      else out.push(p)
    }
  }
  return out
}

/** Short zh-TW cause of a chunk failure, for logs and the 'missing' reason. */
export function describeChunkFailure(err: unknown, config: OllamaConfig): string {
  if (err instanceof OllamaTimeoutError) return '回應逾時'
  if (err instanceof ChunkResponseError) return err.message
  if (err instanceof OllamaError) return `Ollama 回應錯誤（HTTP ${err.status}）：${err.message.slice(0, 80)}`
  if (err instanceof OllamaStreamError) return '回應中斷'
  if (err instanceof TypeError && err.message === 'fetch failed') return `連不到 Ollama（${config.url}）`
  return (err instanceof Error ? err.message : String(err)).slice(0, 80) || '未知錯誤'
}

interface ChunkContext {
  config: OllamaConfig
  signal: AbortSignal
  timeoutMs: number
  language?: Language
  fetch?: typeof fetch
  log: (message: string) => void
  label: string
}

/** One chunk: ask at temperature 0.2, retry once at 0; rethrows the job signal's reason on abort. */
async function readChunk(chunk: TranscriptChunk, ctx: ChunkContext): Promise<TranscriptMoment[]> {
  const messages = buildChunkMessages(chunk, ctx.language)
  const format = chunkSchema(chunk.lines.length)
  let lastError: unknown
  for (const temperature of [CHAT_OPTIONS.temperature, 0]) {
    const body: ChatRequest = { messages, format, think: false, options: { ...CHAT_OPTIONS, temperature }, keep_alive: KEEP_ALIVE }
    try {
      const { content, doneReason } = await chatStream(ctx.config, body, { signal: ctx.signal, timeoutMs: ctx.timeoutMs, fetch: ctx.fetch })
      if (doneReason === 'length') throw new ChunkResponseError('回應太長被截斷')
      return parseChunkResponse(content, chunk)
    }
    catch (err) {
      if (ctx.signal.aborted) throw ctx.signal.reason
      lastError = err
      if (temperature !== 0) ctx.log(`AI 讀逐字稿：${ctx.label}讀取失敗（${describeChunkFailure(err, ctx.config)}），用 temperature 0 重試`)
    }
  }
  throw lastError
}

function safeCall<T>(fn: ((value: T) => void) | undefined, value: T) {
  if (!fn) return
  try {
    fn(value)
  }
  catch (err) {
    console.warn('[llm] listener failed:', err)
  }
}

function signalState(status: SignalState['status'], reason: string | null): SignalState {
  return { kind: 'transcript', status, reason }
}

/**
 * Probes Ollama, splits the Transcript into 10-minute chunks (60 s overlap), asks the model for
 * highlight line ranges per chunk (structured output), converts them to TranscriptMoments and always
 * unloads the model at the end. Resolves with state 'missing' (and a zh-TW reason) when Ollama is
 * disabled, unreachable, outdated, lacks the model, or every chunk failed. Rejects only when
 * `opts.signal` aborts.
 */
export async function readTranscriptWithLlm(
  config: OllamaConfig,
  lines: TranscriptLine[],
  opts: ReadTranscriptOptions,
): Promise<TranscriptSignalResult> {
  const { signal } = opts
  const log = (message: string) => safeCall(opts.log, message)
  const progress = (fraction: number) => safeCall(opts.onProgress, fraction)
  const missing = (reason: string): TranscriptSignalResult => {
    progress(1)
    return { state: signalState('missing', reason), moments: [], unread: [], model: config.model }
  }

  signal.throwIfAborted()
  if (!config.url) return missing(describeOllamaProbe(config, { status: 'disabled', version: null })!)
  const chunks = chunkTranscript(lines)
  if (chunks.length === 0) return missing(TRANSCRIPT_SIGNAL_EMPTY_REASON)

  const probe = await probeOllama(config, { signal, fetch: opts.fetch })
  signal.throwIfAborted()
  const notReady = describeOllamaProbe(config, probe)
  if (notReady) {
    log(`AI 讀逐字稿：${notReady}`)
    return missing(notReady)
  }

  log(`AI 讀逐字稿：Ollama ${probe.version}、模型 ${config.model}，逐字稿分成 ${chunks.length} 段`)
  progress(0)
  const moments: TranscriptMoment[] = []
  const failures: string[] = []
  const read: TimeSpan[] = []
  const skipped: TimeSpan[] = []
  try {
    for (const [i, chunk] of chunks.entries()) {
      const label = `第 ${i + 1}/${chunks.length} 段`
      try {
        const found = await readChunk(chunk, {
          config, signal, timeoutMs: opts.chunkTimeoutMs ?? CHUNK_TIMEOUT_MS, language: opts.language, fetch: opts.fetch, log, label,
        })
        moments.push(...found)
        read.push(chunkSpan(chunk))
        log(`AI 讀逐字稿：${label}找到 ${found.length} 個片段`)
      }
      catch (err) {
        if (signal.aborted) throw signal.reason
        const cause = describeChunkFailure(err, config)
        failures.push(cause)
        skipped.push(chunkSpan(chunk))
        log(`AI 讀逐字稿：${label}讀取失敗，跳過（${cause}）`)
      }
      progress((i + 1) / chunks.length)
    }
  }
  finally {
    const unloaded = await unloadModel(config, {
      fetch: opts.fetch, log, timeoutMs: signal.aborted ? ABORT_UNLOAD_TIMEOUT_MS : undefined,
    })
    if (unloaded) log('AI 讀逐字稿：已卸載模型')
  }

  if (failures.length === chunks.length) return missing(`AI 讀逐字稿失敗：${failures.at(-1)}`)
  const reason = failures.length > 0 ? `${failures.length} 個區段讀取失敗` : null
  return { state: signalState('used', reason), moments: dedupeMoments(moments), unread: subtractSpans(skipped, read), model: config.model }
}
