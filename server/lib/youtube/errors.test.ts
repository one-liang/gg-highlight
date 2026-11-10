import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyErrorLine, errorLinesOf, mapYtdlpError, METADATA_FAILED_PREFIX, noteUpdateHint, YTDLP_ERROR_CAUSES, YTDLP_ERROR_MESSAGES, ytdlpErrorCause } from './errors'
import { YtdlpError, type YtdlpErrorKind } from './types'

const E = (text: string) => `ERROR: [youtube] abcdefghijk: ${text}`

const LIVE = '還在直播中或還沒開始的直播不能加入，結束後再來'
const NETWORK = '連不到 YouTube 或連線中斷，請確認網路連線後再試'
const DISK_FULL = '硬碟空間不足，請清出空間後再按「重試」（下載會接著來；合併影音時暫時需要約兩倍的空間）'
/** A connection dropped while the body was read, as a download that used up its retries prints it (urllib3 repr, no "caused by"). */
const broken = (error: string) => `ERROR: [download] Got error: ("Connection broken: ${error}", ${error}). Giving up after 10 retries`

// Every row of design.md「YouTube」's error table, with real or source-derived yt-dlp texts.
const TABLE: Array<[YtdlpErrorKind, string, string]> = [
  ['private', E('Private video. Sign in if you\'ve been granted access to this video. Use --cookies-from-browser or --cookies for the authentication.'), '這是私人影片，無法下載（自己的影片可以先在 YouTube Studio 改成「不公開」再加入）'],
  ['private', E('PRIVATE VIDEO'), '這是私人影片，無法下載（自己的影片可以先在 YouTube Studio 改成「不公開」再加入）'],
  ['members-only', E('Join this channel to get access to members-only content like this video, and other exclusive perks.'), '這是頻道會員限定影片，無法下載'],
  ['members-only', E('This video is available to this channel\'s members on level: Fan (or any higher level). Join this channel to get access'), '這是頻道會員限定影片，無法下載'],
  ['members-only', E('availability subscriber_only'), '這是頻道會員限定影片，無法下載'],
  ['age-restricted', E('Sign in to confirm your age. This video may be inappropriate for some users.'), '這支影片有年齡限制，需要登入才能下載，目前不支援'],
  ['age-restricted', E('This video is age-restricted'), '這支影片有年齡限制，需要登入才能下載，目前不支援'],
  ['geo-blocked', E('The uploader has not made this video available in your country. This video is available in Japan.'), '這支影片在你所在的地區無法觀看'],
  ['geo-blocked', E('This video is not available from your location due to geo restriction'), '這支影片在你所在的地區無法觀看'],
  ['no-recording', E('This live stream recording is not available.'), '這場直播沒有保留重播'],
  // Upcoming streams and premieres have no formats, so yt-dlp fails with YouTube's playability reason.
  ['live', E('This live event will begin in 3 hours.'), LIVE],
  ['live', E('This live event will begin in a few moments.'), LIVE],
  ['live', E('Premieres in 20 hours'), LIVE],
  ['live', E('Premiere will begin shortly'), LIVE],
  ['unavailable', E('Video unavailable'), '影片不存在或已被移除'],
  ['unavailable', E('Video unavailable. This video is not available'), '影片不存在或已被移除'],
  ['unavailable', E('This video has been removed for violating YouTube\'s policy on hate speech.'), '影片不存在或已被移除'],
  ['blocked', E('Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.'), 'YouTube 暫時拒絕這台電腦的連線（被當成機器人或請求太頻繁），請過一段時間再按「重試」'],
  ['blocked', E('Sign in to confirm you\'re not a bot.'), 'YouTube 暫時拒絕這台電腦的連線（被當成機器人或請求太頻繁），請過一段時間再按「重試」'],
  ['blocked', 'ERROR: Unable to download video subtitles for \'live_chat\': HTTP Error 429: Too Many Requests', 'YouTube 暫時拒絕這台電腦的連線（被當成機器人或請求太頻繁），請過一段時間再按「重試」'],
  ['blocked', E('Video unavailable. This content isn\'t available, try again later. The current session has been rate-limited by YouTube for up to an hour.'), 'YouTube 暫時拒絕這台電腦的連線（被當成機器人或請求太頻繁），請過一段時間再按「重試」'],
  ['blocked', E('Your IP is likely being blocked by Youtube'), 'YouTube 暫時拒絕這台電腦的連線（被當成機器人或請求太頻繁），請過一段時間再按「重試」'],
  ['outdated', 'ERROR: unable to download video data: HTTP Error 403: Forbidden', 'YouTube 可能改版了，yt-dlp 需要更新：關掉 gg-highlight 的黑色命令列視窗、再雙擊 start.bat 會自動更新，然後按「重試」'],
  ['outdated', 'ERROR: [youtube] abcdefghijk: Requested format is not available. Use --list-formats for a list of available formats', 'YouTube 可能改版了，yt-dlp 需要更新：關掉 gg-highlight 的黑色命令列視窗、再雙擊 start.bat 會自動更新，然後按「重試」'],
  ['outdated', E('Unable to extract yt initial data'), 'YouTube 可能改版了，yt-dlp 需要更新：關掉 gg-highlight 的黑色命令列視窗、再雙擊 start.bat 會自動更新，然後按「重試」'],
  ['outdated', E('Signature extraction failed: Some formats may be missing'), 'YouTube 可能改版了，yt-dlp 需要更新：關掉 gg-highlight 的黑色命令列視窗、再雙擊 start.bat 會自動更新，然後按「重試」'],
  ['outdated', E('nsig extraction failed: You may experience throttling'), 'YouTube 可能改版了，yt-dlp 需要更新：關掉 gg-highlight 的黑色命令列視窗、再雙擊 start.bat 會自動更新，然後按「重試」'],
  ['ffmpeg-missing', 'ERROR: You have requested merging of multiple formats but ffmpeg is not installed. Aborting due to --abort-on-error', '找不到 FFmpeg，請重新執行 setup.bat'],
  ['ffmpeg-missing', 'ERROR: Postprocessing: ffmpeg not found. Please install or provide the path using --ffmpeg-location', '找不到 FFmpeg，請重新執行 setup.bat'],
  // yt-dlp 2026.10.26 downloader/http.py "unable to write data: {err}", the ffmpeg merge, Windows' own error.
  ['disk-full', 'ERROR: unable to write data: [Errno 28] No space left on device', DISK_FULL],
  ['disk-full', 'ERROR: Postprocessing: Error writing trailer of C:\\gg\\data\\downloads\\abc.temp.mp4: No space left on device', DISK_FULL],
  ['disk-full', 'ERROR: [WinError 112] There is not enough space on the disk', DISK_FULL],
  ['disk-full', 'ERROR: [WinError 112] 磁碟空間不足。', DISK_FULL],
  // Real yt-dlp 2026.10.26 output through an unreachable proxy / a failing TLS check, and Python's texts.
  ['network', E('Unable to download API page: (\'Unable to connect to proxy\', NewConnectionError(\'<urllib3.connection.HTTPSConnection object at 0x7f>: Failed to establish a new connection: [Errno 111] Connection refused\')) (caused by ProxyError("(\'Unable to connect to proxy\', NewConnectionError(...))")); please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template. Confirm you are on the latest version using  yt-dlp -U'), NETWORK],
  ['network', E('Unable to download API page: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed (_ssl.c:1010) (caused by CertificateVerifyError(\'[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed\'))'), NETWORK],
  ['network', E('Unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed> (caused by TransportError(\'<urlopen error [Errno 11001] getaddrinfo failed>\'))'), NETWORK],
  ['network', 'ERROR: [download] Got error: 1000 bytes read, 999000 more expected. Giving up after 10 retries', NETWORK],
  ['network', 'ERROR: [download] Got error: (\'Connection aborted.\', ConnectionResetError(10054, \'遠端主機已強制關閉一個現存的連線。\', None, 10054, None)). Giving up after 10 retries', NETWORK],
  ['network', 'ERROR: [download] Got error: [WinError 10060] 連線嘗試失敗. Giving up after 10 retries', NETWORK],
  ['network', 'ERROR: [download] Got error: The read operation timed out. Giving up after 10 retries', NETWORK],
  // Real yt-dlp 2026.10.26 through a proxy that answers CONNECT with 502, and a reset mid-body (Linux).
  ['network', 'ERROR: [download] Got error: (\'Unable to connect to proxy\', OSError(\'Tunnel connection failed: 502 Bad Gateway\')). Giving up after 10 retries', NETWORK],
  ['network', broken('ConnectionResetError(104, \'Connection reset by peer\')'), NETWORK],
  // The same reset and an abort on Windows: the error code only in repr form, the message in the OS language.
  ['network', broken('ConnectionResetError(10054, \'An existing connection was forcibly closed by the remote host\', None, 10054, None)'), NETWORK],
  ['network', broken('ConnectionResetError(10054, \'遠端主機已強制關閉一個現存的連線。\', None, 10054, None)'), NETWORK],
  ['network', broken('ConnectionAbortedError(10053, \'連線已被您主機上的軟體中止。\', None, 10053, None)'), NETWORK],
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

  it('more specific rows win over the network row (HTTP 429 / 403 also start with "Unable to download")', () => {
    expect(classifyErrorLine(E('Unable to download API page: HTTP Error 429: Too Many Requests (caused by <HTTPError 429: Too Many Requests>)'))).toBe('blocked')
    expect(classifyErrorLine(E('Unable to download webpage: HTTP Error 403: Forbidden (caused by <HTTPError 403: Forbidden>)'))).toBe('outdated')
    expect(classifyErrorLine('ERROR: [download] Got error: HTTP Error 403: Forbidden. Giving up after 10 retries')).toBe('outdated')
    // A server error under retries is not a known row: shown with its reason.
    expect(classifyErrorLine('ERROR: [download] Got error: HTTP Error 500: Internal Server Error. Giving up after 10 retries')).toBe('unknown')
  })

  it('a Windows network error code counts in [WinError N] and in repr form, other numbers do not', () => {
    expect(classifyErrorLine('ERROR: [download] Got error: ConnectionResetError(10054, \'x\', None, 10054, None). Giving up after 10 retries')).toBe('network')
    expect(classifyErrorLine('ERROR: [download] Got error: TimeoutError(10060, \'連線嘗試失敗\', None, 10060, None). Giving up after 10 retries')).toBe('network')
    expect(classifyErrorLine('ERROR: [download] Got error: OSError(100540, \'x\'). Giving up after 10 retries')).toBe('unknown')
    expect(classifyErrorLine('ERROR: [download] Got error: [Errno 280] x. Giving up after 10 retries')).toBe('unknown')
  })

  it('a full disk is not an "update yt-dlp" hint and wins over the YouTube-side rows', () => {
    const error = mapYtdlpError(['ERROR: unable to download video data: HTTP Error 403: Forbidden', 'ERROR: unable to write data: [Errno 28] No space left on device'], { code: 1 })
    expect(error.kind).toBe('disk-full')
    expect(error.suggestsUpdate).toBe(false)
    expect(error.httpStatus).toBe(502)
    expect(ytdlpErrorCause(error)).toBe('硬碟空間不足')
  })

  it('upcoming and network failures are not "update yt-dlp" hints: 422 / 502 and the stamp stays', () => {
    const upcoming = mapYtdlpError([E('This live event will begin in 3 hours.')], { code: 1 })
    expect(upcoming.httpStatus).toBe(422)
    expect(upcoming.suggestsUpdate).toBe(false)
    const network = mapYtdlpError([E('Unable to download API page: <urlopen error [Errno 11001] getaddrinfo failed> (caused by TransportError(\'x\'))')], { code: 1 })
    expect(network.httpStatus).toBe(502)
    expect(network.suggestsUpdate).toBe(false)
  })

  it('the priority follows the table order (the earliest row matching any ERROR line wins)', () => {
    const kinds = (lines: string[]) => mapYtdlpError(lines, { code: 1 }).kind
    expect(kinds(['ERROR: unable to download video data: HTTP Error 403: Forbidden', E('Video unavailable')])).toBe('outdated')
    expect(kinds(['ERROR: HTTP Error 429: Too Many Requests', 'ERROR: Postprocessing: ffmpeg not found'])).toBe('ffmpeg-missing')
    expect(kinds([E('Video unavailable'), E('This live event will begin in 3 hours.')])).toBe('live')
    expect(kinds([E('Video unavailable'), 'ERROR: [download] Got error: The read operation timed out. Giving up after 10 retries'])).toBe('network')
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

  it('a -J read names what failed: 向 YouTube 讀取影片資訊失敗：<raw ERROR line>', () => {
    const line = 'ERROR: [youtube] abcdefghijk: Something new happened'
    expect(mapYtdlpError([line], { code: 1 }, undefined, METADATA_FAILED_PREFIX).message).toBe(`向 YouTube 讀取影片資訊失敗：${line}`)
    expect(mapYtdlpError([], { code: 1 }, undefined, METADATA_FAILED_PREFIX).message).toBe('向 YouTube 讀取影片資訊失敗：yt-dlp 異常結束（結束碼 1）')
    expect(mapYtdlpError([E('Private video')], { code: 1 }, undefined, METADATA_FAILED_PREFIX).message).toBe('這是私人影片，無法下載（自己的影片可以先在 YouTube Studio 改成「不公開」再加入）')
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

describe('ytdlpErrorCause: the reason without an action, for places without a 重試 button', () => {
  it('drops the 「…按「重試」」 / 請…再試 action of the kinds that have one', () => {
    expect(ytdlpErrorCause(new YtdlpError('blocked', YTDLP_ERROR_MESSAGES.blocked!))).toBe('YouTube 暫時拒絕這台電腦的連線（被當成機器人或請求太頻繁）')
    expect(ytdlpErrorCause(new YtdlpError('outdated', YTDLP_ERROR_MESSAGES.outdated!))).toBe('YouTube 可能改版了，yt-dlp 需要更新（關掉 gg-highlight 的黑色命令列視窗、再雙擊 start.bat 會自動更新）')
    expect(ytdlpErrorCause(new YtdlpError('network', YTDLP_ERROR_MESSAGES.network!))).toBe('連不到 YouTube 或連線中斷')
    expect(ytdlpErrorCause(new YtdlpError('timeout', YTDLP_ERROR_MESSAGES.timeout!))).toBe('向 YouTube 讀取影片資訊逾時')
    for (const cause of Object.values(YTDLP_ERROR_CAUSES)) expect(cause).not.toMatch(/重試|再試/)
  })

  it('keeps other messages; an unknown error loses only the generic 下載失敗：', () => {
    expect(ytdlpErrorCause(new YtdlpError('private', YTDLP_ERROR_MESSAGES.private!))).toBe('這是私人影片，無法下載（自己的影片可以先在 YouTube Studio 改成「不公開」再加入）')
    expect(ytdlpErrorCause(mapYtdlpError(['ERROR: something new'], { code: 1 }))).toBe('ERROR: something new')
    expect(ytdlpErrorCause(new YtdlpError('unknown', '向 YouTube 讀取影片資訊失敗：ERROR: x'))).toBe('向 YouTube 讀取影片資訊失敗：ERROR: x')
    expect(ytdlpErrorCause(new YtdlpError('unknown', '', 'detail'))).toBe('detail')
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
    await noteUpdateHint(new YtdlpError('network', 'x'), { updateStampPath: file })
    await noteUpdateHint(new YtdlpError('disk-full', 'x'), { updateStampPath: file })
    await noteUpdateHint(new YtdlpError('live', 'x'), { updateStampPath: file })
    await noteUpdateHint(new Error('boom'), { updateStampPath: file })
    await noteUpdateHint(new YtdlpError('outdated', 'x'), { updateStampPath: null })
    expect(fs.existsSync(file)).toBe(true)
  })

  it('ignores a missing stamp', async () => {
    await expect(noteUpdateHint(new YtdlpError('unknown', 'x'), { updateStampPath: path.join(os.tmpdir(), 'gg-no-such-dir', 'stamp') })).resolves.toBeUndefined()
  })
})
