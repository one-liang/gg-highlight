import type { OllamaConfig, OllamaProbe } from './types'

/**
 * GET /api/version (and /api/tags for the model) with a short timeout. Never throws:
 * disabled / unreachable / outdated / model-missing / ready.
 */
export async function probeOllama(
  _config: OllamaConfig,
  _opts: { timeoutMs?: number, signal?: AbortSignal, fetch?: typeof fetch } = {},
): Promise<OllamaProbe> {
  throw new Error('not implemented')
}
