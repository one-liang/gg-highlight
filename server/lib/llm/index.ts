// Ollama client and the "AI reads the Transcript" Signal. Implementations live in the files re-exported here.
export * from './types'
export { probeOllama } from './ollama'
export { readTranscriptWithLlm } from './transcript-signal'
