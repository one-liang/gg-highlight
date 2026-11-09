// Local LLM (Ollama) contract for the transcript Signal (design.md「逐字稿」, ADR-0002).
import type { OllamaStatus, SignalState } from '../../../shared/types/domain'
import type { TranscriptMoment } from '../signals/types'

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'
export const DEFAULT_OLLAMA_MODEL = 'qwen3.5:9b'
/** qwen3.5 ignores `format` with think:false before this version (ollama#14645). */
export const MIN_OLLAMA_VERSION = '0.31.2'

export interface OllamaConfig {
  /** Base URL without a trailing slash; null = disabled (GG_OLLAMA_URL=off). */
  url: string | null
  model: string
}

export interface OllamaProbe {
  status: OllamaStatus
  version: string | null
}

/** One Transcript segment as the LLM sees it (current, possibly user-edited text). */
export interface TranscriptLine {
  start: number
  end: number
  text: string
}

export interface TranscriptSignalResult {
  /** kind 'transcript'; 'missing' with a zh-TW reason telling the user what to do. */
  state: SignalState
  moments: TranscriptMoment[]
  model: string
}

export interface ReadTranscriptOptions {
  /** The Analysis job's signal: abort → the promise rejects with the abort reason (not a 'missing' signal). */
  signal: AbortSignal
  /** Fraction of chunks done, 0–1. */
  onProgress?: (fraction: number) => void
  log?: (message: string) => void
  /** Injected for tests; defaults to globalThis.fetch. */
  fetch?: typeof fetch
}
