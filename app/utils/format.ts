// Number / date formatting for the UI.

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit++
  }
  if (unit === 0) return `${Math.round(value)} B`
  const text = value < 10 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value))
  return `${text} ${BYTE_UNITS[unit]}`
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function toDate(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Local date "2026/10/19". */
export function formatDate(iso: string | null | undefined): string {
  const d = toDate(iso)
  if (!d) return ''
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`
}

/** Local date and time "2026/10/19 14:03". */
export function formatDateTime(iso: string | null | undefined): string {
  const d = toDate(iso)
  if (!d) return ''
  return `${formatDate(iso)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export function formatResolution(width: number, height: number): string {
  return `${width}×${height}`
}

export function formatFps(fps: number): string {
  if (!Number.isFinite(fps) || fps <= 0) return ''
  return `${Number(fps.toFixed(2))} fps`
}

/** Progress 0–1 → "42%"; floors so it never reads 100% before it is done. */
export function formatPercent(progress: number): string {
  return `${progressPercent(progress)}%`
}

export function progressPercent(progress: number): number {
  if (!Number.isFinite(progress)) return 0
  return Math.floor(Math.min(1, Math.max(0, progress)) * 100)
}

/** Highlight Score 0–1 → "82". */
export function formatScore(score: number): string {
  if (!Number.isFinite(score)) return ''
  return String(Math.round(Math.min(1, Math.max(0, score)) * 100))
}
