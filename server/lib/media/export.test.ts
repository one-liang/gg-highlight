import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Layout, MediaInfo } from '../../../shared/types/domain'
import { buildExportArgs, buildFilterGraph, exportClip, fontsReady, formatSeconds, outputSizeFor } from './export'
import { probeMedia } from './probe'
import { CJK_FONT, countDiff, fx, grayFrame, installFont, makeTmpDir, minimalAss, rawProbe, tools } from './test-utils'
import type { ExportJob } from './types'

function media(width: number, height: number): MediaInfo {
  return { durationSec: 60, width, height, fps: 30, videoCodec: 'h264', container: 'matroska,webm', audioTracks: [] }
}

describe('outputSizeFor', () => {
  it('uses 1080x1920 for the vertical layouts', () => {
    expect(outputSizeFor('blurred-background', media(1920, 1080))).toEqual({ width: 1080, height: 1920 })
    expect(outputSizeFor('center-crop', media(640, 360))).toEqual({ width: 1080, height: 1920 })
  })

  it('keeps the source size for original, capped at 1080p on the shorter side, even dims', () => {
    expect(outputSizeFor('original', media(1280, 720))).toEqual({ width: 1280, height: 720 })
    expect(outputSizeFor('original', media(1920, 1080))).toEqual({ width: 1920, height: 1080 })
    expect(outputSizeFor('original', media(3840, 2160))).toEqual({ width: 1920, height: 1080 })
    expect(outputSizeFor('original', media(2560, 1440))).toEqual({ width: 1920, height: 1080 })
    expect(outputSizeFor('original', media(3440, 1440))).toEqual({ width: 2580, height: 1080 })
    expect(outputSizeFor('original', media(1440, 2560))).toEqual({ width: 1080, height: 1920 })
    expect(outputSizeFor('original', media(1080, 1920))).toEqual({ width: 1080, height: 1920 })
    expect(outputSizeFor('original', media(1279, 719))).toEqual({ width: 1278, height: 718 })
    expect(outputSizeFor('original', media(2000, 1125))).toEqual({ width: 1920, height: 1080 })
  })
})

describe('formatSeconds', () => {
  it('prints plain decimals with ms precision', () => {
    expect(formatSeconds(12.5)).toBe('12.5')
    expect(formatSeconds(1 / 3)).toBe('0.333')
    expect(formatSeconds(1e-7)).toBe('0')
    expect(formatSeconds(3600)).toBe('3600')
  })
})

describe('buildExportArgs', () => {
  const job: ExportJob = {
    input: '/videos/in.mkv',
    media: media(1920, 1080),
    start: 61.25,
    end: 91.5,
    layout: 'blurred-background',
    assPath: '/data/clips/v1/c1.ass',
    fontsDir: '/app/fonts',
    output: '/data/clips/v1/c1.mp4',
    encoder: 'libx264',
  }

  it('seeks on the input, cuts the duration, maps [v] and audio track 0, and keeps the frame rate', () => {
    const args = buildExportArgs(job)
    expect(args.slice(0, 6)).toEqual(['-ss', '61.25', '-i', '/videos/in.mkv', '-t', '30.25'])
    expect(args[6]).toBe('-filter_complex')
    expect(args[7]).toMatch(/\[v\]$/)
    expect(args.slice(8, 12)).toEqual(['-map', '[v]', '-map', '0:a:0?'])
    expect(args.join(' ')).toContain('-c:v libx264 -preset veryfast -crf 20 -profile:v high -pix_fmt yuv420p')
    expect(args.join(' ')).toContain('-c:a aac -b:a 160k -ac 2 -movflags +faststart -sn -dn')
    expect(args).not.toContain('-r')
    expect(args.at(-1)).toBe('/data/clips/v1/c1.mp4')
  })

  it('uses NVENC settings when asked', () => {
    const args = buildExportArgs({ ...job, encoder: 'h264_nvenc' }).join(' ')
    expect(args).toContain('-c:v h264_nvenc -preset p5 -tune hq -rc vbr -cq 21 -b:v 0 -profile:v high -pix_fmt yuv420p')
    expect(args).not.toContain('libx264')
  })

  it('builds a blurred-background graph: blurred backdrop + fitted foreground, then setsar and subtitles', () => {
    const graph = buildFilterGraph(job)
    expect(graph).toBe('[0:v:0]split=2[bgsrc][fgsrc];'
      + '[bgsrc]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,gblur=sigma=12,scale=1080:1920[bg];'
      + '[fgsrc]scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2[fg];'
      + '[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,'
      + 'subtitles=filename=/data/clips/v1/c1.ass:fontsdir=/app/fonts[v]')
  })

  it('builds center-crop and original graphs, and omits subtitles without an ASS file', () => {
    expect(buildFilterGraph({ ...job, layout: 'center-crop', assPath: null }))
      .toBe('[0:v:0]crop=w=trunc(min(iw\\,ih*9/16)/2)*2:h=trunc(min(ih\\,iw*16/9)/2)*2,scale=1080:1920,setsar=1[v]')
    expect(buildFilterGraph({ ...job, layout: 'original', media: media(2560, 1440), assPath: null }))
      .toBe('[0:v:0]scale=1920:1080,setsar=1[v]')
  })

  it('escapes the subtitle and font paths', () => {
    const graph = buildFilterGraph({ ...job, assPath: 'C:\\Users\\me\\it\'s [1].ass', fontsDir: 'C:\\gg highlight\\fonts' })
    expect(graph).toContain('subtitles=filename=C\\\\:/Users/me/it\\\\\\\'s \\[1\\].ass:fontsdir=C\\\\:/gg highlight/fonts[v]')
  })

  it('rejects an empty or inverted range', () => {
    expect(() => buildExportArgs({ ...job, start: 5, end: 5 })).toThrow('剪輯的起訖時間不正確')
    expect(() => buildExportArgs({ ...job, start: -1, end: 5 })).toThrow('剪輯的起訖時間不正確')
    expect(() => buildExportArgs({ ...job, start: 0, end: Number.NaN })).toThrow('剪輯的起訖時間不正確')
  })
})

describe('exportClip (real ffmpeg)', () => {
  let sample: MediaInfo
  beforeAll(async () => {
    sample = await probeMedia(tools, fx.sampleEnMkv)
  })

  function baseJob(over: Partial<ExportJob> & { output: string }): ExportJob {
    return {
      input: fx.sampleEnMkv,
      media: sample,
      start: 1,
      end: 3,
      layout: 'blurred-background',
      assPath: null,
      fontsDir: CJK_FONT ? path.dirname(CJK_FONT) : os.tmpdir(),
      encoder: 'libx264',
      ...over,
    }
  }

  const layouts: Array<[Layout, number, number]> = [
    ['blurred-background', 1080, 1920],
    ['center-crop', 1080, 1920],
    ['original', 1280, 720],
  ]
  for (const [layout, width, height] of layouts) {
    it(`exports ${layout} as ${width}x${height} h264/yuv420p + stereo aac, 2 s, source fps, progress to 1`, async () => {
      const dir = await makeTmpDir()
      const output = path.join(dir, 'clips', `${layout}.mp4`)
      const seen: number[] = []
      await exportClip(tools, baseJob({ layout, output }), { onProgress: v => seen.push(v) })
      const raw = rawProbe(output)
      const v = raw.streams.find(s => s.codec_type === 'video')!
      const a = raw.streams.filter(s => s.codec_type === 'audio')
      expect(v).toMatchObject({ codec_name: 'h264', width, height, pix_fmt: 'yuv420p', profile: 'High', avg_frame_rate: '30/1' })
      expect(a).toHaveLength(1)
      expect(a[0]).toMatchObject({ codec_name: 'aac', channels: 2 })
      expect(Math.abs(Number(raw.format.duration) - 2)).toBeLessThan(0.15)
      expect(seen.at(-1)).toBe(1)
      for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!)
      expect(await fs.readdir(path.dirname(output))).toEqual([`${layout}.mp4`])
    })
  }

  it('exports a video without audio (no audio stream in the clip)', async () => {
    const dir = await makeTmpDir()
    const output = path.join(dir, 'noaudio.mp4')
    const info = await probeMedia(tools, fx.noAudioMp4)
    await exportClip(tools, baseJob({ input: fx.noAudioMp4, media: info, start: 0.5, end: 2.5, layout: 'center-crop', output }))
    const raw = rawProbe(output)
    expect(raw.streams.map(s => s.codec_type)).toEqual(['video'])
    expect(raw.streams[0]).toMatchObject({ width: 1080, height: 1920 })
    expect(Math.abs(Number(raw.format.duration) - 2)).toBeLessThan(0.15)
  })

  it('keeps a vertical source vertical with the original layout', async () => {
    const dir = await makeTmpDir()
    const output = path.join(dir, 'vertical.mp4')
    const info = await probeMedia(tools, fx.verticalMp4)
    await exportClip(tools, baseJob({ input: fx.verticalMp4, media: info, start: 0, end: 2, layout: 'original', output }))
    const raw = rawProbe(output)
    expect(raw.streams.find(s => s.codec_type === 'video')).toMatchObject({ width: 720, height: 1280 })
    expect(raw.streams.filter(s => s.codec_type === 'audio')).toHaveLength(1)
  })

  it.skipIf(!CJK_FONT)('burns ASS subtitles from a folder with tricky characters, using fontsdir', async () => {
    const root = await makeTmpDir()
    const clipDir = path.join(root, process.platform === 'win32' ? 'it\'s [clip], x;y 中文' : 'it\'s [clip], x;y c:d 中文')
    const fontsDir = path.join(root, '字型 [fonts], it\'s;x')
    await fs.mkdir(clipDir, { recursive: true })
    await fs.mkdir(fontsDir, { recursive: true })
    await installFont(fontsDir)
    const assPath = path.join(clipDir, 'clip [1].ass')
    await fs.writeFile(assPath, minimalAss('大家好 精華字幕'))

    const withSubs = path.join(clipDir, 'with.mp4')
    const without = path.join(clipDir, 'without.mp4')
    await exportClip(tools, baseJob({ layout: 'center-crop', assPath, fontsDir, output: withSubs }))
    await exportClip(tools, baseJob({ layout: 'center-crop', assPath: null, fontsDir, output: without }))

    const a = grayFrame(withSubs, 1)
    const b = grayFrame(without, 1)
    expect(a.length).toBe(1080 * 1920)
    // Text sits bottom-centre (MarginV 320 on a 1920-high canvas); the top of the frame is untouched.
    expect(countDiff(a, b, 1080, 1300, 1920)).toBeGreaterThan(5000)
    expect(countDiff(a, b, 1080, 0, 900)).toBeLessThan(1080 * 900 * 0.01)
    expect((await fs.readdir(clipDir)).sort()).toEqual(['clip [1].ass', 'with.mp4', 'without.mp4'])
  })

  it('aborts mid-export with AbortError and leaves no output or temp file', async () => {
    const dir = await makeTmpDir()
    const output = path.join(dir, 'aborted.mp4')
    const controller = new AbortController()
    const seen: number[] = []
    const timer = setTimeout(() => controller.abort(), 1500)
    const err = await exportClip(tools, baseJob({ start: 0, end: sample.durationSec, output }), {
      signal: controller.signal,
      onProgress: (v) => {
        seen.push(v)
        controller.abort()
      },
    }).catch(e => e) as Error
    clearTimeout(timer)
    expect(err.name).toBe('AbortError')
    expect(seen.at(-1) ?? 0).toBeLessThan(1)
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('fails with readable messages for a missing input or ASS file, leaving nothing behind', async () => {
    const dir = await makeTmpDir()
    const output = path.join(dir, 'x.mp4')
    await expect(exportClip(tools, baseJob({ input: path.join(dir, 'gone.mkv'), output }))).rejects.toThrow('找不到原始影片檔')
    await expect(exportClip(tools, baseJob({ assPath: path.join(dir, 'gone.ass'), output }))).rejects.toThrow('找不到字幕檔')
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('removes the temp file when the encoder fails (NVENC without a GPU)', async () => {
    const dir = await makeTmpDir()
    const err = await exportClip(tools, baseJob({ encoder: 'h264_nvenc', output: path.join(dir, 'nvenc.mp4') })).catch(e => e) as Error
    expect(err.message).toMatch(/ffmpeg 執行失敗/)
    expect(await fs.readdir(dir)).toEqual([])
  })
})

describe('fontsReady', () => {
  it('is true only when the folder holds an .otf/.ttf/.ttc file', async () => {
    const dir = await makeTmpDir()
    expect(await fontsReady(path.join(dir, 'missing'))).toBe(false)
    expect(await fontsReady(dir)).toBe(false)
    await fs.writeFile(path.join(dir, 'readme.txt'), 'x')
    await fs.mkdir(path.join(dir, 'sub.ttf'))
    expect(await fontsReady(dir)).toBe(false)
    await fs.writeFile(path.join(dir, 'NotoSansCJKtc-Bold.OTF'), 'x')
    expect(await fontsReady(dir)).toBe(true)
    if (CJK_FONT) expect(await fontsReady(path.dirname(CJK_FONT))).toBe(true)
  })
})
