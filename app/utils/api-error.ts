// Turns fetch / upload failures into a message for a toast.

/** Thrown when an API answered with something that is not JSON (e.g. the SPA HTML shell). */
export class InvalidResponseError extends Error {
  constructor() {
    super('Invalid API response')
    this.name = 'InvalidResponseError'
  }
}

export interface ApiErrorInfo {
  message: string
  /** HTTP status, or null when the server could not be reached. */
  status: number | null
}

const CJK_RE = /[㐀-鿿豈-﫿]/

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function pickStatus(err: Record<string, unknown>): number | null {
  for (const v of [err.statusCode, err.status, asRecord(err.response)?.status]) {
    if (typeof v === 'number' && v > 0) return v
  }
  return null
}

/** Server text from the JSON body, preferring the user-facing (Chinese) one of statusMessage / message. */
function pickServerMessage(err: Record<string, unknown>): string | null {
  const data = asRecord(err.data)
  if (!data) return null
  const texts = [data.statusMessage, data.message]
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .map(v => v.trim())
  return texts.find(t => CJK_RE.test(t)) ?? texts[0] ?? null
}

/**
 * The server sends user-facing zh-TW text in `statusMessage` (h3 createError).
 * Anything else becomes `fallback` plus a short technical hint.
 */
export function describeApiError(err: unknown, fallback: string): ApiErrorInfo {
  const e = asRecord(err)
  if (!e) return { message: fallback, status: null }
  if (e.name === 'AbortError') return { message: '已取消', status: null }
  if (e.name === 'InvalidResponseError' || e.name === 'SyntaxError') {
    return { message: `${fallback}（伺服器回應格式不正確）`, status: pickStatus(e) }
  }
  const status = pickStatus(e)
  const serverMessage = pickServerMessage(e)
  if (serverMessage && CJK_RE.test(serverMessage)) return { message: serverMessage, status }
  if (status !== null) {
    return { message: serverMessage ? `${fallback}（${status}：${serverMessage}）` : `${fallback}（錯誤代碼 ${status}）`, status }
  }
  return { message: `${fallback}（無法連線到 gg-highlight，請確認程式仍在執行）`, status: null }
}

export function apiErrorMessage(err: unknown, fallback: string): string {
  return describeApiError(err, fallback).message
}
