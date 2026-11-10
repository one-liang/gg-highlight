// NVENC detection: a tiny real encode is the only reliable test (listed ≠ usable without a GPU/driver).
// A detected NVENC can still fail later (e.g. OBS holding the encode sessions): withEncoderFallback.
import { isAbortError, MediaToolError, runFfmpeg } from './process'
import type { MediaTools, VideoEncoder } from './types'

const DETECT_TIMEOUT_MS = 30_000

const cache = new Map<string, Promise<VideoEncoder>>()

async function tryNvenc(tools: MediaTools): Promise<VideoEncoder> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DETECT_TIMEOUT_MS)
  try {
    await runFfmpeg(tools, [
      '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.2',
      '-c:v', 'h264_nvenc',
      '-f', 'null', '-',
    ], { signal: controller.signal })
    return 'h264_nvenc'
  }
  catch {
    return 'libx264'
  }
  finally {
    clearTimeout(timer)
  }
}

export function detectVideoEncoder(tools: MediaTools, override?: VideoEncoder | null): Promise<VideoEncoder> {
  if (override) return Promise.resolve(override)
  let pending = cache.get(tools.ffmpegPath)
  if (!pending) {
    pending = tryNvenc(tools)
    cache.set(tools.ffmpegPath, pending)
  }
  return pending
}

/** Forgets cached detections (tests, or after the user swaps ffmpeg/drivers). */
export function clearVideoEncoderCache() {
  cache.clear()
}

export interface EncoderFallbackOptions {
  signal?: AbortSignal
  /** Called with the NVENC error right before the libx264 retry (for the log). */
  onFallback?: (err: unknown) => void
}

/**
 * Runs `encode` with the chosen encoder. When an h264_nvenc encode fails (ffmpeg exits with an
 * error) and the work was not aborted, runs it once more with libx264: NVENC can be busy or gone at
 * runtime even though the startup test encode worked, e.g. while OBS records with NVENC.
 */
export async function withEncoderFallback<T>(
  encoder: VideoEncoder,
  encode: (encoder: VideoEncoder) => Promise<T>,
  opts: EncoderFallbackOptions = {},
): Promise<T> {
  try {
    return await encode(encoder)
  }
  catch (err) {
    if (encoder !== 'h264_nvenc' || !(err instanceof MediaToolError) || isAbortError(err) || opts.signal?.aborted) throw err
    opts.onFallback?.(err)
    return await encode('libx264')
  }
}

/** One line for the log about an NVENC failure that is retried with libx264. */
export function encoderFallbackMessage(err: unknown): string {
  const lines = (err instanceof Error ? err.message : String(err ?? '')).split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  // the stderr tail's last line says why (e.g. "OpenEncodeSessionEx failed: out of memory")
  const reason = lines.length > 1 ? lines[lines.length - 1] : lines[0]
  return `NVENC 硬體編碼失敗，改用 CPU（libx264）重新編碼${reason ? `：${reason}` : ''}`
}
