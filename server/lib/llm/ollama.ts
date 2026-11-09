// Minimal Ollama HTTP client: probe (version + model), streaming chat, unload.
// Ollama API facts this relies on: docs/adr/0002-ollama-qwen-transcript-signal.md, design.md「訊號」.
import { TRANSCRIPT_SIGNAL_DISABLED_REASON } from '../../../shared/types/domain'
import { MIN_OLLAMA_VERSION } from './types'
import type { OllamaConfig, OllamaProbe } from './types'

/** GET /api/version (and /api/tags) must answer within this, in total (design.md: 3 s). */
export const PROBE_TIMEOUT_MS = 3000
/** Unloading is best effort; it never waits longer than this. */
export const UNLOAD_TIMEOUT_MS = 5000

/** Ollama answered with an error: HTTP status ≥ 400, or an `{"error"}` line inside a 200 stream. */
export class OllamaError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'OllamaError'
  }
}

/** No complete reply within the caller's timeout. */
export class OllamaTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Ollama did not answer within ${timeoutMs} ms`)
    this.name = 'OllamaTimeoutError'
  }
}

/** The NDJSON stream was malformed or ended before its `done` line. */
export class OllamaStreamError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OllamaStreamError'
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Body of POST /api/chat without `model` and `stream` (chatStream sets both). */
export interface ChatRequest {
  messages: ChatMessage[]
  /** JSON schema for structured output. */
  format?: unknown
  options?: Record<string, number>
  think?: boolean
  keep_alive?: string | number
}

export interface ChatResult {
  /** All `message.content` pieces joined. */
  content: string
  /** `done_reason` of the final line: 'stop', 'length', 'unload', … */
  doneReason: string | null
}

export interface ChatStreamOptions {
  /** Aborting rejects with `signal.reason` unchanged. */
  signal?: AbortSignal
  /** Rejects with OllamaTimeoutError when the whole reply is not in within this. */
  timeoutMs?: number
  fetch?: typeof fetch
}

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function anySignal(signals: Array<AbortSignal | null | undefined>): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => !!s)
  if (present.length <= 1) return present[0]
  return AbortSignal.any(present)
}

/** Numeric [major, minor, patch] of "0.31.2", "v0.31.2", "0.31.2-rc1"; null when unparseable. */
export function parseVersion(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)]
}

/** True when `version` is older than `minimum`. Unparseable versions are not treated as old. */
export function isOlderVersion(version: string, minimum: string): boolean {
  const a = parseVersion(version)
  const b = parseVersion(minimum)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!
  }
  return false
}

/** Ollama names default to the ':latest' tag: 'qwen3' and 'qwen3:latest' are the same model. */
export function normalizeModelName(name: string): string {
  const lower = name.trim().toLowerCase()
  const lastSegment = lower.slice(lower.lastIndexOf('/') + 1)
  return lastSegment.includes(':') ? lower : `${lower}:latest`
}

function tagsHaveModel(tags: JsonObject, model: string): boolean {
  if (!Array.isArray(tags.models)) return false
  const wanted = normalizeModelName(model)
  return tags.models.some(entry => isObject(entry)
    && [entry.name, entry.model].some(n => typeof n === 'string' && normalizeModelName(n) === wanted))
}

/** GET a JSON object; null on any failure (network, timeout, HTTP error, not JSON). */
async function getJson(doFetch: typeof fetch, url: string, signal: AbortSignal): Promise<JsonObject | null> {
  try {
    const res = await doFetch(url, { signal })
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      return null
    }
    const value: unknown = await res.json()
    return isObject(value) ? value : null
  }
  catch {
    return null
  }
}

/**
 * GET /api/version (and /api/tags for the model) with a short timeout. Never throws:
 * disabled / unreachable / outdated / model-missing / ready.
 */
export async function probeOllama(
  config: OllamaConfig,
  opts: { timeoutMs?: number, signal?: AbortSignal, fetch?: typeof fetch } = {},
): Promise<OllamaProbe> {
  if (!config.url) return { status: 'disabled', version: null }
  const doFetch = opts.fetch ?? globalThis.fetch
  const signal = anySignal([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? PROBE_TIMEOUT_MS)])!

  const versionBody = await getJson(doFetch, `${config.url}/api/version`, signal)
  // Something that answers without a version is not Ollama.
  if (!versionBody || typeof versionBody.version !== 'string') return { status: 'unreachable', version: null }
  const version = versionBody.version
  if (isOlderVersion(version, MIN_OLLAMA_VERSION)) return { status: 'outdated', version }

  const tags = await getJson(doFetch, `${config.url}/api/tags`, signal)
  if (!tags) return { status: 'unreachable', version }
  return { status: tagsHaveModel(tags, config.model) ? 'ready' : 'model-missing', version }
}

/**
 * zh-TW sentence telling the user why the transcript Signal is unavailable and what to do;
 * null when Ollama is ready.
 */
export function describeOllamaProbe(config: OllamaConfig, probe: OllamaProbe): string | null {
  switch (probe.status) {
    case 'ready':
      return null
    case 'disabled':
      return TRANSCRIPT_SIGNAL_DISABLED_REASON
    case 'unreachable':
      return `連不到 Ollama（${config.url}），請確認 Ollama 已啟動`
    case 'outdated':
      return `Ollama 版本 ${probe.version} 太舊，需要 ${MIN_OLLAMA_VERSION} 以上，請更新 Ollama`
    case 'model-missing':
      return `Ollama 裡還沒有 ${config.model} 模型，請執行 ollama pull ${config.model}`
  }
}

async function httpError(res: Response): Promise<OllamaError> {
  const text = await res.text().catch(() => '')
  let message = ''
  try {
    const value: unknown = JSON.parse(text)
    if (isObject(value) && typeof value.error === 'string') message = value.error
  }
  catch {
    // not JSON: fall back to the raw text
  }
  message ||= text.trim().slice(0, 200) || res.statusText || `HTTP ${res.status}`
  return new OllamaError(res.status, message)
}

/** Reads Ollama's NDJSON chat stream incrementally (lines may be split across network chunks). */
async function readChatStream(body: ReadableStream<Uint8Array>, status: number): Promise<ChatResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let doneReason: string | null = null
  let done = false

  const handleLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let event: unknown
    try {
      event = JSON.parse(trimmed)
    }
    catch {
      throw new OllamaStreamError(`invalid stream line: ${trimmed.slice(0, 80)}`)
    }
    if (!isObject(event)) throw new OllamaStreamError('stream line is not an object')
    if (typeof event.error === 'string') throw new OllamaError(status, event.error)
    if (isObject(event.message) && typeof event.message.content === 'string') content += event.message.content
    if (event.done === true) {
      done = true
      doneReason = typeof event.done_reason === 'string' ? event.done_reason : null
    }
  }

  try {
    for (;;) {
      const { value, done: ended } = await reader.read()
      if (ended) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        handleLine(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
    }
    handleLine(buffer + decoder.decode())
  }
  catch (err) {
    await reader.cancel().catch(() => {})
    throw err
  }
  finally {
    reader.releaseLock()
  }
  if (!done) throw new OllamaStreamError('stream ended before the final line')
  return { content, doneReason }
}

/**
 * POST /api/chat with `stream: true` (a non-streaming reply can take longer than undici's 300 s
 * headers timeout) and returns the joined content. HTTP errors → OllamaError; timeout →
 * OllamaTimeoutError; `opts.signal` aborting → rejects with its reason.
 */
export async function chatStream(config: OllamaConfig, body: ChatRequest, opts: ChatStreamOptions = {}): Promise<ChatResult> {
  if (!config.url) throw new Error('Ollama is disabled (GG_OLLAMA_URL=off)')
  opts.signal?.throwIfAborted()
  const doFetch = opts.fetch ?? globalThis.fetch
  const timeout = opts.timeoutMs !== undefined ? AbortSignal.timeout(opts.timeoutMs) : null
  try {
    const res = await doFetch(`${config.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.model, ...body, stream: true }),
      signal: anySignal([opts.signal, timeout]),
    })
    if (!res.ok) throw await httpError(res)
    if (!res.body) throw new OllamaStreamError('empty response body')
    return await readChatStream(res.body, res.status)
  }
  catch (err) {
    if (opts.signal?.aborted) throw opts.signal.reason
    if (timeout?.aborted) throw new OllamaTimeoutError(opts.timeoutMs!)
    throw err
  }
}

/**
 * Asks Ollama to unload the model now (`messages: []`, `keep_alive: 0`) so the next Analysis's
 * speech recognition gets the GPU memory. Best effort: never throws, and deliberately takes no job
 * signal so it still runs after a cancel. Resolves true when Ollama confirmed.
 */
export async function unloadModel(
  config: OllamaConfig,
  opts: { timeoutMs?: number, fetch?: typeof fetch, log?: (message: string) => void } = {},
): Promise<boolean> {
  if (!config.url) return false
  const doFetch = opts.fetch ?? globalThis.fetch
  try {
    const res = await doFetch(`${config.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.model, messages: [], keep_alive: 0 }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? UNLOAD_TIMEOUT_MS),
    })
    if (!res.ok) {
      const err = await httpError(res)
      opts.log?.(`卸載 Ollama 模型失敗（HTTP ${err.status}：${err.message}）`)
      return false
    }
    await res.body?.cancel().catch(() => {})
    return true
  }
  catch (err) {
    opts.log?.(`卸載 Ollama 模型失敗（${(err as Error).message}）`)
    return false
  }
}
