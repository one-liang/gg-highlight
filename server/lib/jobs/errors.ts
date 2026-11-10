// Turning job failures into messages a user can read (no stack traces, always Chinese context).
import { UNKNOWN_ERROR_PREFIX } from '../youtube/errors'
import { YtdlpError, type YtdlpErrorKind } from '../youtube/types'

export { CANCELLED_MESSAGE } from '../../../shared/types/domain'
export const MISSING_SOURCE_MESSAGE = '找不到原始影片檔'
/** A YouTube video whose downloaded file was deleted (the UI's MISSING_DOWNLOAD_LABEL). */
export const MISSING_DOWNLOAD_MESSAGE = '下載的影片檔不見了'
const MAX_MESSAGE_CHARS = 1200
const CJK_RE = /[㐀-鿿豈-﫿]/u

/** Removes JavaScript stack frames and Python tracebacks, keeping the final exception line. */
export function stripStackTrace(text: string): string {
  const out: string[] = []
  let inTraceback = false
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (/^\s+at\s.+/.test(line)) continue
    if (/^\s*Traceback \(most recent call last\):\s*$/.test(line)) {
      inTraceback = true
      continue
    }
    if (inTraceback) {
      // Frames ("  File ...") and their source lines are indented; the exception line is not.
      if (/^\s/.test(line) || line.trim() === '') continue
      inTraceback = false
    }
    if (/^During handling of the above exception|^The above exception was the direct cause/.test(line.trim())) continue
    out.push(line.trimEnd())
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return ''
}

/** Live-status checks (design.md「YouTube」→「加入」): their text says it all, so it is shown without a step prefix. */
const YTDLP_STATUS_KINDS: ReadonlySet<YtdlpErrorKind> = new Set(['live', 'post-live', 'not-video'])

/**
 * yt-dlp's reason in Chinese (the mapped table text, or `<raw ERROR line>` for an unknown one, without
 * the generic 下載失敗： in front, since the caller names what failed).
 */
export function ytdlpReason(err: YtdlpError): string {
  const message = err.message.startsWith(UNKNOWN_ERROR_PREFIX) ? err.message.slice(UNKNOWN_ERROR_PREFIX.length) : err.message
  return message || err.detail || '原因不明'
}

function cut(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text
}

/**
 * A readable failure message: the error's own text without stack traces, prefixed with
 * `${context}失敗：` when it carries no Chinese explanation, and cut to a sane length. A yt-dlp failure
 * (YtdlpError, already in Chinese) always gets the prefix (下載影片失敗：YouTube 可能改版了…), except the
 * live-status checks, whose text is shown as is.
 */
export function readableError(err: unknown, context: string): string {
  if (err instanceof YtdlpError) {
    return cut(YTDLP_STATUS_KINDS.has(err.kind) ? err.message : `${context}失敗：${ytdlpReason(err)}`)
  }
  let text = stripStackTrace(messageOf(err))
  if (!text) return `${context}失敗（原因不明）`
  if (!CJK_RE.test(text)) text = `${context}失敗：${text}`
  return cut(text)
}
