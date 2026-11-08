// NVENC detection: a tiny real encode is the only reliable test (listed ≠ usable without a GPU/driver).
import { runFfmpeg } from './process'
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
