// Parsing yt-dlp's machine-readable output lines (command.ts PROGRESS_TEMPLATE / FILE_PRINT_TEMPLATE). Pure.

export interface FormatProgress {
  /** yt-dlp format id of the part being downloaded (e.g. 137 video, 140 audio); 'NA' when unknown. */
  formatId: string
  status: string | null
  downloadedBytes: number | null
  totalBytes: number | null
  totalBytesEstimate: number | null
  fragmentIndex: number | null
  fragmentCount: number | null
}

/** design.md: the first format (video) is 90 % of the download, the second (audio) 10 %. */
export const FIRST_FORMAT_SHARE = 0.9

const PROGRESS_RE = /^GGDL (\S+) (.*)$/
const FILE_RE = /^GGFILE (.*)$/

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** A `GGDL <format id> {json}` line, or null for anything else. */
export function parseProgressLine(line: string): FormatProgress | null {
  const match = PROGRESS_RE.exec(line.trim())
  if (!match) return null
  let data: unknown
  try {
    data = JSON.parse(match[2]!)
  }
  catch {
    return null
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  return {
    formatId: match[1]!,
    status: typeof d.status === 'string' ? d.status : null,
    downloadedBytes: num(d.downloaded_bytes),
    totalBytes: num(d.total_bytes),
    totalBytesEstimate: num(d.total_bytes_estimate),
    fragmentIndex: num(d.fragment_index),
    fragmentCount: num(d.fragment_count),
  }
}

/**
 * 0–1 within one format: bytes ÷ (total || estimate); without byte totals fragment_index ÷ fragment_count;
 * 1 once finished; null when the line says nothing about how far it is.
 */
export function formatFraction(p: FormatProgress): number | null {
  if (p.status === 'finished') return 1
  const total = p.totalBytes || p.totalBytesEstimate
  if (p.downloadedBytes !== null && total) return clamp01(p.downloadedBytes / total)
  if (p.fragmentIndex !== null && p.fragmentCount) return clamp01(p.fragmentIndex / p.fragmentCount)
  return null
}

/** The `GGFILE "<path>"` line's path (JSON-decoded), or null for anything else. */
export function parseFileLine(line: string): string | null {
  const match = FILE_RE.exec(line.trim())
  if (!match) return null
  try {
    const value: unknown = JSON.parse(match[1]!)
    return typeof value === 'string' && value !== '' ? value : null
  }
  catch {
    return null
  }
}

/**
 * Overall progress of one video download from its GGDL lines. Formats count in the order they first
 * appear: the first one covers 0–0.9, the second 0.9–1. yt-dlp's lines do not say whether a second
 * format follows, so a single-format download reaches 0.9 and its caller reports 1 when the file is done.
 * A format counts only once the one before it has reported 'finished' (yt-dlp also does for a part
 * already on disk): when the video part gives up, yt-dlp (ignoreerrors 'only_download', its CLI default)
 * still downloads the audio before the run fails, and the bar must not jump to 90 % for that.
 * Never goes backwards.
 */
export class DownloadProgress {
  private readonly formats: string[] = []
  private readonly finished = new Set<string>()
  private current = 0

  /** Feeds one output line; returns the new overall fraction when it moved forward, else null. */
  push(line: string): number | null {
    const p = parseProgressLine(line)
    if (!p) return null
    let index = this.formats.indexOf(p.formatId)
    if (index < 0) {
      const previous = this.formats.at(-1)
      if (previous !== undefined && !this.finished.has(previous)) return null
      this.formats.push(p.formatId)
      index = this.formats.length - 1
    }
    if (p.status === 'finished') this.finished.add(p.formatId)
    const f = formatFraction(p)
    if (f === null) return null
    const overall = index === 0 ? f * FIRST_FORMAT_SHARE : index === 1 ? FIRST_FORMAT_SHARE + f * (1 - FIRST_FORMAT_SHARE) : 1
    if (overall <= this.current) return null
    this.current = overall
    return overall
  }

  get value(): number {
    return this.current
  }
}
