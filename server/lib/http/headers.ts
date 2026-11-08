// Pure header helpers: MIME types, Content-Disposition and Range parsing.
import path from 'node:path'

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.flv': 'video/x-flv',
  '.ts': 'video/mp2t',
  '.avi': 'video/x-msvideo',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.srt': 'application/x-subrip; charset=utf-8',
  '.ass': 'text/x-ssa; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

/** MIME type from the extension (mp4, mkv, webm, mov, srt, ass, wav...), default application/octet-stream. */
export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** RFC 5987 value-chars: encodeURIComponent leaves ' ( ) * unescaped, which attr-char does not allow. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value.replace(LONE_SURROGATE_RE, '\uFFFD'))
    .replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** Content-Disposition value that keeps non-ASCII (Chinese) names via RFC 5987 filename*. */
export function contentDisposition(fileName: string, attachment: boolean): string {
  const fallback = fileName.replace(/[^\x20-\x7E]/gu, '_').replace(/["\\]/g, '\\$&')
  return `${attachment ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(fileName)}`
}

export interface ByteRange {
  start: number
  /** Inclusive. */
  end: number
}

/**
 * Parses a Range header against a file of `size` bytes.
 * null: no usable Range (absent, another unit, or several ranges) → send the whole file.
 * 'unsatisfiable': malformed or outside the file → 416.
 */
export function parseRange(header: string | undefined | null, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null
  const match = /^\s*bytes\s*=(.*)$/i.exec(header)
  if (!match) return null
  const specs = match[1]!.split(',').map(s => s.trim()).filter(Boolean)
  if (specs.length === 0) return 'unsatisfiable'
  if (specs.length > 1) return null

  const spec = /^(\d*)\s*-\s*(\d*)$/.exec(specs[0]!)
  if (!spec || (spec[1] === '' && spec[2] === '')) return 'unsatisfiable'
  if (spec[1] === '') {
    const suffix = Number(spec[2])
    if (suffix === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(spec[1])
  const end = spec[2] === '' ? size - 1 : Number(spec[2])
  if (start > end || start >= size) return 'unsatisfiable'
  return { start, end: Math.min(end, size - 1) }
}
