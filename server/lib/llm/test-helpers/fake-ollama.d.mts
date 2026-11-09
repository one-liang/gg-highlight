// Types for fake-ollama.mjs (plain ESM so it also runs with `node` for e2e).
export type FakeOllamaScenario =
  | 'ok'
  | 'empty'
  | 'invalid-json'
  | 'length'
  | 'http500'
  | 'hang'
  | 'model-missing'
  | 'old-version'

export interface FakeOllamaRequest {
  method: string
  path: string
  /** Parsed JSON body; null for requests without one (GET). */
  body: any
}

export interface FakeOllamaOptions {
  /** 0 = any free port. */
  port?: number
  scenario?: FakeOllamaScenario
  /** Reported by /api/version (except in 'old-version'). */
  version?: string
  /** Pulled models (listed with ':latest' when untagged). */
  models?: string[]
  /** Extra wait before answering a chat generation (not unload). */
  delayMs?: number
}

export interface FakeOllama {
  /** e.g. http://127.0.0.1:41234 (no trailing slash). */
  url: string
  /** Every Ollama API request received, in order (test control paths /__* are not recorded). */
  requests: FakeOllamaRequest[]
  setScenario(scenario: FakeOllamaScenario): void
  close(): Promise<void>
}

export declare const SCENARIOS: readonly FakeOllamaScenario[]
export declare const OLD_VERSION: string
export declare function transcriptLinesOf(messages: unknown): Array<{ n: number, text: string }>
export declare function okHighlights(lines: Array<{ n: number, text: string }>): Array<{ startLine: number, endLine: number, reason: string, score: number }>
export declare function startFakeOllama(options?: FakeOllamaOptions): Promise<FakeOllama>
