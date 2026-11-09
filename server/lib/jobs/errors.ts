// Turning job failures into messages a user can read (no stack traces, always Chinese context).

export { CANCELLED_MESSAGE } from '../../../shared/types/domain'
export const MISSING_SOURCE_MESSAGE = '找不到原始影片檔'
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

/**
 * A readable failure message: the error's own text without stack traces, prefixed with
 * `${context}失敗：` when it carries no Chinese explanation, and cut to a sane length.
 */
export function readableError(err: unknown, context: string): string {
  let text = stripStackTrace(messageOf(err))
  if (!text) return `${context}失敗（原因不明）`
  if (!CJK_RE.test(text)) text = `${context}失敗：${text}`
  if (text.length > MAX_MESSAGE_CHARS) text = `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…`
  return text
}
