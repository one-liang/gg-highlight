// HTTP errors with a user-facing (zh-TW) statusMessage, as the UI shows it directly.
import { H3Error } from 'h3'

/**
 * Same shape as h3 createError({ statusCode, statusMessage, message }). Built directly because
 * createError logs a warning for every non-ASCII statusMessage; the HTTP status line is still
 * sanitized by h3, while the JSON body keeps the Chinese text.
 */
export function httpError(statusCode: number, statusMessage: string): H3Error {
  const err = new H3Error(statusMessage)
  err.statusCode = statusCode
  err.statusMessage = statusMessage
  return err
}

export const badRequest = (message: string) => httpError(400, message)
export const forbidden = (message: string) => httpError(403, message)
export const notFound = (message: string) => httpError(404, message)
export const conflict = (message: string) => httpError(409, message)
export const unprocessable = (message: string) => httpError(422, message)

export function isHttpError(err: unknown): err is H3Error {
  return err instanceof H3Error || (typeof err === 'object' && err !== null
    && (err as { constructor?: { __h3_error__?: boolean } }).constructor?.__h3_error__ === true)
}

/** Keeps HTTP errors, turns anything else into `statusCode` with a readable message (no stack trace). */
export function asHttpError(err: unknown, statusCode: number, prefix: string): H3Error {
  if (isHttpError(err)) return err
  const raw = err instanceof Error ? err.message : String(err ?? '')
  const firstLines = raw.split(/\r?\n/).filter(line => line.trim() !== '' && !/^\s+at\s/.test(line)).slice(0, 4).join('\n').trim()
  return httpError(statusCode, firstLines ? `${prefix}：${firstLines}` : prefix)
}

/** 422 for a file ffprobe could not read: 「無法讀取這個影片檔：<reason>」 (without probeMedia's own prefix). */
export function unreadableVideo(err: unknown): H3Error {
  const first = (err instanceof Error ? err.message : String(err ?? '')).split(/\r?\n/)[0]!.trim()
  const reason = first.replace(/^無法讀取影片：/, '').trim()
  return unprocessable(reason ? `無法讀取這個影片檔：${reason}` : '無法讀取這個影片檔')
}
