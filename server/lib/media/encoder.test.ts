import { describe, expect, it } from 'vitest'
import { clearVideoEncoderCache, detectVideoEncoder } from './encoder'
import { tools } from './test-utils'

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
