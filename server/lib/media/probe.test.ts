import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { countAudioTracks, parseFrameRate, parseProbeOutput, probeMedia } from './probe'
import { fx, makeTmpDir, rawProbe, tools } from './test-utils'

describe('probeMedia (real ffprobe)', () => {
  it('reads the two-track OBS-style mkv', async () => {
    const info = await probeMedia(tools, fx.sampleEnMkv)
    expect(info.width).toBe(1280)
    expect(info.height).toBe(720)
    expect(info.fps).toBeCloseTo(30, 1)
    expect(info.videoCodec).toBe('h264')
    expect(info.container).toContain('matroska')
    expect(info.durationSec).toBeCloseTo(Number(rawProbe(fx.sampleEnMkv).format.duration), 3)
    expect(info.durationSec).toBeGreaterThan(3)
    expect(info.audioTracks).toEqual([
      { index: 0, codec: 'aac', channels: 2, language: null, title: null },
      { index: 1, codec: 'aac', channels: 2, language: null, title: null },
    ])
  })

  it('reads a video without audio', async () => {
    const info = await probeMedia(tools, fx.noAudioMp4)
    expect(info).toMatchObject({ width: 640, height: 360, fps: 25, videoCodec: 'h264', audioTracks: [] })
    expect(info.container).toContain('mp4')
    expect(info.durationSec).toBeCloseTo(3, 1)
  })

  it('reads a vertical video', async () => {
    const info = await probeMedia(tools, fx.verticalMp4)
    expect(info.width).toBe(720)
    expect(info.height).toBe(1280)
    expect(info.audioTracks).toHaveLength(1)
  })

  it('swaps width/height for a stream rotated by 90°', async () => {
    const dir = await makeTmpDir()
    const rotated = path.join(dir, 'rotated.mp4')
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-display_rotation', '90', '-i', fx.noAudioMp4, '-c', 'copy', rotated], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    const info = await probeMedia(tools, rotated)
    expect(info.width).toBe(360)
    expect(info.height).toBe(640)
  })

  it('keeps language and title tags', async () => {
    const dir = await makeTmpDir()
    const tagged = path.join(dir, 'tagged.mkv')
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', fx.sampleEnMkv, '-map', '0', '-c', 'copy', '-t', '1',
      '-metadata:s:a:0', 'language=jpn', '-metadata:s:a:0', 'title=遊戲聲音',
      '-metadata:s:a:1', 'title=Mic', tagged], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    const info = await probeMedia(tools, tagged)
    expect(info.audioTracks.map(t => [t.language, t.title])).toEqual([['jpn', '遊戲聲音'], [null, 'Mic']])
  })

  it('rejects files without a video stream', async () => {
    await expect(probeMedia(tools, fx.speechEn)).rejects.toThrow('無法讀取影片：找不到影像軌')
  })

  it('rejects missing or broken files with a Chinese message', async () => {
    await expect(probeMedia(tools, '/no/such/video.mp4')).rejects.toThrow(/^無法讀取影片：.*No such file/)
    const dir = await makeTmpDir()
    const junk = path.join(dir, 'junk.mp4')
    await import('node:fs/promises').then(fs => fs.writeFile(junk, 'not a video'))
    await expect(probeMedia(tools, junk)).rejects.toThrow(/^無法讀取影片：/)
  })

  it('counts audio tracks without needing video', async () => {
    expect(await countAudioTracks(tools, fx.sampleEnMkv)).toBe(2)
    expect(await countAudioTracks(tools, fx.noAudioMp4)).toBe(0)
    expect(await countAudioTracks(tools, fx.speechEn)).toBe(1)
  })
})

describe('parseFrameRate', () => {
  it('parses rational and plain rates', () => {
    expect(parseFrameRate('30000/1001')).toBe(29.97)
    expect(parseFrameRate('60/1')).toBe(60)
    expect(parseFrameRate('25')).toBe(25)
    expect(parseFrameRate('0/0')).toBeNull()
    expect(parseFrameRate(undefined)).toBeNull()
    expect(parseFrameRate('abc')).toBeNull()
  })
})

describe('parseProbeOutput', () => {
  const video = { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '60/1', r_frame_rate: '60/1' }

  it('falls back to r_frame_rate when avg_frame_rate is 0/0', () => {
    const info = parseProbeOutput({ streams: [{ ...video, avg_frame_rate: '0/0', r_frame_rate: '30000/1001' }], format: { duration: '5' } })
    expect(info.fps).toBe(29.97)
  })

  it('falls back to the video stream duration, then the matroska DURATION tag', () => {
    expect(parseProbeOutput({ streams: [{ ...video, duration: '12.5' }], format: { duration: 'N/A' } }).durationSec).toBe(12.5)
    expect(parseProbeOutput({ streams: [{ ...video, tags: { DURATION: '01:02:03.500000000' } }], format: {} }).durationSec).toBe(3723.5)
    expect(parseProbeOutput({ streams: [video] }).durationSec).toBe(0)
  })

  it('swaps dimensions for ±90° rotation from side data or the rotate tag', () => {
    const size = (s: object) => {
      const i = parseProbeOutput({ streams: [{ ...video, ...s }] })
      return [i.width, i.height]
    }
    expect(size({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] })).toEqual([1080, 1920])
    expect(size({ side_data_list: [{ rotation: 90 }] })).toEqual([1080, 1920])
    expect(size({ side_data_list: [{ rotation: 180 }] })).toEqual([1920, 1080])
    expect(size({ side_data_list: [{ rotation: -270 }] })).toEqual([1080, 1920])
    expect(size({ tags: { rotate: '270' } })).toEqual([1080, 1920])
    expect(size({})).toEqual([1920, 1080])
  })

  it('skips cover art and maps audio tracks with audio-relative indexes', () => {
    const info = parseProbeOutput({
      streams: [
        { codec_type: 'video', codec_name: 'mjpeg', width: 300, height: 300, disposition: { attached_pic: 1 } },
        { codec_type: 'audio', codec_name: 'opus', channels: 2, tags: { LANGUAGE: 'und', TITLE: ' ' } },
        { ...video, codec_name: 'hevc' },
        { codec_type: 'subtitle', codec_name: 'ass' },
        { codec_type: 'audio', codec_name: 'ac3', channels: 6, tags: { language: 'chi', title: 'Commentary' } },
      ],
      format: { format_name: 'matroska,webm', duration: '10.0' },
    })
    expect(info.videoCodec).toBe('hevc')
    expect(info.width).toBe(1920)
    expect(info.container).toBe('matroska,webm')
    expect(info.audioTracks).toEqual([
      { index: 0, codec: 'opus', channels: 2, language: null, title: null },
      { index: 1, codec: 'ac3', channels: 6, language: 'chi', title: 'Commentary' },
    ])
  })

  it('throws the Chinese no-video message when only cover art exists', () => {
    expect(() => parseProbeOutput({ streams: [{ codec_type: 'video', disposition: { attached_pic: 1 } }] }))
      .toThrow('無法讀取影片：找不到影像軌')
  })
})
