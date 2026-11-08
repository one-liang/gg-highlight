// Time helpers. All times are seconds (float).

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function safeSeconds(sec: number): number {
  return Number.isFinite(sec) && sec > 0 ? sec : 0
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** "m:ss.s" under an hour, "h:mm:ss" otherwise. */
export function formatTime(sec: number): string {
  const tenths = Math.round(safeSeconds(sec) * 10)
  if (tenths < 36000) {
    const m = Math.floor(tenths / 600)
    const rest = tenths - m * 600
    return `${m}:${pad2(Math.floor(rest / 10))}.${rest % 10}`
  }
  const whole = Math.round(safeSeconds(sec))
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  return `${h}:${pad2(m)}:${pad2(whole % 60)}`
}

/** Like formatTime but keeps tenths past an hour ("h:mm:ss.s"), for editable inputs. */
export function formatTimeInput(sec: number): string {
  const tenths = Math.round(safeSeconds(sec) * 10)
  if (tenths < 36000) return formatTime(sec)
  const h = Math.floor(tenths / 36000)
  const m = Math.floor((tenths % 36000) / 600)
  const rest = tenths % 600
  return `${h}:${pad2(m)}:${pad2(Math.floor(rest / 10))}.${rest % 10}`
}

/** Whole-second duration: "m:ss" or "h:mm:ss". */
export function formatDuration(sec: number): string {
  const whole = Math.round(safeSeconds(sec))
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`
}

/** Human length of a range: "45.2 秒", "3 分 5 秒", "1 小時 2 分". */
export function formatSpan(sec: number): string {
  const s = safeSeconds(sec)
  const tenths = Math.round(s * 10)
  if (tenths < 600) return `${(tenths / 10).toFixed(1)} 秒`
  const whole = Math.round(s)
  if (whole < 3600) return `${Math.floor(whole / 60)} 分 ${whole % 60} 秒`
  return `${Math.floor(whole / 3600)} 小時 ${Math.floor((whole % 3600) / 60)} 分`
}

const FULLWIDTH_RE = /[０-９：．]/g

/** Converts full-width digits / colon / period (common with CJK IMEs) and drops spaces. */
export function normalizeTimeText(text: string): string {
  return text
    .replace(FULLWIDTH_RE, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, '')
}

const SECONDS_RE = /^(?:\d+\.?\d*|\.\d+)$/
const INT_RE = /^\d+$/

/**
 * Parses "83.4", "1:23.4", "1:02:03" or "1:02:03.5" into seconds.
 * Returns null when the text is empty or invalid.
 */
export function parseTime(text: string): number | null {
  const t = normalizeTimeText(text)
  if (!t) return null
  const parts = t.split(':')
  if (parts.length > 3) return null
  const secText = parts.pop() as string
  if (!SECONDS_RE.test(secText)) return null
  const seconds = Number(secText)
  if (!Number.isFinite(seconds)) return null
  if (parts.length === 0) return round3(seconds)
  if (seconds >= 60) return null
  if (!parts.every(p => INT_RE.test(p))) return null
  if (parts.length === 1) return round3(Number(parts[0]) * 60 + seconds)
  const hours = Number(parts[0])
  const minutes = Number(parts[1])
  if (minutes >= 60) return null
  return round3(hours * 3600 + minutes * 60 + seconds)
}

/** Rounds to 0.1 s and clamps into [0, max]; used for "設為目前時間". */
export function snapTime(sec: number, max: number): number {
  const rounded = Math.round(safeSeconds(sec) * 10) / 10
  return Math.min(rounded, Math.max(0, max))
}
