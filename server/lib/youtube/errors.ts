// yt-dlp's English ERROR lines → YtdlpError with the zh-TW text (design.md「YouTube」error table).
import fs from 'node:fs/promises'
import { type YtdlpConfig, YtdlpError, type YtdlpErrorKind } from './types'

export const YTDLP_NOT_FOUND_MESSAGE = '找不到 yt-dlp，請重新執行 setup.bat'
export const METADATA_TIMEOUT_MESSAGE = '向 YouTube 讀取影片資訊逾時，請稍後再試'
export const UNKNOWN_ERROR_PREFIX = '下載失敗：'

export const YTDLP_ERROR_MESSAGES: Readonly<Partial<Record<YtdlpErrorKind, string>>> = {
  'private': '這是私人影片，無法下載',
  'members-only': '這是頻道會員限定影片，無法下載',
  'age-restricted': '這支影片有年齡限制，需要登入才能下載，目前不支援',
  'geo-blocked': '這支影片在你所在的地區無法觀看',
  'no-recording': '這場直播沒有保留重播',
  'unavailable': '影片不存在或已被移除',
  'blocked': 'YouTube 暫時拒絕這台電腦的連線（被當成機器人或請求太頻繁），請過一段時間再按「重試」',
  'outdated': 'YouTube 可能改版了，yt-dlp 需要更新：關掉 gg-highlight 再重新開啟會自動更新，然後按「重試」',
  'ffmpeg-missing': '找不到 FFmpeg，請重新執行 setup.bat',
  'js-runtime-missing': '找不到 yt-dlp 需要的 JavaScript 執行環境，請重新執行 setup.bat',
  'not-installed': YTDLP_NOT_FOUND_MESSAGE,
  'live': '還在直播中或還沒開始的直播不能加入，結束後再來',
  'post-live': '直播剛結束，YouTube 還在處理重播，請過一段時間再加入',
  'timeout': METADATA_TIMEOUT_MESSAGE,
}

/**
 * Checked in this order (case-insensitive), which differs from the design table's row order only where
 * one message contains another row's words: "live stream recording is not available" and
 * "Requested format is not available" must win over "is not available", and YouTube's rate-limit text
 * "Video unavailable. This content isn't available, try again later" is a block, not a removal.
 */
const RULES: ReadonlyArray<{ kind: YtdlpErrorKind, pattern: RegExp }> = [
  { kind: 'private', pattern: /private video/i },
  { kind: 'members-only', pattern: /members-only|join this channel|subscriber_only/i },
  { kind: 'age-restricted', pattern: /confirm your age|age-restricted|inappropriate/i },
  { kind: 'geo-blocked', pattern: /not made this video available in your country|geo restrict/i },
  { kind: 'no-recording', pattern: /live stream recording is not available/i },
  { kind: 'ffmpeg-missing', pattern: /ffmpeg is not installed|ffmpeg not found/i },
  { kind: 'js-runtime-missing', pattern: /no supported javascript runtime/i },
  { kind: 'blocked', pattern: /confirm you[’']re not a bot|http error 429|try again later|your ip is likely being blocked/i },
  { kind: 'outdated', pattern: /http error 403|requested format is not available|unable to extract|signature extraction failed|nsig/i },
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
 * that matches any of them wins. No known pattern → 'unknown' with 下載失敗：<last ERROR line>. No ERROR
 * line at all → 'unknown' naming the exit code (or `fallback` when given).
 */
export function mapYtdlpError(lines: readonly string[], exit: { code: number | null, signal?: NodeJS.Signals | null } = { code: null }, fallback?: string): YtdlpError {
  const errors = errorLinesOf(lines)
  for (const rule of RULES) {
    const line = errors.find(l => rule.pattern.test(l))
    if (line) return new YtdlpError(rule.kind, YTDLP_ERROR_MESSAGES[rule.kind]!, line)
  }
  const last = errors.at(-1)
  if (last) return new YtdlpError('unknown', `${UNKNOWN_ERROR_PREFIX}${last}`, last)
  const status = exitStatusText(exit)
  return new YtdlpError('unknown', fallback ?? `${UNKNOWN_ERROR_PREFIX}yt-dlp 異常結束（${status}）`, status)
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
