import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  baseArgs, chatDownloadArgs, chatFilePath, chatPartPath, metadataArgs, PROGRESS_TEMPLATE, usableFfmpegLocation,
  videoDownloadArgs,
} from './command'

const NODE = '/opt/node/bin/node'
const DOWNLOADS = path.resolve('/data/downloads')
const URL = 'https://www.youtube.com/watch?v=ggVodChat01'
const config = { ffmpegPath: 'ffmpeg', nodePath: NODE, downloadsDir: DOWNLOADS }
const BASE = ['--no-config', '--no-playlist', '--no-update', '--js-runtimes', `node:${NODE}`]

describe('ffmpeg location', () => {
  it('is passed only for an existing absolute path', () => {
    const abs = path.resolve('/tools/ffmpeg/bin/ffmpeg')
    expect(usableFfmpegLocation(abs, () => true)).toBe(true)
    expect(usableFfmpegLocation(abs, () => false)).toBe(false)
    expect(usableFfmpegLocation('ffmpeg', () => true)).toBe(false)
    expect(usableFfmpegLocation('bin/ffmpeg', () => true)).toBe(false)
    expect(baseArgs({ ffmpegPath: abs, nodePath: NODE }, () => true)).toEqual([...BASE, '--ffmpeg-location', abs])
    expect(baseArgs({ ffmpegPath: abs, nodePath: NODE }, () => false)).toEqual(BASE)
  })

  it('checks the real file system by default', () => {
    expect(usableFfmpegLocation(process.execPath)).toBe(true)
    expect(usableFfmpegLocation(path.resolve('/no/such/ffmpeg'))).toBe(false)
  })
})

describe('argv builders', () => {
  it('base flags: no config, no playlist, no self-update, Node as JS runtime', () => {
    expect(baseArgs(config)).toEqual(BASE)
  })

  it('metadata: -J without downloading, URL after --', () => {
    expect(metadataArgs(config, URL)).toEqual([...BASE, '-J', '--skip-download', '--', URL])
  })

  it('video download: format, sort, merge, output, progress and final path', () => {
    expect(videoDownloadArgs(config, URL, 'vid-1')).toEqual([
      ...BASE,
      '-f', 'bv*+ba/b',
      '-S', 'res:1080,vcodec:h264,acodec:aac',
      '--merge-output-format', 'mp4',
      '-P', DOWNLOADS,
      '-o', 'vid-1.%(ext)s',
      '--newline',
      '--progress',
      '--progress-delta', '1',
      '--progress-template',
      'download:GGDL %(info.format_id)s %(progress.{status,downloaded_bytes,total_bytes,total_bytes_estimate,fragment_index,fragment_count})j',
      '--print', 'after_move:GGFILE %(filepath)j',
      '--', URL,
    ])
    expect(PROGRESS_TEMPLATE.startsWith('download:GGDL ')).toBe(true)
  })

  it('chat download: subtitles only, live_chat, same output name', () => {
    expect(chatDownloadArgs(config, URL, 'vid-1')).toEqual([
      ...BASE,
      '--skip-download',
      '--write-subs',
      '--sub-langs', 'live_chat',
      '-P', DOWNLOADS,
      '-o', 'vid-1.%(ext)s',
      '--', URL,
    ])
  })

  it('refuses a video id that would be template syntax or a path', () => {
    for (const bad of ['', '../x', 'a/b', 'a%(id)s', '-x', 'a b']) {
      expect(() => videoDownloadArgs(config, URL, bad)).toThrow()
      expect(() => chatDownloadArgs(config, URL, bad)).toThrow()
    }
  })

  it('a URL that looks like a flag stays after --', () => {
    const args = metadataArgs(config, '-weird')
    expect(args.slice(-2)).toEqual(['--', '-weird'])
  })
})

describe('chat file names', () => {
  it('follow yt-dlp subtitle naming <name without ext>.live_chat.json', () => {
    expect(chatFilePath(DOWNLOADS, 'vid-1')).toBe(path.join(DOWNLOADS, 'vid-1.live_chat.json'))
    expect(chatPartPath(DOWNLOADS, 'vid-1')).toBe(path.join(DOWNLOADS, 'vid-1.live_chat.json.part'))
  })
})
