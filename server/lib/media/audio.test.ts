import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractAudio } from './audio'
import { probeMedia } from './probe'
import { fx, makeTmpDir, rawProbe, tools } from './test-utils'

describe('extractAudio', () => {
  it('extracts one track as 16 kHz mono s16 WAV with the source duration and progress up to 1', async () => {
    const media = await probeMedia(tools, fx.sampleEnMkv)
    const dir = await makeTmpDir()
    const out = path.join(dir, 'nested', 'audio.wav')
    const seen: number[] = []
    await extractAudio(tools, { filePath: fx.sampleEnMkv, audioTrack: 1, durationSec: media.durationSec }, out, {
      onProgress: v => seen.push(v),
    })
    const probe = rawProbe(out)
    expect(probe.streams).toHaveLength(1)
    expect(probe.streams[0]).toMatchObject({ codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '16000', channels: 1 })
    expect(Number(probe.format.duration)).toBeGreaterThan(media.durationSec - 0.2)
    expect(Number(probe.format.duration)).toBeLessThan(media.durationSec + 0.2)
    expect(seen.at(-1)).toBe(1)
    // Only the final file is left behind.
    expect(await fs.readdir(path.dirname(out))).toEqual(['audio.wav'])
  })

  it('picks the requested track (track 0 = speech + tone differs from track 1 = speech only)', async () => {
    const media = await probeMedia(tools, fx.sampleEnMkv)
    const dir = await makeTmpDir()
    const a0 = path.join(dir, 'a0.wav')
    const a1 = path.join(dir, 'a1.wav')
    await extractAudio(tools, { filePath: fx.sampleEnMkv, audioTrack: 0, durationSec: media.durationSec }, a0)
    await extractAudio(tools, { filePath: fx.sampleEnMkv, audioTrack: 1, durationSec: media.durationSec }, a1)
    const [b0, b1] = await Promise.all([fs.readFile(a0), fs.readFile(a1)])
    expect(Math.abs(b0.length - b1.length)).toBeLessThan(3200) // same length within 0.1 s
    expect(b0.equals(b1)).toBe(false)
  })

  it('reports an out-of-range track 1-based and leaves no file', async () => {
    const dir = await makeTmpDir()
    const out = path.join(dir, 'audio.wav')
    await expect(extractAudio(tools, { filePath: fx.sampleEnMkv, audioTrack: 2, durationSec: 10 }, out)).rejects.toThrow('找不到第 3 條音軌')
    await expect(extractAudio(tools, { filePath: fx.sampleEnMkv, audioTrack: -1, durationSec: 10 }, out)).rejects.toThrow('找不到第 0 條音軌')
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('reports a video without audio', async () => {
    const dir = await makeTmpDir()
    await expect(extractAudio(tools, { filePath: fx.noAudioMp4, audioTrack: 0, durationSec: 3 }, path.join(dir, 'a.wav')))
      .rejects.toThrow('這支影片沒有音訊')
  })

  it('aborts and cleans up the temp file', async () => {
    const dir = await makeTmpDir()
    const controller = new AbortController()
    controller.abort()
    const err = await extractAudio(tools, { filePath: fx.sampleEnMkv, audioTrack: 0, durationSec: 10 }, path.join(dir, 'a.wav'), {
      signal: controller.signal,
    }).catch(e => e) as Error
    expect(err.name).toBe('AbortError')
    expect(await fs.readdir(dir)).toEqual([])
  })
})
