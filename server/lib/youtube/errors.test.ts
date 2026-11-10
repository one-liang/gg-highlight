import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyErrorLine, errorLinesOf, mapYtdlpError, noteUpdateHint, YTDLP_ERROR_MESSAGES } from './errors'
import { YtdlpError, type YtdlpErrorKind } from './types'

const E = (text: string) => `ERROR: [youtube] abcdefghijk: ${text}`

// Every row of design.md「YouTube」's error table, with real or source-derived yt-dlp texts.
const TABLE: Array<[YtdlpErrorKind, string, string]> = [
  ['private', E('Private video. Sign in if you\'ve been granted access to this video. Use --cookies-from-browser or --cookies for the authentication.'), '這是私人影片，無法下載'],
  ['private', E('PRIVATE VIDEO'), '這是私人影片，無法下載'],
  ['members-only', E('Join this channel to get access to members-only content like this video, and other exclusive perks.'), '這是頻道會員限定影片，無法下載'],
  ['members-only', E('This video is available to this channel\'s members on level: Fan (or any higher level). Join this channel to get access'), '這是頻道會員限定影片，無法下載'],
  ['members-only', E('availability subscriber_only'), '這是頻道會員限定影片，無法下載'],
  ['age-restricted', E('Sign in to confirm your age. This video may be inappropriate for some users.'), '這支影片有年齡限制，需要登入才能下載，目前不支援'],
  ['age-restricted', E('This video is age-restricted'), '這支影片有年齡限制，需要登入才能下載，目前不支援'],
  ['geo-blocked', E('The uploader has not made this video available in your country. This video is available in Japan.'), '這支影片在你所在的地區無法觀看'],
  ['geo-blocked', E('This video is not available from your location due to geo restriction'), '這支影片在你所在的地區無法觀看'],
  ['no-recording', E('This live stream recording is not available.'), '這場直播沒有保留重播'],
  ['unavailable', E('Video unavailable'), '影片不存在或已被移除'],
  ['unavailable', E('Video unavailable. This video is not available'), '影片不存在或已被移除'],
  ['unavailable', E('This video has been removed for violating YouTube\'s policy on hate speech.'), '影片不存在或已被移除'],
  ['blocked', E('Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.'), 'YouTube 暫時拒絕這台電腦的連線（被當成機器人或請求太頻繁），請過一段時間再按「重試」'],
  ['blocked', E('Sign in to confirm you\'re not a bot.'), 'YouTube 暫時拒絕這台電腦的連線（被當成機器人或請求太頻繁），請過一段時間再按「重試」'],
  ['blocked', 'ERROR: Unable to download video subtitles for \'live_chat\': HTTP Error 429: Too Many Requests', 'YouTube 暫時拒絕這台電腦的連線（被當成機器人或請求太頻繁），請過一段時間再按「重試」'],
  ['blocked', E('Video unavailable. This content isn\'t available, try again later. The current session has been rate-limited by YouTube for up to an hour.'), 'YouTube 暫時拒絕這台電腦的連線（被當成機器人或請求太頻繁），請過一段時間再按「重試」'],
  ['blocked', E('Your IP is likely being blocked by Youtube'), 'YouTube 暫時拒絕這台電腦的連線（被當成機器人或請求太頻繁），請過一段時間再按「重試」'],
  ['outdated', 'ERROR: unable to download video data: HTTP Error 403: Forbidden', 'YouTube 可能改版了，yt-dlp 需要更新：關掉 gg-highlight 再重新開啟會自動更新，然後按「重試」'],
  ['outdated', 'ERROR: [youtube] abcdefghijk: Requested format is not available. Use --list-formats for a list of available formats', 'YouTube 可能改版了，yt-dlp 需要更新：關掉 gg-highlight 再重新開啟會自動更新，然後按「重試」'],
  ['outdated', E('Unable to extract yt initial data'), 'YouTube 可能改版了，yt-dlp 需要更新：關掉 gg-highlight 再重新開啟會自動更新，然後按「重試」'],
  ['outdated', E('Signature extraction failed: Some formats may be missing'), 'YouTube 可能改版了，yt-dlp 需要更新：關掉 gg-highlight 再重新開啟會自動更新，然後按「重試」'],
  ['outdated', E('nsig extraction failed: You may experience throttling'), 'YouTube 可能改版了，yt-dlp 需要更新：關掉 gg-highlight 再重新開啟會自動更新，然後按「重試」'],
  ['ffmpeg-missing', 'ERROR: You have requested merging of multiple formats but ffmpeg is not installed. Aborting due to --abort-on-error', '找不到 FFmpeg，請重新執行 setup.bat'],
  ['ffmpeg-missing', 'ERROR: Postprocessing: ffmpeg not found. Please install or provide the path using --ffmpeg-location', '找不到 FFmpeg，請重新執行 setup.bat'],
  ['js-runtime-missing', E('No supported JavaScript runtime could be found.'), '找不到 yt-dlp 需要的 JavaScript 執行環境，請重新執行 setup.bat'],
]

describe('mapYtdlpError: design.md error table', () => {
  it.each(TABLE)('%s ← %s', (kind, line, message) => {
    const error = mapYtdlpError(['[youtube] Extracting URL: https://www.youtube.com/watch?v=abcdefghijk', line], { code: 1 })
    expect(error).toBeInstanceOf(YtdlpError)
    expect(error.kind).toBe(kind)
    expect(error.message).toBe(message)
    expect(error.detail).toBe(line)
    expect(classifyErrorLine(line)).toBe(kind)
  })

  it('anything else → 下載失敗：<raw ERROR line>', () => {
    const line = 'ERROR: [youtube] abcdefghijk: Something new happened'
    const error = mapYtdlpError([line], { code: 1 })
    expect(error.kind).toBe('unknown')
    expect(error.message).toBe(`下載失敗：${line}`)
    expect(error.detail).toBe(line)
    expect(error.suggestsUpdate).toBe(true)
    expect(error.httpStatus).toBe(502)
  })

  it('maps only ERROR lines; WARNING lines never decide', () => {
    const lines = [
      'WARNING: [youtube] abcdefghijk: Private video warning text, HTTP Error 403',
      'WARNING: [youtube] No supported JavaScript runtime could be found.',
      'ERROR: [youtube] abcdefghijk: Something new happened',
    ]
    expect(mapYtdlpError(lines, { code: 1 }).kind).toBe('unknown')
    expect(errorLinesOf(lines)).toEqual([lines[2]])
  })

  it('across several ERROR lines the more specific row wins; unknown takes the last line', () => {
    expect(mapYtdlpError(['ERROR: first odd thing', E('Private video')], { code: 1 }).kind).toBe('private')
    const error = mapYtdlpError(['ERROR: first odd thing', 'ERROR: second odd thing'], { code: 1 })
    expect(error.message).toBe('下載失敗：ERROR: second odd thing')
  })

  it('without any ERROR line names the exit status, or uses the fallback', () => {
    expect(mapYtdlpError(['some output'], { code: 2 }).message).toBe('下載失敗：yt-dlp 異常結束（結束碼 2）')
    expect(mapYtdlpError([], { code: null, signal: 'SIGKILL' }).message).toBe('下載失敗：yt-dlp 異常結束（被訊號 SIGKILL 終止）')
    expect(mapYtdlpError([], { code: 0 }, '自訂訊息').message).toBe('自訂訊息')
    expect(mapYtdlpError([], { code: 0 }, '自訂訊息').kind).toBe('unknown')
  })

  it('content problems are 422, tool/upstream problems 502', () => {
    expect(mapYtdlpError([E('Private video')]).httpStatus).toBe(422)
    expect(mapYtdlpError([E('Video unavailable')]).httpStatus).toBe(422)
    expect(mapYtdlpError([E('Sign in to confirm you’re not a bot')]).httpStatus).toBe(502)
    expect(mapYtdlpError(['ERROR: HTTP Error 403: Forbidden']).httpStatus).toBe(502)
  })

  it('every mapped kind has its message', () => {
    for (const [kind] of TABLE) expect(YTDLP_ERROR_MESSAGES[kind]).toBeTruthy()
  })
})

describe('noteUpdateHint', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })
  const stamp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-ytdlp-stamp-'))
    dirs.push(dir)
    const file = path.join(dir, '.yt-dlp-checked')
    fs.writeFileSync(file, '2026-11-09T00:00:00Z')
    return file
  }

  it('deletes the update stamp for outdated and unknown errors', async () => {
    for (const error of [new YtdlpError('outdated', 'x'), new YtdlpError('unknown', 'x')]) {
      const file = stamp()
      await noteUpdateHint(error, { updateStampPath: file })
      expect(fs.existsSync(file)).toBe(false)
    }
  })

  it('keeps it for other errors, non-YtdlpErrors and when unmanaged', async () => {
    const file = stamp()
    await noteUpdateHint(new YtdlpError('private', 'x'), { updateStampPath: file })
    await noteUpdateHint(new YtdlpError('blocked', 'x'), { updateStampPath: file })
    await noteUpdateHint(new Error('boom'), { updateStampPath: file })
    await noteUpdateHint(new YtdlpError('outdated', 'x'), { updateStampPath: null })
    expect(fs.existsSync(file)).toBe(true)
  })

  it('ignores a missing stamp', async () => {
    await expect(noteUpdateHint(new YtdlpError('unknown', 'x'), { updateStampPath: path.join(os.tmpdir(), 'gg-no-such-dir', 'stamp') })).resolves.toBeUndefined()
  })
})
