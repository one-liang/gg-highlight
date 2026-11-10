// YouTube parts of the API (design.md「YouTube」→「加入」): parsing the link, reading the metadata (from the
// 30-minute cache or yt-dlp) with its errors as HTTP errors, and adding a YouTube Source Video.
import type { H3Error } from 'h3'
import type { Language, YoutubeInfo, YoutubeMeta } from '../../../shared/types/domain'
import { parseYoutubeUrl } from '../../../shared/utils/youtube-url'
import type { Repositories, VideoRecord } from '../db'
import type { MetadataCache } from '../youtube/cache'
import { assertAddable } from '../youtube/info'
import { type YoutubeMetadata, type YoutubeTools, YtdlpError } from '../youtube/types'
import { badRequest, conflict, httpError, isHttpError, unprocessable } from './errors'

export const YOUTUBE_DUPLICATE_MESSAGE = '這支影片已在影片庫'
/** 502 for a failure that is not a YtdlpError (a bug or an unexpected yt-dlp output); details go to the log. */
export const YOUTUBE_METADATA_FAILED_MESSAGE = '向 YouTube 讀取影片資訊失敗，請稍後再試'

export interface YoutubeLink {
  /** 11-character YouTube video id. */
  id: string
  /** Canonical https://www.youtube.com/watch?v=<id>. */
  url: string
}

export interface YoutubeApiDeps {
  repos: Repositories
  youtube: YoutubeTools
  metadataCache: MetadataCache
  /** yt-dlp warnings and failure output, unexpected errors. */
  log?: (message: string) => void
}

/** The single video of a link, or 400 (not YouTube) / 422 (playlist, channel or search). */
export function parseYoutubeLink(input: string): YoutubeLink {
  const result = parseYoutubeUrl(input)
  if (result.ok) return { id: result.id, url: result.url }
  throw result.reason === 'playlist-or-channel' ? unprocessable(result.message) : badRequest(result.message)
}

/** YtdlpError → its status (422 content, 502 upstream / tool) and zh-TW text; anything else → a generic 502. */
export function youtubeHttpError(err: unknown, log?: (message: string) => void): H3Error {
  if (isHttpError(err)) return err
  if (err instanceof YtdlpError) return httpError(err.httpStatus, err.message)
  log?.(`[youtube] 讀取影片資訊發生意外錯誤：${(err as Error)?.stack ?? String(err)}`)
  return httpError(502, YOUTUBE_METADATA_FAILED_MESSAGE)
}

/**
 * The link's metadata: a read from the last 30 minutes (live status checked again), else yt-dlp `-J`
 * (which also rejects live, upcoming and post-live videos), stored in the cache. Throws HTTP errors.
 */
export async function readYoutubeMetadata(deps: YoutubeApiDeps, link: YoutubeLink): Promise<YoutubeMetadata> {
  try {
    const cached = deps.metadataCache.get(link.id)
    if (cached) {
      assertAddable(cached)
      return cached
    }
    const meta = await deps.youtube.fetchMetadata(link.url, { log: deps.log })
    deps.metadataCache.set(meta)
    return meta
  }
  catch (err) {
    throw youtubeHttpError(err, deps.log)
  }
}

/** What a Source Video keeps of the metadata (no title, link, heatmap or read time). */
export function toYoutubeMeta(meta: YoutubeMetadata): YoutubeMeta {
  return {
    id: meta.id,
    channel: meta.channel,
    durationSec: meta.durationSec,
    liveStatus: meta.liveStatus,
    uploadDate: meta.uploadDate,
    chatAvailable: meta.chatAvailable,
    heatmapAvailable: meta.heatmapAvailable,
  }
}

/** POST /api/youtube/probe's answer: never includes the heatmap or the read time. */
export function toYoutubeInfo(meta: YoutubeMetadata, inLibraryVideoId: string | null): YoutubeInfo {
  return {
    ...toYoutubeMeta(meta),
    url: meta.url,
    title: meta.title,
    languageHint: meta.languageHint,
    inLibraryVideoId,
  }
}

/** The Source Video that already is this YouTube video (by the metadata's id, else the link's), or null. */
function findInLibrary(repos: Repositories, ...ids: string[]): VideoRecord | null {
  for (const id of new Set(ids)) {
    const video = repos.videos.findByYoutubeId(id)
    if (video) return video
  }
  return null
}

/** A Library video's YoutubeInfo from what it stored when it was added (no language hint: the form hides it). */
function storedYoutubeInfo(video: VideoRecord, link: YoutubeLink): YoutubeInfo | null {
  if (!video.youtube) return null
  return { ...video.youtube, url: video.youtubeUrl ?? link.url, title: video.title, languageHint: null, inLibraryVideoId: video.id }
}

/**
 * POST /api/youtube/probe: what the YouTube tab shows before adding. A video already in the Library is
 * answered from the stored info without asking YouTube, so 「這支影片已在影片庫」 shows even while YouTube
 * refuses this PC or the video went private. Throws HTTP errors.
 */
export async function probeYoutube(deps: YoutubeApiDeps, url: string): Promise<YoutubeInfo> {
  const link = parseYoutubeLink(url)
  const existing = findInLibrary(deps.repos, link.id)
  const stored = existing ? storedYoutubeInfo(existing, link) : null
  if (stored) return stored
  const meta = await readYoutubeMetadata(deps, link)
  return toYoutubeInfo(meta, findInLibrary(deps.repos, meta.id, link.id)?.id ?? null)
}

export interface AddYoutubeVideoInput {
  youtubeUrl: string
  language: Language
}

/**
 * POST /api/videos for YouTube: 409 when the video is already in the Library (checked before and after
 * reading the metadata), else a new Source Video without a file or MediaInfo (the first Analysis
 * downloads it), titled after YouTube, with audio track 0. The caller kicks the Analysis queue.
 */
export async function addYoutubeVideo(deps: YoutubeApiDeps, input: AddYoutubeVideoInput): Promise<VideoRecord> {
  const link = parseYoutubeLink(input.youtubeUrl)
  if (findInLibrary(deps.repos, link.id)) throw conflict(YOUTUBE_DUPLICATE_MESSAGE)
  const meta = await readYoutubeMetadata(deps, link)
  // Read again after the await: the same video may have been added meanwhile.
  if (findInLibrary(deps.repos, meta.id, link.id)) throw conflict(YOUTUBE_DUPLICATE_MESSAGE)
  return deps.repos.videos.insert({
    title: meta.title,
    sourceKind: 'youtube',
    filePath: null,
    youtubeUrl: meta.url,
    youtube: toYoutubeMeta(meta),
    language: input.language,
    audioTrack: 0,
    media: null,
  })
}
