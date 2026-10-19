// Contract between the Nuxt server and the Python transcriber CLI (`gg-transcribe`).
//
// Commands (argv after the configured transcriber command prefix):
//   transcribe --audio <wav> --language <zh|en> --model <hf-repo-or-path> --device <auto|cuda|cpu> --out <json>
//       Runs faster-whisper with word timestamps + VAD and writes a RawTranscript JSON file to --out.
//   check
//       Prints one JSON line: { "type": "check", "python": "3.12.x", "fasterWhisper": "1.2.1",
//       "ctranslate2": "4.8.3", "cudaDevices": 1 } and exits 0.
//   download --model <hf-repo-or-path>
//       Downloads the model into the Hugging Face cache, printing progress/log events.
//
// While running, stdout carries one JSON object per line (TranscriberEvent). Anything else on
// stdout is ignored; stderr is free-form diagnostics. Exit code 0 means success; on failure the
// CLI prints an `error` event when it can and exits non-zero.

export type TranscriberEvent =
  | { type: 'progress', progress: number }
  | { type: 'log', message: string }
  | { type: 'done', output: string }
  | { type: 'error', message: string }

export interface RawWord {
  start: number
  end: number
  /** Word text as produced by Whisper; may carry a leading space (latin) or be a single CJK character. */
  word: string
  probability: number
}

export interface RawSegment {
  start: number
  end: number
  text: string
  words: RawWord[]
}

export interface RawTranscript {
  language: string
  durationSec: number
  model: string
  device: string
  segments: RawSegment[]
}
