import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { MediaInfo } from '../../../shared/types/domain'
import { probeMedia } from './probe'
import { evenDim, fitShortSide, preparePreview, previewArgs, previewPlan, previewSize } from './preview'
import { fx, makeTmpDir, rawProbe, tools } from './test-utils'

function media(over: Partial<MediaInfo> & { audio?: string[] } = {}): MediaInfo {
  const { audio = ['aac'], ...rest } = over
  return {
    durationSec: 10,
    width: 1920,
    height: 1080,
    fps: 60,
    videoCodec: 'h264',
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    audioTracks: audio.map((codec, index) => ({ index, codec, channels: 2, language: null, title: null })),
    ...rest,
  }
}

describe('previewPlan', () => {
  it('plays browser-friendly mp4/mov as is', () => {
    expect(previewPlan(media())).toBe('original')
    expect(previewPlan(media({ videoCodec: 'av1', audio: ['opus'] }))).toBe('original')
    expect(previewPlan(media({ videoCodec: 'vp9', audio: ['mp3', 'pcm_s16le'] }))).toBe('original')
    expect(previewPlan(media({ audio: [] }))).toBe('original')
    expect(previewPlan(media({ container: 'mov' }))).toBe('original')
  })

  it('remuxes when only the container or the first audio codec is the problem', () => {
    expect(previewPlan(media({ container: 'matroska,webm' }))).toBe('remux')
    expect(previewPlan(media({ container: 'mpegts' }))).toBe('remux')
    expect(previewPlan(media({ audio: ['pcm_s16le', 'aac'] }))).toBe('remux')
    expect(previewPlan(media({ audio: ['ac3'] }))).toBe('remux')
    expect(previewPlan(media({ container: 'flv', videoCodec: 'vp9' }))).toBe('remux')
  })

  it('transcodes other video codecs', () => {
    expect(previewPlan(media({ videoCodec: 'hevc' }))).toBe('transcode')
    expect(previewPlan(media({ videoCodec: 'mpeg4', container: 'matroska,webm' }))).toBe('transcode')
    expect(previewPlan(media({ videoCodec: 'prores', container: 'mov,mp4,m4a,3gp,3g2,mj2' }))).toBe('transcode')
  })

  it('classifies the fixtures', async () => {
    expect(previewPlan(await probeMedia(tools, fx.sampleEnMkv))).toBe('remux')
    expect(previewPlan(await probeMedia(tools, fx.sampleEnMp4))).toBe('original')
    expect(previewPlan(await probeMedia(tools, fx.noAudioMp4))).toBe('original')
    expect(previewPlan(await probeMedia(tools, fx.verticalMp4))).toBe('original')
  })
})

describe('preview sizes', () => {
  it('evenDim rounds to even without upscaling odd integers', () => {
    expect(evenDim(720)).toBe(720)
    expect(evenDim(721)).toBe(720)
    expect(evenDim(607.5)).toBe(608)
    expect(evenDim(1)).toBe(2)
    expect(evenDim(Number.NaN)).toBe(2)
  })

  it('fitShortSide caps the shorter side and keeps the aspect ratio', () => {
    expect(fitShortSide(3840, 1600, 720)).toEqual({ width: 1728, height: 720 })
    expect(fitShortSide(640, 360, 720)).toEqual({ width: 640, height: 360 })
  })

  it('previewSize caps the shorter side at 720 for landscape and portrait', () => {
    expect(previewSize(media())).toEqual({ width: 1280, height: 720 })
    expect(previewSize(media({ width: 1080, height: 1920 }))).toEqual({ width: 720, height: 1280 })
    expect(previewSize(media({ width: 1280, height: 720 }))).toEqual({ width: 1280, height: 720 })
    expect(previewSize(media({ width: 721, height: 481 }))).toEqual({ width: 720, height: 480 })
  })
})

describe('previewArgs', () => {
  it('remux copies video, copies browser audio and re-encodes the rest', () => {
    const copy = previewArgs('/in.mkv', media({ container: 'matroska,webm' }), 'remux', 'libx264')
    expect(copy).toEqual(['-i', '/in.mkv', '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'copy',
      '-sn', '-dn', '-movflags', '+faststart', '-f', 'mp4'])
    const ac3 = previewArgs('/in.mkv', media({ audio: ['ac3'] }), 'remux', 'libx264')
    expect(ac3.join(' ')).toContain('-c:v copy -c:a aac -b:a 160k')
  })

  it('transcode uses libx264 or NVENC with the ≤720p scale', () => {
    const x264 = previewArgs('/in.mkv', media({ videoCodec: 'hevc' }), 'transcode', 'libx264').join(' ')
    expect(x264).toContain('-vf scale=1280:720,setsar=1')
    expect(x264).toContain('-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k')
    expect(x264).toContain('-movflags +faststart')
    const nvenc = previewArgs('/in.mkv', media({ videoCodec: 'hevc' }), 'transcode', 'h264_nvenc').join(' ')
    expect(nvenc).toContain('-c:v h264_nvenc -preset p4 -rc vbr -cq 26 -b:v 0')
  })
})

describe('preparePreview (real ffmpeg)', () => {
  let mpeg4Mkv: string
  let workDir: string

  beforeAll(async () => {
    workDir = await makeTmpDir()
    // An "unsupported codec" source: mpeg4 part 2 video + PCM audio in mkv, 1920x1080.
    mpeg4Mkv = path.join(workDir, 'mpeg4.mkv')
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'pcm_s16le', '-shortest', mpeg4Mkv], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(r.stderr)
  })

  it('returns null and writes nothing when the original plays in the browser', async () => {
    const dir = await makeTmpDir()
    const info = await probeMedia(tools, fx.sampleEnMp4)
    const result = await preparePreview(tools, { filePath: fx.sampleEnMp4, media: info }, path.join(dir, 'preview.mp4'))
    expect(result).toEqual({ previewPath: null })
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('remuxes the OBS-style mkv to a faststart mp4 with video + audio track 0 and the same duration', async () => {
    const dir = await makeTmpDir()
    const out = path.join(dir, 'videos', 'v1', 'preview.mp4')
    const info = await probeMedia(tools, fx.sampleEnMkv)
    const seen: number[] = []
    const result = await preparePreview(tools, { filePath: fx.sampleEnMkv, media: info }, out, { onProgress: v => seen.push(v) })
    expect(result).toEqual({ previewPath: out })
    const preview = await probeMedia(tools, out)
    expect(preview.container).toContain('mp4')
    expect(preview.videoCodec).toBe('h264')
    expect(preview.width).toBe(1280)
    expect(preview.audioTracks).toHaveLength(1)
    expect(preview.audioTracks[0]!.codec).toBe('aac')
    expect(Math.abs(preview.durationSec - info.durationSec)).toBeLessThan(0.1)
    expect(previewPlan(preview)).toBe('original')
    expect(seen.at(-1)).toBe(1)
    expect(await fs.readdir(path.dirname(out))).toEqual(['preview.mp4'])
    // faststart: the moov atom comes before mdat.
    const head = (await fs.readFile(out)).subarray(0, 64 * 1024).toString('latin1')
    expect(head.indexOf('moov')).toBeGreaterThan(-1)
    expect(head.indexOf('moov')).toBeLessThan(head.indexOf('mdat') === -1 ? Infinity : head.indexOf('mdat'))
  })

  it('remuxes a mp4 whose first audio track is PCM, re-encoding audio to AAC', async () => {
    const dir = await makeTmpDir()
    const src = path.join(dir, 'pcm.mov')
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', fx.sampleEnMp4, '-t', '2', '-c:v', 'copy', '-c:a', 'pcm_s16le', src], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    const info = await probeMedia(tools, src)
    expect(previewPlan(info)).toBe('remux')
    const out = path.join(dir, 'preview.mp4')
    await preparePreview(tools, { filePath: src, media: info }, out)
    const preview = await probeMedia(tools, out)
    expect(preview.videoCodec).toBe('h264')
    expect(preview.audioTracks.map(t => t.codec)).toEqual(['aac'])
  })

  it('remuxes a webm-style mkv (vp9 + opus) to mp4 keeping both codecs', async () => {
    const dir = await makeTmpDir()
    const src = path.join(dir, 'vp9.mkv')
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-c:a', 'libopus', '-shortest', src], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    const info = await probeMedia(tools, src)
    expect(previewPlan(info)).toBe('remux')
    const out = path.join(dir, 'preview.mp4')
    await preparePreview(tools, { filePath: src, media: info }, out)
    const preview = await probeMedia(tools, out)
    expect(preview.container).toContain('mp4')
    expect(preview.videoCodec).toBe('vp9')
    expect(preview.audioTracks.map(t => t.codec)).toEqual(['opus'])
    expect(previewPlan(preview)).toBe('original')
  })

  it('transcodes an unsupported codec to ≤720p h264 + aac', async () => {
    const info = await probeMedia(tools, mpeg4Mkv)
    expect(info.videoCodec).toBe('mpeg4')
    expect(previewPlan(info)).toBe('transcode')
    const dir = await makeTmpDir()
    const out = path.join(dir, 'preview.mp4')
    const seen: number[] = []
    await preparePreview(tools, { filePath: mpeg4Mkv, media: info }, out, { encoder: 'libx264', onProgress: v => seen.push(v) })
    const raw = rawProbe(out)
    const v = raw.streams.find(s => s.codec_type === 'video')!
    const a = raw.streams.find(s => s.codec_type === 'audio')!
    expect(v).toMatchObject({ codec_name: 'h264', width: 1280, height: 720, pix_fmt: 'yuv420p' })
    expect(a.codec_name).toBe('aac')
    expect(Number(raw.format.duration)).toBeCloseTo(2, 0)
    expect(seen.at(-1)).toBe(1)
  })

  it('transcodes a rotated, silent source upright (fake MediaInfo forces the transcode path)', async () => {
    const dir = await makeTmpDir()
    const rotated = path.join(dir, 'rotated.mp4')
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-display_rotation', '90', '-i', fx.noAudioMp4, '-c', 'copy', '-t', '1', rotated], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    const info = { ...await probeMedia(tools, rotated), videoCodec: 'hevc' }
    expect(info).toMatchObject({ width: 360, height: 640, audioTracks: [] })
    expect(previewPlan(info)).toBe('transcode')
    const out = path.join(dir, 'preview.mp4')
    await preparePreview(tools, { filePath: rotated, media: info }, out, { encoder: 'libx264' })
    const raw = rawProbe(out)
    expect(raw.streams.map(s => s.codec_type)).toEqual(['video'])
    expect(raw.streams[0]).toMatchObject({ codec_name: 'h264', width: 360, height: 640 })
  })

  it('detects the encoder when none is given (libx264 here)', async () => {
    const info = await probeMedia(tools, mpeg4Mkv)
    const dir = await makeTmpDir()
    const out = path.join(dir, 'preview.mp4')
    await preparePreview(tools, { filePath: mpeg4Mkv, media: info }, out)
    expect(rawProbe(out).streams.find(s => s.codec_type === 'video')!.codec_name).toBe('h264')
  })

  it('removes the temp file when ffmpeg fails (NVENC without a GPU)', async () => {
    const info = await probeMedia(tools, mpeg4Mkv)
    const dir = await makeTmpDir()
    const err = await preparePreview(tools, { filePath: mpeg4Mkv, media: info }, path.join(dir, 'preview.mp4'), { encoder: 'h264_nvenc' })
      .catch(e => e) as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/ffmpeg 執行失敗/)
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('removes the temp file when the input is missing', async () => {
    const dir = await makeTmpDir()
    await expect(preparePreview(tools, { filePath: path.join(dir, 'gone.mkv'), media: media({ container: 'matroska,webm' }) }, path.join(dir, 'preview.mp4')))
      .rejects.toThrow(/No such file/)
    expect(await fs.readdir(dir)).toEqual([])
  })
})
