// The Ollama part of GET /api/system (readiness probe: it must answer quickly and never fail).
import type { OllamaInfo } from '../../../shared/types/domain'
import { probeOllama } from '../llm'
import type { OllamaConfig } from '../llm'

/** design.md: /api/system waits at most 1.5 s for Ollama. */
export const SYSTEM_OLLAMA_TIMEOUT_MS = 1500

/** Ollama status for the settings page; 'unreachable' on any failure, never throws. */
export async function ollamaInfo(config: OllamaConfig, opts: { timeoutMs?: number, fetch?: typeof fetch } = {}): Promise<OllamaInfo> {
  const base = { url: config.url, model: config.model }
  try {
    const probe = await probeOllama(config, { timeoutMs: opts.timeoutMs ?? SYSTEM_OLLAMA_TIMEOUT_MS, fetch: opts.fetch })
    return { ...base, status: probe.status, version: probe.version }
  }
  catch {
    return { ...base, status: config.url ? 'unreachable' : 'disabled', version: null }
  }
}
