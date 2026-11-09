// Ollama client and the "AI reads the Transcript" Signal. Implementations live in the files re-exported here.
export * from './types'
export {
  chatStream, describeOllamaProbe, OllamaError, OllamaStreamError, OllamaTimeoutError, probeOllama, unloadModel,
} from './ollama'
export type { ChatMessage, ChatRequest, ChatResult } from './ollama'
export { readTranscriptWithLlm } from './transcript-signal'
