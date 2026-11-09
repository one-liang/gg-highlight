import type { OllamaConfig, ReadTranscriptOptions, TranscriptLine, TranscriptSignalResult } from './types'

/**
 * Probes Ollama, splits the Transcript into 10-minute chunks (60 s overlap), asks the model for
 * highlight line ranges per chunk (structured output), converts them to TranscriptMoments and always
 * unloads the model at the end. Resolves with state 'missing' (and a zh-TW reason) when Ollama is
 * disabled, unreachable, outdated, lacks the model, or every chunk failed. Rejects only when
 * `opts.signal` aborts.
 */
export async function readTranscriptWithLlm(
  _config: OllamaConfig,
  _lines: TranscriptLine[],
  _opts: ReadTranscriptOptions,
): Promise<TranscriptSignalResult> {
  throw new Error('not implemented')
}
