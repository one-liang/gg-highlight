// yt-dlp's English ERROR lines → YtdlpError with the zh-TW text (design.md「YouTube」error table).
import fs from 'node:fs/promises'
import { type YtdlpConfig, YtdlpError, type YtdlpErrorKind } from './types'

export const YTDLP_NOT_FOUND_MESSAGE = '找不到 yt-dlp，請重新執行 setup.bat'
export const METADATA_TIMEOUT_MESSAGE = '向 YouTube 讀取影片資訊逾時，請稍後再試'
export const UNKNOWN_ERROR_PREFIX = '下載失敗：'
/** 「其他」 of a `-J` read (nothing was being downloaded). */
export const METADATA_FAILED_PREFIX = '向 YouTube 讀取影片資訊失敗：'

export const YTDLP_ERROR_MESSAGES: Readonly<Partial<Record<YtdlpErrorKind, string>>> = {
  'private': '這是私人影片，無法下載',
  'members-only': '這是頻道會員限定影片，無法下載',
  'age-restricted': '這支影片有年齡限制，需要登入才能下載，目前不支援',
  'geo-blocked': '這支影片在你所在的地區無法觀看',
  'no-recording': '這場直播沒有保留重播',
  'unavailable': '影片不存在或已被移除',
  'blocked': 'YouTube 暫時拒絕這台電腦的連線（被當成機器人或請求太頻繁），請過一段時間再按「重試」',
  'outdated': 'YouTube 可能改版了，yt-dlp 需要更新：關掉 gg-highlight 再重新開啟會自動更新，然後按「重試」',
  'network': '連不到 YouTube 或連線中斷，請確認網路連線後再試',
  'ffmpeg-missing': '找不到 FFmpeg，請重新執行 setup.bat',
  'not-installed': YTDLP_NOT_FOUND_MESSAGE,
  'live': '還在直播中或還沒開始的直播不能加入，結束後再來',
  'post-live': '直播剛結束，YouTube 還在處理重播，請過一段時間再加入',
  'timeout': METADATA_TIMEOUT_MESSAGE,
}

/**
 * The cause alone of the texts that end with an action (按「重試」, 請稍後再試…), for reasons shown where
 * that action does not exist: the chat and heatmap Signals of a finished Analysis (design.md「聊天室密度」
 * step 7,「重播熱度」step 7), whose next step the UI names (只重新找精華片段).
 */
export const YTDLP_ERROR_CAUSES: Readonly<Partial<Record<YtdlpErrorKind, string>>> = {
  blocked: 'YouTube 暫時拒絕這台電腦的連線（被當成機器人或請求太頻繁）',
  outdated: 'YouTube 可能改版了，yt-dlp 需要更新（關掉 gg-highlight 再重新開啟會自動更新）',
  network: '連不到 YouTube 或連線中斷',
  timeout: '向 YouTube 讀取影片資訊逾時',
}

/**
 * Transport-level failures (offline, DNS, proxy, TLS, a dropped or timed-out connection), as yt-dlp
 * prints them: "(caused by TransportError(…))", "[Errno 11001] getaddrinfo failed", "[WinError 10054] …",
 * "1000 bytes read, 999000 more expected" (a download cut off mid-way).
 */
const NETWORK_PATTERN = new RegExp([
  'caused by (?:TransportError|ProxyError|SSLError|CertificateVerifyError|IncompleteRead)',
  'getaddrinfo',
  'name or service not known',
  'nodename nor servname',
  'temporary failure in name resolution',
  'network is unreachable',
  'timed out',
  'connection (?:refused|reset|aborted)',
  'remote end closed connection',
  '\\d+ bytes read, \\d+ more expected',
  'winerror 100(?:5[134]|6[015])',
].join('|'), 'i')

/**
 * Checked in this order (case-insensitive); design.md's table lists the rows in the same order. More
 * specific sentences come before the general ones: "live stream recording is not available" and
 * "Requested format is not available" must win over "is not available"; YouTube's rate-limit text
 * "Video unavailable. This content isn't available, try again later" is a block, not a removal; and
 * "Unable to download webpage: HTTP Error 429/403" is a block / an outdated yt-dlp, not a network problem.
 * A stream or premiere that has not started has no formats, so yt-dlp never prints live_status
 * is_upcoming for it: it fails with YouTube's reason ("This live event will begin in 3 hours.",
 * "Premieres in 20 hours").
 */
const RULES: ReadonlyArray<{ kind: YtdlpErrorKind, pattern: RegExp }> = [
  { kind: 'private', pattern: /private video/i },
  { kind: 'members-only', pattern: /members-only|join this channel|subscriber_only/i },
  { kind: 'age-restricted', pattern: /confirm your age|age-restricted|inappropriate/i },
  { kind: 'geo-blocked', pattern: /not made this video available in your country|geo restrict/i },
  { kind: 'no-recording', pattern: /live stream recording is not available/i },
  { kind: 'live', pattern: /live event will begin|premieres in|premiere will begin/i },
  { kind: 'ffmpeg-missing', pattern: /ffmpeg is not installed|ffmpeg not found/i },
  { kind: 'blocked', pattern: /confirm you[’']re not a bot|http error 429|try again later|your ip is likely being blocked/i },
  { kind: 'outdated', pattern: /http error 403|requested format is not available|unable to extract|signature extraction failed|nsig/i },
  { kind: 'network', pattern: NETWORK_PATTERN },
  { kind: 'unavailable', pattern: /video unavailable|has been removed|is not available/i },
]

/** Lines yt-dlp printed as errors (only these are mapped; WARNING lines are only logged). */
export function errorLinesOf(lines: readonly string[]): string[] {
  return lines.map(l => l.trim()).filter(l => l.startsWith('ERROR:'))
}

/** The kind of one ERROR line, or 'unknown'. */
export function classifyErrorLine(line: string): YtdlpErrorKind {
  return RULES.find(rule => rule.pattern.test(line))?.kind ?? 'unknown'
}

/**
 * The user-facing error of a failed run. Only `ERROR:` lines count; across several, the earliest rule
 * that matches any of them wins. No known pattern → 'unknown' with <unknownPrefix><last ERROR line>
 * (下載失敗： by default; a `-J` read passes METADATA_FAILED_PREFIX). No ERROR line at all → 'unknown'
 * naming the exit code (or `fallback` when given).
 */
export function mapYtdlpError(
  lines: readonly string[],
  exit: { code: number | null, signal?: NodeJS.Signals | null } = { code: null },
  fallback?: string,
  unknownPrefix: string = UNKNOWN_ERROR_PREFIX,
): YtdlpError {
  const errors = errorLinesOf(lines)
  for (const rule of RULES) {
    const line = errors.find(l => rule.pattern.test(l))
    if (line) return new YtdlpError(rule.kind, YTDLP_ERROR_MESSAGES[rule.kind]!, line)
  }
  const last = errors.at(-1)
  if (last) return new YtdlpError('unknown', `${unknownPrefix}${last}`, last)
  const status = exitStatusText(exit)
  return new YtdlpError('unknown', fallback ?? `${unknownPrefix}yt-dlp 異常結束（${status}）`, status)
}

/**
 * What went wrong, without an action to take: YTDLP_ERROR_CAUSES for the kinds that have one, else the
 * message (an unknown error's raw ERROR line without the generic 下載失敗：).
 */
export function ytdlpErrorCause(err: YtdlpError): string {
  const cause = YTDLP_ERROR_CAUSES[err.kind]
  if (cause) return cause
  const message = err.message.startsWith(UNKNOWN_ERROR_PREFIX) ? err.message.slice(UNKNOWN_ERROR_PREFIX.length) : err.message
  return message || err.detail || '原因不明'
}

/** 結束碼 N, or the signal that ended the process. */
export function exitStatusText(exit: { code: number | null, signal?: NodeJS.Signals | null }): string {
  return exit.code !== null ? `結束碼 ${exit.code}` : `被訊號 ${exit.signal ?? '（未知）'} 終止`
}

/** 'outdated' and 'unknown' make the next start check for a yt-dlp update: delete the check stamp (errors ignored). */
export async function noteUpdateHint(error: unknown, config: Pick<YtdlpConfig, 'updateStampPath'>): Promise<void> {
  if (!(error instanceof YtdlpError) || !error.suggestsUpdate || !config.updateStampPath) return
  try {
    await fs.rm(config.updateStampPath, { force: true })
  }
  catch {
    // best effort
  }
}
