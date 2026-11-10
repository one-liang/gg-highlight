// YouTube via yt-dlp (docs/design.md「YouTube」「yt-dlp」, ADR-0003). Contracts between the yt-dlp
// wrapper, the Analysis jobs and the API routes.
import type { Language, YoutubeMeta } from '../../../shared/types/domain'
import type { HeatmapMarker } from '../signals/types'

/** What the app keeps from one `yt-dlp -J` run. */
export interface YoutubeMetadata extends YoutubeMeta {
  /** Canonical https://www.youtube.com/watch?v=<id>. */
  url: string
  title: string
  languageHint: Language | null
  /** Raw replay heatmap; null when YouTube has none. */
  heatmap: HeatmapMarker[] | null
  /** ISO time of the read. */
  fetchedAt: string
}

/** Categories of yt-dlp failures (design.md「YouTube」error table). */
export type YtdlpErrorKind =
  | 'private'
  | 'members-only'
  | 'age-restricted'
  | 'geo-blocked'
  | 'no-recording'
  | 'unavailable'
  /** Bot check, HTTP 429, "try again later", IP blocked. */
  | 'blocked'
  /** 403, format not available, extraction/signature failures: yt-dlp probably needs an update. */
  | 'outdated'
  /** Offline, DNS, proxy / TLS failures, a dropped or timed-out connection. */
  | 'network'
  | 'ffmpeg-missing'
  /** No space left on the disk of data/downloads (while downloading or merging). */
  | 'disk-full'
  /** The yt-dlp executable could not be started. */
  | 'not-installed'
  /** live_status is_live, or a stream / premiere that has not started (yt-dlp's "This live event will begin…"). */
  | 'live'
  /** live_status post_live. */
  | 'post-live'
  /** The link resolved to something that is not a single video (e.g. _type playlist). */
  | 'not-video'
  | 'timeout'
  | 'unknown'

/** A yt-dlp failure with the zh-TW text shown to the user. Never thrown for an abort (that stays AbortError). */
export class YtdlpError extends Error {
  readonly kind: YtdlpErrorKind
  /** Raw `ERROR:` line (or other detail) for the log; may be ''. */
  readonly detail: string

  constructor(kind: YtdlpErrorKind, message: string, detail = '') {
    super(message)
    this.name = 'YtdlpError'
    this.kind = kind
    this.detail = detail
  }

  /** HTTP status for the API: content problems are 422, upstream / tool problems 502. */
  get httpStatus(): 422 | 502 {
    switch (this.kind) {
      case 'private':
      case 'members-only':
      case 'age-restricted':
      case 'geo-blocked':
      case 'no-recording':
      case 'unavailable':
      case 'live':
      case 'post-live':
      case 'not-video':
        return 422
      default:
        return 502
    }
  }

  /** 'outdated' and 'unknown' make the next start check for a yt-dlp update (design.md「yt-dlp」). */
  get suggestsUpdate(): boolean {
    return this.kind === 'outdated' || this.kind === 'unknown'
  }
}

/** How to run yt-dlp; built from AppConfig by the services / tests. */
export interface YtdlpConfig {
  /** argv prefix (config.ytdlpCommand). */
  command: string[]
  /** config.ffmpegPath; passed as --ffmpeg-location only when it is an existing absolute path. */
  ffmpegPath: string
  /** Node executable for `--js-runtimes node:<path>` (process.execPath). */
  nodePath: string
  /** <dataDir>/downloads. */
  downloadsDir: string
  /** tools/.yt-dlp-checked when yt-dlp is managed by the app (deleted when an error suggests an update); null otherwise. */
  updateStampPath: string | null
}

export interface YtdlpRunOptions {
  signal?: AbortSignal
  /** Per-line log (WARNING lines, the full output of a failure). */
  log?: (message: string) => void
}

export interface DownloadVideoOptions extends YtdlpRunOptions {
  url: string
  /** Source Video id: the file becomes <downloadsDir>/<videoId>.<ext>. */
  videoId: string
  /** 0–1 over the whole video download (design.md: first format 90 %, second 10 %). */
  onProgress?: (fraction: number) => void
}

export interface DownloadChatOptions extends YtdlpRunOptions {
  url: string
  videoId: string
  /** For progress: last written videoOffsetTimeMsec ÷ duration. */
  durationSec: number
  onProgress?: (fraction: number) => void
}

/** yt-dlp operations used by the jobs and routes; tests inject the fake-yt-dlp command. */
export interface YoutubeTools {
  /** `-J` → metadata. Throws YtdlpError (incl. 'live' / 'post-live' / 'not-video'), or AbortError. Default timeout 90 s. */
  fetchMetadata(url: string, options?: YtdlpRunOptions & { timeoutMs?: number }): Promise<YoutubeMetadata>
  /** Downloads the video file; resolves with its absolute path inside downloadsDir. */
  downloadVideo(options: DownloadVideoOptions): Promise<string>
  /**
   * Downloads the live chat replay to <downloadsDir>/<videoId>.live_chat.json (deletes a stale .part
   * first); resolves with that path. Success = the final file exists, whatever the exit code.
   */
  downloadChat(options: DownloadChatOptions): Promise<string>
}

/** One counted chat message (design.md「聊天室密度」steps 1–3). Authors are only kept in memory. */
export interface ChatMessage {
  /** Video time in seconds. */
  offsetSec: number
  /** 0 greeting/farewell, 2 reaction, 1 otherwise. */
  weight: number
  /** authorExternalChannelId, or null when the line has none (each such message counts as its own author). */
  author: string | null
}

export interface ChatDensity {
  /** Per-second score 0–1, length ceil(durationSec). */
  values: Float32Array
  /** Messages with weight > 0. */
  counted: number
  /** counted ÷ (durationSec / 3600). */
  perHour: number
}
