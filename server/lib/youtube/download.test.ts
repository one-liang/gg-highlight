// fetchMetadata / downloadVideo / downloadChat end to end against the fake yt-dlp (no network).
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppConfig } from '../config'
import { loadConfig } from '../config'
import { createMetadataCache } from './cache'
import { chatFilePath, chatPartPath } from './command'
import { chatDownloadFailureReason, downloadChat, downloadVideo, lastChatOffsetMs } from './download'
import { fetchMetadata } from './info'
import { FAKE_YTDLP_ERRORS, FAKE_YTDLP_IDS, fakeYtdlpCommand, readArgsLogs } from './test-helpers/fake-yt-dlp.mjs'
import { createYoutubeTools, ytdlpConfigFrom } from './tools'
import { type YtdlpConfig, YtdlpError } from './types'

const IDS = FAKE_YTDLP_IDS
const watch = (id: string) => `https://www.youtube.com/watch?v=${id}`

let dir: string
let logDir: string
let media: string
let stamp: string
let config: YtdlpConfig

function makeConfig(extra: Parameters<typeof fakeYtdlpCommand>[0] = {}): YtdlpConfig {
  return {
    command: fakeYtdlpCommand({ media, logDir, ...extra }),
    ffmpegPath: 'ffmpeg',
    nodePath: process.execPath,
    downloadsDir: path.join(dir, 'downloads'),
    updateStampPath: stamp,
  }
}

/** A tiny script standing in for yt-dlp (receives yt-dlp's argv). */
function script(name: string, body: string): string[] {
  const file = path.join(dir, name)
  // The trailing semicolon keeps a body that starts with `(` from continuing the arrow function.
  fs.writeFileSync(file, `const argv = process.argv.slice(2)\nconst arg = f => argv[argv.indexOf(f) + 1];\n${body}\n`)
  return [process.execPath, file]
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  }
  catch (err) {
    return err
  }
  throw new Error('expected a rejection')
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-ytdlp-'))
  logDir = path.join(dir, 'logs')
  media = path.join(dir, 'source.mkv')
  fs.writeFileSync(media, crypto.randomBytes(64 * 1024))
  stamp = path.join(dir, '.yt-dlp-checked')
  fs.writeFileSync(stamp, 'checked')
  config = makeConfig()
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('fetchMetadata', () => {
  it('reads a live replay with chat and heatmap', async () => {
    const meta = await fetchMetadata(config, watch(IDS.vodChat), { now: () => new Date('2026-11-09T00:00:00Z') })
    expect(meta).toMatchObject({
      id: IDS.vodChat,
      url: watch(IDS.vodChat),
      title: `測試直播重播 ${IDS.vodChat}`,
      channel: '測試頻道',
      durationSec: 60,
      liveStatus: 'was_live',
      uploadDate: '2026-11-01',
      chatAvailable: true,
      heatmapAvailable: true,
      languageHint: 'zh',
      fetchedAt: '2026-11-09T00:00:00.000Z',
    })
    expect(meta.heatmap).toHaveLength(100)
    expect(Math.max(...meta.heatmap!.map(m => m.value))).toBe(1)

    const [log] = readArgsLogs(logDir, IDS.vodChat)
    expect(log!.mode).toBe('metadata')
    expect(log!.argv).toEqual([
      '--no-config', '--no-playlist', '--no-update', '--js-runtimes', `node:${process.execPath}`,
      '-J', '--skip-download', '--', watch(IDS.vodChat),
    ])
    expect(log!.env.PYTHONUTF8).toBe('1')
  })

  it('a normal video has no chat; another has no heatmap', async () => {
    const noChat = await fetchMetadata(config, watch(IDS.noChat))
    expect(noChat).toMatchObject({ liveStatus: 'not_live', chatAvailable: false, heatmapAvailable: true })
    const noHeat = await fetchMetadata(config, watch(IDS.noHeatmap))
    expect(noHeat).toMatchObject({ liveStatus: 'was_live', chatAvailable: true, heatmapAvailable: false, heatmap: null })
  })

  it('honours the fake duration', async () => {
    const meta = await fetchMetadata(makeConfig({ durationSec: 600 }), watch(IDS.vodChat))
    expect(meta.durationSec).toBe(600)
    expect(meta.heatmap!.at(-1)!.end).toBeCloseTo(600)
  })

  it.each([
    [IDS.liveNow, 'live', '還在直播中或還沒開始的直播不能加入，結束後再來'],
    [IDS.postLive, 'post-live', '直播剛結束，YouTube 還在處理重播，請過一段時間再加入'],
    [IDS.private, 'private', '這是私人影片，無法下載（自己的影片可以先在 YouTube Studio 改成「不公開」再加入）'],
    [IDS.botCheck, 'blocked', 'YouTube 暫時拒絕這台電腦的連線（被當成機器人或請求太頻繁），請過一段時間再按「重試」'],
    // A stream that has not started: yt-dlp prints no -J document, only YouTube's reason.
    [IDS.upcoming, 'live', '還在直播中或還沒開始的直播不能加入，結束後再來'],
  ] as const)('%s → %s', async (id, kind, message) => {
    const error = await caught(fetchMetadata(config, watch(id)))
    expect(error).toBeInstanceOf(YtdlpError)
    expect((error as YtdlpError).kind).toBe(kind)
    expect((error as YtdlpError).message).toBe(message)
    // Neither suggests an update.
    expect(fs.existsSync(stamp)).toBe(true)
  })

  it('logs the output of a failure', async () => {
    const lines: string[] = []
    await caught(fetchMetadata(config, watch(IDS.private), { log: m => lines.push(m) }))
    expect(lines.join('\n')).toContain(FAKE_YTDLP_ERRORS.private(IDS.private))
  })

  it('times out (default 90 s; here shorter) and kills yt-dlp', async () => {
    const pidFile = path.join(dir, 'hang.pid')
    const command = script('hang.mjs', `
      const fs = await import('node:fs')
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
      setTimeout(() => {}, 60000)`)
    const started = Date.now()
    const error = await caught(fetchMetadata({ ...config, command }, watch(IDS.vodChat), { timeoutMs: 500 }))
    expect(error).toBeInstanceOf(YtdlpError)
    expect((error as YtdlpError).kind).toBe('timeout')
    expect((error as YtdlpError).message).toBe('向 YouTube 讀取影片資訊逾時，請稍後再試')
    expect((error as YtdlpError).httpStatus).toBe(502)
    expect(Date.now() - started).toBeLessThan(5000)
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    await expect.poll(() => pidAlive(pid)).toBe(false)
  })

  it('an abort stays an AbortError', async () => {
    const controller = new AbortController()
    const command = script('hang.mjs', 'setTimeout(() => {}, 60000)')
    const promise = fetchMetadata({ ...config, command }, watch(IDS.vodChat), { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    const error = await caught(promise)
    expect((error as Error).name).toBe('AbortError')
    expect(error).not.toBeInstanceOf(YtdlpError)
  })

  it('yt-dlp missing → not-installed', async () => {
    const error = await caught(fetchMetadata({ ...config, command: [path.join(dir, 'no-such-yt-dlp')] }, watch(IDS.vodChat)))
    expect(error).toBeInstanceOf(YtdlpError)
    expect((error as YtdlpError).kind).toBe('not-installed')
    expect((error as YtdlpError).message).toBe('找不到 yt-dlp，請重新執行 setup.bat')
    expect(fs.existsSync(stamp)).toBe(true)
  })

  it('output that is not JSON → unknown, and the update stamp goes', async () => {
    const command = script('garbage.mjs', 'console.log("not json")')
    const error = await caught(fetchMetadata({ ...config, command }, watch(IDS.vodChat)))
    expect((error as YtdlpError).kind).toBe('unknown')
    expect((error as YtdlpError).message).toBe('向 YouTube 讀取影片資訊失敗：yt-dlp 沒有回傳影片資訊')
    expect(fs.existsSync(stamp)).toBe(false)
  })

  it('an unknown ERROR line → 向 YouTube 讀取影片資訊失敗：<ERROR line> (nothing was being downloaded)', async () => {
    const command = script('odd.mjs', `console.error('ERROR: [youtube] x: Something new happened'); process.exit(1)`)
    const error = await caught(fetchMetadata({ ...config, command }, watch(IDS.vodChat)))
    expect((error as YtdlpError).kind).toBe('unknown')
    expect((error as YtdlpError).message).toBe('向 YouTube 讀取影片資訊失敗：ERROR: [youtube] x: Something new happened')
  })

  it('offline → network (502), and the update stamp stays', async () => {
    const line = 'ERROR: [youtube] ggVodChat01: Unable to download API page: <urlopen error [Errno 11001] getaddrinfo failed> (caused by TransportError(\'<urlopen error [Errno 11001] getaddrinfo failed>\'))'
    const command = script('offline.mjs', `console.error(${JSON.stringify(line)}); process.exit(1)`)
    const error = await caught(fetchMetadata({ ...config, command }, watch(IDS.vodChat)))
    expect((error as YtdlpError).kind).toBe('network')
    expect((error as YtdlpError).message).toBe('連不到 YouTube 或連線中斷，請確認網路連線後再試')
    expect((error as YtdlpError).httpStatus).toBe(502)
    expect(fs.existsSync(stamp)).toBe(true)
  })

  it('a multi-megabyte -J line is read whole', async () => {
    const command = script('big.mjs', `
      const meta = { _type: 'video', id: 'abcdefghijk', title: '大', duration: 10, automatic_captions: { x: 'y'.repeat(3 * 1024 * 1024) } }
      process.stdout.write(JSON.stringify(meta) + '\\n')`)
    const meta = await fetchMetadata({ ...config, command }, watch('abcdefghijk'))
    expect(meta.title).toBe('大')
  })
})

describe('downloadVideo', () => {
  it('downloads with progress and resolves the absolute path inside downloadsDir', async () => {
    const progress: number[] = []
    const logs: string[] = []
    const file = await downloadVideo(config, { url: watch(IDS.vodChat), videoId: 'video-1', onProgress: f => progress.push(f), log: m => logs.push(m) })
    expect(file).toBe(path.join(config.downloadsDir, 'video-1.mkv'))
    expect(fs.readFileSync(file).equals(fs.readFileSync(media))).toBe(true)
    expect(fs.existsSync(`${file}.part`)).toBe(false)

    expect(progress.length).toBeGreaterThan(4)
    for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!)
    expect(progress.some(f => f > 0 && f < 0.9)).toBe(true)
    expect(progress.some(f => f > 0.9 && f < 1)).toBe(true)
    expect(progress.at(-1)).toBe(1)
    // WARNING lines are logged, not errors.
    expect(logs.some(m => m.startsWith('[yt-dlp] WARNING:'))).toBe(true)

    const [log] = readArgsLogs(logDir, IDS.vodChat)
    expect(log!.mode).toBe('video')
    expect(log!.argv).toContain('--progress-template')
    expect(log!.argv.slice(log!.argv.indexOf('-P'), log!.argv.indexOf('-P') + 4)).toEqual(['-P', config.downloadsDir, '-o', 'video-1.%(ext)s'])
  })

  it('HTTP 403 → outdated, deletes the update stamp, keeps the partial file', async () => {
    const error = await caught(downloadVideo(config, { url: watch(IDS.download403), videoId: 'video-2' }))
    expect(error).toBeInstanceOf(YtdlpError)
    expect((error as YtdlpError).kind).toBe('outdated')
    expect((error as YtdlpError).detail).toBe(FAKE_YTDLP_ERRORS.download403)
    expect(fs.existsSync(stamp)).toBe(false)
    expect(fs.existsSync(path.join(config.downloadsDir, 'video-2.f137.mp4.part'))).toBe(true)
  })

  it('retries used up: the reason after yt-dlp\'s lone \\r stays on the ERROR line (HTTP 403 → outdated)', async () => {
    const error = await caught(downloadVideo(config, { url: watch(IDS.retryErrors), videoId: 'video-9' }))
    expect((error as YtdlpError).kind).toBe('outdated')
    expect((error as YtdlpError).detail).toBe('ERROR: [download] Got error: HTTP Error 403: Forbidden. Giving up after 10 retries')
  })

  it.each([
    ['an unknown reason is shown in full', 'HTTP Error 500: Internal Server Error', 'unknown', '下載失敗：ERROR: [download] Got error: HTTP Error 500: Internal Server Error. Giving up after 10 retries'],
    ['a connection cut off mid-way → network', '1000 bytes read, 999000 more expected', 'network', '連不到 YouTube 或連線中斷，請確認網路連線後再試'],
  ] as const)('retries used up: %s', async (_, reason, kind, message) => {
    // Exactly what yt-dlp writes (Windows Python turns only \n into \r\n; the \r before [download] stays).
    const stderr = `ERROR: \r[download] Got error: ${reason}. Giving up after 10 retries\r\n`
    const command = script('retry.mjs', `process.stderr.write(${JSON.stringify(stderr)}, () => process.exit(1))`)
    const error = await caught(downloadVideo({ ...config, command }, { url: watch(IDS.vodChat), videoId: 'video-10' }))
    expect((error as YtdlpError).kind).toBe(kind)
    expect((error as YtdlpError).message).toBe(message)
  })

  it('without the media file the fake fails → unknown with the raw ERROR line', async () => {
    const error = await caught(downloadVideo(makeConfig({ media: path.join(dir, 'missing.mkv') }), { url: watch(IDS.vodChat), videoId: 'video-3' }))
    expect((error as YtdlpError).kind).toBe('unknown')
    expect((error as YtdlpError).message).toMatch(/^下載失敗：ERROR: \[fake-yt-dlp\]/)
    expect(fs.existsSync(stamp)).toBe(false)
  })

  it('a private video fails before downloading', async () => {
    const error = await caught(downloadVideo(config, { url: watch(IDS.private), videoId: 'video-4' }))
    expect((error as YtdlpError).kind).toBe('private')
    expect(fs.existsSync(stamp)).toBe(true)
  })

  it('exit 0 without a GGFILE line, or with a file outside downloadsDir, is a failure', async () => {
    const noFile = script('nofile.mjs', 'console.log("done")')
    const e1 = await caught(downloadVideo({ ...config, command: noFile }, { url: watch(IDS.vodChat), videoId: 'video-5' }))
    expect((e1 as YtdlpError).kind).toBe('unknown')
    expect((e1 as YtdlpError).message).toBe('下載失敗：yt-dlp 沒有回報下載完成的影片檔')

    const outside = path.join(dir, 'outside.mp4')
    fs.writeFileSync(outside, 'x')
    const elsewhere = script('elsewhere.mjs', `console.log('GGFILE ' + JSON.stringify(${JSON.stringify(outside)}))`)
    const e2 = await caught(downloadVideo({ ...config, command: elsewhere }, { url: watch(IDS.vodChat), videoId: 'video-6' }))
    expect((e2 as YtdlpError).message).toContain('不在下載資料夾裡')

    const ghost = script('ghost.mjs', `
      const path = await import('node:path')
      console.log('GGFILE ' + JSON.stringify(path.join(arg('-P'), 'ghost.mp4')))`)
    const e3 = await caught(downloadVideo({ ...config, command: ghost }, { url: watch(IDS.vodChat), videoId: 'video-7' }))
    expect((e3 as YtdlpError).message).toContain('不存在')
  })

  it('a relative GGFILE path is resolved against downloadsDir', async () => {
    const relative = script('relative.mjs', `
      const fs = await import('node:fs'); const path = await import('node:path')
      fs.mkdirSync(arg('-P'), { recursive: true }); fs.writeFileSync(path.join(arg('-P'), 'video-8.mp4'), 'x')
      console.log('GGFILE "video-8.mp4"')`)
    const file = await downloadVideo({ ...config, command: relative }, { url: watch(IDS.vodChat), videoId: 'video-8' })
    expect(file).toBe(path.join(config.downloadsDir, 'video-8.mp4'))
  })

  it('cancel kills the yt-dlp process and rejects with AbortError', async () => {
    const slow = makeConfig({ slowMs: 200 })
    const controller = new AbortController()
    const progress: number[] = []
    const promise = downloadVideo(slow, {
      url: watch(IDS.slowDownload),
      videoId: 'video-9',
      signal: controller.signal,
      onProgress: (f) => {
        progress.push(f)
        if (progress.length === 2) controller.abort()
      },
    })
    const error = await caught(promise)
    expect((error as Error).name).toBe('AbortError')
    const [log] = readArgsLogs(logDir, IDS.slowDownload)
    await expect.poll(() => pidAlive(log!.pid)).toBe(false)
    // The partial file stays for yt-dlp to resume.
    expect(fs.existsSync(path.join(slow.downloadsDir, 'video-9.mkv.part'))).toBe(true)
    expect(fs.existsSync(path.join(slow.downloadsDir, 'video-9.mkv'))).toBe(false)
    expect(fs.existsSync(stamp)).toBe(true)
  })
})

describe('downloadChat', () => {
  it('writes <videoId>.live_chat.json after deleting a stale .part', async () => {
    fs.mkdirSync(config.downloadsDir, { recursive: true })
    fs.writeFileSync(chatPartPath(config.downloadsDir, 'video-1'), '{"stale": true}\n')
    const progress: number[] = []
    const file = await downloadChat(config, { url: watch(IDS.vodChat), videoId: 'video-1', durationSec: 60, onProgress: f => progress.push(f) })
    expect(file).toBe(chatFilePath(config.downloadsDir, 'video-1'))
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    expect(lines[0]).toContain('liveChatViewerEngagementMessageRenderer')
    expect(lines.some(l => l.includes('stale'))).toBe(false)
    expect(fs.existsSync(chatPartPath(config.downloadsDir, 'video-1'))).toBe(false)
    expect(progress.at(-1)).toBe(1)

    const [log] = readArgsLogs(logDir, IDS.vodChat)
    expect(log!.mode).toBe('chat')
    expect(log!.argv).toEqual([
      '--no-config', '--no-playlist', '--no-update', '--js-runtimes', `node:${process.execPath}`,
      '--skip-download', '--write-subs', '--sub-langs', 'live_chat',
      '-P', config.downloadsDir, '-o', 'video-1.%(ext)s', '--', watch(IDS.vodChat),
    ])
  })

  it('reports progress from the .part while it is written', async () => {
    const slow = makeConfig({ slowMs: 150 })
    const progress: number[] = []
    await downloadChat(slow, { url: watch(IDS.slowDownload), videoId: 'video-2', durationSec: 60, onProgress: f => progress.push(f) }, { pollMs: 20 })
    expect(progress.some(f => f > 0 && f < 1)).toBe(true)
    for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThan(progress[i - 1]!)
    expect(progress.at(-1)).toBe(1)
  })

  it('HTTP 429 → blocked; the 0-byte .part stays, no final file', async () => {
    const error = await caught(downloadChat(config, { url: watch(IDS.chatFail), videoId: 'video-3', durationSec: 60 }))
    expect(error).toBeInstanceOf(YtdlpError)
    expect((error as YtdlpError).kind).toBe('blocked')
    expect((error as YtdlpError).detail).toBe(FAKE_YTDLP_ERRORS.chat429)
    expect(chatDownloadFailureReason(error)).toBe('聊天室重播下載失敗：YouTube 暫時拒絕這台電腦的連線（被當成機器人或請求太頻繁）')
    expect(fs.statSync(chatPartPath(config.downloadsDir, 'video-3')).size).toBe(0)
    expect(fs.existsSync(chatFilePath(config.downloadsDir, 'video-3'))).toBe(false)
    expect(fs.existsSync(stamp)).toBe(true)
  })

  it('retries used up (two ERROR lines with yt-dlp\'s lone \\r): HTTP 429 → blocked', async () => {
    const error = await caught(downloadChat(config, { url: watch(IDS.retryErrors), videoId: 'video-11', durationSec: 60 }))
    expect((error as YtdlpError).kind).toBe('blocked')
    expect((error as YtdlpError).detail).toBe('ERROR: [download] Got error: HTTP Error 429: Too Many Requests. Giving up after 10 retries')
    // The reason names the cause only: a finished Analysis has no 重試 button (the UI names 只重新找精華片段).
    expect(chatDownloadFailureReason(error)).toBe('聊天室重播下載失敗：YouTube 暫時拒絕這台電腦的連線（被當成機器人或請求太頻繁）')
    expect(fs.existsSync(stamp)).toBe(true)
  })

  it('no chat and exit 0 → unknown 聊天室重播下載失敗…', async () => {
    const error = await caught(downloadChat(config, { url: watch(IDS.noChat), videoId: 'video-4', durationSec: 60 }))
    expect((error as YtdlpError).kind).toBe('unknown')
    expect((error as YtdlpError).message).toBe('聊天室重播下載失敗：yt-dlp 沒有寫出聊天室檔案（結束碼 0）')
    expect(chatDownloadFailureReason(error)).toBe('聊天室重播下載失敗：yt-dlp 沒有寫出聊天室檔案（結束碼 0）')
    // An unknown run deletes the update stamp, like any unknown yt-dlp failure.
    expect(fs.existsSync(stamp)).toBe(false)
  })

  it('an unknown ERROR line → unknown 聊天室重播下載失敗：<ERROR line>', async () => {
    const command = script('chat-odd.mjs', `console.error('ERROR: something new'); process.exit(1)`)
    const error = await caught(downloadChat({ ...config, command }, { url: watch(IDS.vodChat), videoId: 'video-8', durationSec: 60 }))
    expect((error as YtdlpError).kind).toBe('unknown')
    expect((error as YtdlpError).message).toBe('聊天室重播下載失敗：ERROR: something new')
    expect((error as YtdlpError).detail).toBe('ERROR: something new')
    expect(chatDownloadFailureReason(error)).toBe('聊天室重播下載失敗：ERROR: something new')
  })

  it('success is the final file, whatever the exit code', async () => {
    const command = script('chat-exit1.mjs', `
      const fs = await import('node:fs'); const path = await import('node:path')
      const base = arg('-o').replace('.%(ext)s', '')
      fs.mkdirSync(arg('-P'), { recursive: true })
      fs.writeFileSync(path.join(arg('-P'), base + '.live_chat.json'), '{}\\n')
      console.error('ERROR: something after the chat was written')
      process.exit(1)`)
    const logs: string[] = []
    const file = await downloadChat({ ...config, command }, { url: watch(IDS.vodChat), videoId: 'video-5', durationSec: 60, log: m => logs.push(m) })
    expect(file).toBe(chatFilePath(config.downloadsDir, 'video-5'))
    expect(logs.join('\n')).toContain('結束碼 1')
  })

  it('an existing final file is kept (yt-dlp skips it)', async () => {
    fs.mkdirSync(config.downloadsDir, { recursive: true })
    fs.writeFileSync(chatFilePath(config.downloadsDir, 'video-6'), 'kept\n')
    const file = await downloadChat(config, { url: watch(IDS.vodChat), videoId: 'video-6', durationSec: 60 })
    expect(fs.readFileSync(file, 'utf8')).toBe('kept\n')
  })

  it('a private video → private', async () => {
    const error = await caught(downloadChat(config, { url: watch(IDS.private), videoId: 'video-7', durationSec: 60 }))
    expect((error as YtdlpError).kind).toBe('private')
  })
})

describe('lastChatOffsetMs', () => {
  it('reads the last complete line, skipping a cut last line', async () => {
    const file = path.join(dir, 'x.live_chat.json.part')
    expect(await lastChatOffsetMs(file)).toBeNull()
    fs.writeFileSync(file, '')
    expect(await lastChatOffsetMs(file)).toBeNull()
    fs.writeFileSync(file, '{"replayChatItemAction":{"actions":[],"videoOffsetTimeMsec":"1500"}}\n{"replayChatItemAction":{"actions":[],"videoOffsetTimeMsec":"2500"}}\n{"replayChatItemAc')
    expect(await lastChatOffsetMs(file)).toBe(2500)
    fs.appendFileSync(file, 'tion":{"actions":[]},"videoOffsetTimeMsec":"3000","isLive":true}\n')
    expect(await lastChatOffsetMs(file)).toBe(3000)
    fs.appendFileSync(file, 'garbage line\n')
    expect(await lastChatOffsetMs(file)).toBe(3000)
  })
})

describe('createYoutubeTools / ytdlpConfigFrom', () => {
  it('builds the app config: downloads dir, stamp only when managed', () => {
    const managed: AppConfig = loadConfig({ GG_DATA_DIR: path.join(dir, 'data') }, dir)
    expect(ytdlpConfigFrom(managed, '/node')).toEqual({
      command: managed.ytdlpCommand,
      ffmpegPath: managed.ffmpegPath,
      nodePath: '/node',
      downloadsDir: path.join(dir, 'data', 'downloads'),
      updateStampPath: path.join(dir, 'tools', '.yt-dlp-checked'),
    })
    const custom = loadConfig({ GG_DATA_DIR: path.join(dir, 'data'), GG_YTDLP_CMD: '["node","fake.mjs"]' }, dir)
    expect(ytdlpConfigFrom(custom)).toMatchObject({ command: ['node', 'fake.mjs'], nodePath: process.execPath, updateStampPath: null })
  })

  it('runs the three operations with one config', async () => {
    const tools = createYoutubeTools(config)
    const cache = createMetadataCache()
    const meta = await tools.fetchMetadata(watch(IDS.vodChat))
    cache.set(meta)
    expect(cache.get(IDS.vodChat)?.title).toBe(meta.title)
    const file = await tools.downloadVideo({ url: meta.url, videoId: 'tools-1' })
    expect(fs.existsSync(file)).toBe(true)
    const chat = await tools.downloadChat({ url: meta.url, videoId: 'tools-1', durationSec: meta.durationSec! })
    expect(fs.existsSync(chat)).toBe(true)
  })
})
