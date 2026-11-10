import { describe, expect, it } from 'vitest'
import { clearVideoEncoderCache, detectVideoEncoder, encoderFallbackMessage, withEncoderFallback } from './encoder'
import { abortError, MediaToolError } from './process'
import { tools } from './test-utils'
import type { VideoEncoder } from './types'

const NVENC_STDERR = '[h264_nvenc @ 0x1] OpenEncodeSessionEx failed: out of memory (10): (no details)\n[vost#0:0/h264_nvenc @ 0x1] Error while opening encoder'
const nvencBusy = () => new MediaToolError(`ffmpeg 執行失敗（結束碼 187）：\n${NVENC_STDERR}`, 187, NVENC_STDERR)

/** An encode that fails for the encoders in `failing` (an injected failing NVENC by default). */
function fakeEncode(failing: Partial<Record<VideoEncoder, () => Error>> = { h264_nvenc: nvencBusy }) {
  const tried: VideoEncoder[] = []
  const encode = async (encoder: VideoEncoder) => {
    tried.push(encoder)
    const fail = failing[encoder]
    if (fail) throw fail()
    return `done with ${encoder}`
  }
  return { tried, encode }
}

describe('detectVideoEncoder', () => {
  it('falls back to libx264 when the NVENC test encode fails (no GPU here) and caches per ffmpeg path', async () => {
    clearVideoEncoderCache()
    const first = detectVideoEncoder(tools)
    expect(detectVideoEncoder(tools)).toBe(first)
    expect(await first).toBe('libx264')
  })

  it('lets the override win without probing', async () => {
    expect(await detectVideoEncoder(tools, 'h264_nvenc')).toBe('h264_nvenc')
    expect(await detectVideoEncoder({ ...tools, ffmpegPath: '/no/such/ffmpeg' }, 'h264_nvenc')).toBe('h264_nvenc')
    expect(await detectVideoEncoder(tools, 'libx264')).toBe('libx264')
    expect(await detectVideoEncoder(tools, null)).toBe('libx264')
  })

  it('returns libx264 when ffmpeg itself is missing', async () => {
    expect(await detectVideoEncoder({ ...tools, ffmpegPath: '/no/such/ffmpeg' })).toBe('libx264')
  })
})

describe('withEncoderFallback', () => {
  it('redoes a failed h264_nvenc encode once with libx264 and says so', async () => {
    const { tried, encode } = fakeEncode()
    const fallbacks: unknown[] = []
    expect(await withEncoderFallback('h264_nvenc', encode, { onFallback: err => fallbacks.push(err) })).toBe('done with libx264')
    expect(tried).toEqual(['h264_nvenc', 'libx264'])
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks[0]).toBeInstanceOf(MediaToolError)
  })

  it('uses NVENC when it works, and never retries libx264', async () => {
    const ok = fakeEncode({})
    expect(await withEncoderFallback('h264_nvenc', ok.encode)).toBe('done with h264_nvenc')
    expect(ok.tried).toEqual(['h264_nvenc'])
    const broken = fakeEncode({ libx264: () => new MediaToolError('ffmpeg 執行失敗（結束碼 1）', 1, '') })
    await expect(withEncoderFallback('libx264', broken.encode)).rejects.toThrow('結束碼 1')
    expect(broken.tried).toEqual(['libx264'])
  })

  it('does not retry aborted work or failures that are not an ffmpeg error exit', async () => {
    const aborted = fakeEncode({ h264_nvenc: abortError })
    await expect(withEncoderFallback('h264_nvenc', aborted.encode)).rejects.toMatchObject({ name: 'AbortError' })
    expect(aborted.tried).toEqual(['h264_nvenc'])

    const controller = new AbortController()
    controller.abort()
    const cancelled = fakeEncode()
    await expect(withEncoderFallback('h264_nvenc', cancelled.encode, { signal: controller.signal })).rejects.toBeInstanceOf(MediaToolError)
    expect(cancelled.tried).toEqual(['h264_nvenc'])

    const missing = fakeEncode({ h264_nvenc: () => new Error('無法執行 ffmpeg：找不到執行檔') })
    await expect(withEncoderFallback('h264_nvenc', missing.encode)).rejects.toThrow('找不到執行檔')
    expect(missing.tried).toEqual(['h264_nvenc'])
  })

  it('reports the libx264 error when the retry fails too', async () => {
    const both = fakeEncode({ h264_nvenc: nvencBusy, libx264: () => new MediaToolError('ffmpeg 執行失敗（結束碼 1）：\nInvalid data found when processing input', 1, '') })
    await expect(withEncoderFallback('h264_nvenc', both.encode)).rejects.toThrow('Invalid data found')
    expect(both.tried).toEqual(['h264_nvenc', 'libx264'])
  })
})

describe('encoderFallbackMessage', () => {
  it('names the fallback and the last stderr line', () => {
    expect(encoderFallbackMessage(nvencBusy())).toBe('NVENC 硬體編碼失敗，改用 CPU（libx264）重新編碼：[vost#0:0/h264_nvenc @ 0x1] Error while opening encoder')
    expect(encoderFallbackMessage(new Error('boom'))).toBe('NVENC 硬體編碼失敗，改用 CPU（libx264）重新編碼：boom')
    expect(encoderFallbackMessage(null)).toBe('NVENC 硬體編碼失敗，改用 CPU（libx264）重新編碼')
  })
})
