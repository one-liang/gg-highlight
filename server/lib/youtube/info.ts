// `yt-dlp -J` → YoutubeMetadata (design.md「YouTube」→「加入」). Only the needed fields are read; missing
// or odd ones are tolerated (yt-dlp leaves out null fields, and the heatmap is not a documented field).
import { z } from 'zod'
import { canonicalYoutubeUrl, PLAYLIST_OR_CHANNEL_MESSAGE } from '../../../shared/utils/youtube-url'
import type { Language, YoutubeLiveStatus } from '../../../shared/types/domain'
import type { HeatmapMarker } from '../signals/types'
import { metadataArgs } from './command'
import { exitStatusText, mapYtdlpError, METADATA_TIMEOUT_MESSAGE, noteUpdateHint, YTDLP_ERROR_MESSAGES } from './errors'
import { logFailure, runYtdlp } from './run'
import { type YoutubeMetadata, type YtdlpConfig, YtdlpError, type YtdlpRunOptions } from './types'

export const METADATA_TIMEOUT_MS = 90_000
export const NOT_VIDEO_MESSAGE = PLAYLIST_OR_CHANNEL_MESSAGE
const METADATA_FAILED_PREFIX = '向 YouTube 讀取影片資訊失敗：'

const LIVE_STATUSES = ['not_live', 'was_live', 'post_live', 'is_live', 'is_upcoming'] as const satisfies readonly YoutubeLiveStatus[]

/** A field that is kept only when it has the expected type. */
const opt = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined)

const markerSchema = z.object({
  start_time: z.number(),
  end_time: z.number(),
  value: z.number(),
})

const infoSchema = z.object({
  _type: opt(z.string()),
  id: opt(z.string().min(1)),
  title: opt(z.string()),
  fulltitle: opt(z.string()),
  channel: opt(z.string()),
  uploader: opt(z.string()),
  duration: opt(z.number().positive()),
  live_status: opt(z.enum(LIVE_STATUSES)),
  upload_date: opt(z.string()),
  language: opt(z.string()),
  subtitles: opt(z.record(z.string(), z.unknown())),
  heatmap: opt(z.array(z.unknown())),
})

function heatmapOf(raw: unknown[] | undefined): HeatmapMarker[] | null {
  if (!raw) return null
  const markers: HeatmapMarker[] = []
  for (const item of raw) {
    const parsed = markerSchema.safeParse(item)
    if (parsed.success) markers.push({ start: parsed.data.start_time, end: parsed.data.end_time, value: parsed.data.value })
  }
  return markers.length > 0 ? markers : null
}

/** zh* → zh, en* → en (any case, e.g. zh-TW, en-US), else null. */
export function languageHintOf(language: string | null | undefined): Language | null {
  const lang = (language ?? '').trim().toLowerCase()
  if (lang.startsWith('zh')) return 'zh'
  if (lang.startsWith('en')) return 'en'
  return null
}

/** YYYYMMDD → YYYY-MM-DD; anything else → null. */
export function isoUploadDate(value: string | null | undefined): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value ?? '')
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function hasEntries(value: unknown): boolean {
  if (value === null || value === undefined) return false
  return Array.isArray(value) ? value.length > 0 : true
}

/**
 * One `-J` document → YoutubeMetadata. Throws YtdlpError('not-video') when it is not a single video
 * (e.g. a playlist) and 'unknown' when it is not yt-dlp metadata at all. Does not check the live status
 * (assertAddable does).
 */
export function parseMetadata(json: unknown, now: Date = new Date()): YoutubeMetadata {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new YtdlpError('unknown', `${METADATA_FAILED_PREFIX}yt-dlp 沒有回傳影片資訊`)
  }
  const info = infoSchema.parse(json)
  if (info._type !== undefined && info._type !== 'video') {
    throw new YtdlpError('not-video', NOT_VIDEO_MESSAGE, `_type: ${info._type}`)
  }
  if (!info.id) throw new YtdlpError('unknown', `${METADATA_FAILED_PREFIX}yt-dlp 的影片資訊沒有影片 ID`)
  const heatmap = heatmapOf(info.heatmap)
  return {
    id: info.id,
    url: canonicalYoutubeUrl(info.id),
    title: info.title || info.fulltitle || info.id,
    channel: info.channel || info.uploader || null,
    durationSec: info.duration ?? null,
    liveStatus: info.live_status ?? null,
    uploadDate: isoUploadDate(info.upload_date),
    chatAvailable: hasEntries(info.subtitles?.live_chat),
    heatmapAvailable: heatmap !== null,
    heatmap,
    languageHint: languageHintOf(info.language),
    fetchedAt: now.toISOString(),
  }
}

/** Only not_live and was_live (or an unknown status) can be added and downloaded; throws YtdlpError otherwise. */
export function assertAddable(meta: Pick<YoutubeMetadata, 'liveStatus'>): void {
  if (meta.liveStatus === 'is_live' || meta.liveStatus === 'is_upcoming') {
    throw new YtdlpError('live', YTDLP_ERROR_MESSAGES.live!, `live_status: ${meta.liveStatus}`)
  }
  if (meta.liveStatus === 'post_live') {
    throw new YtdlpError('post-live', YTDLP_ERROR_MESSAGES['post-live']!, 'live_status: post_live')
  }
}

/** The JSON document in -J's stdout (normally the only line). */
function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  }
  catch {
    const last = text.split(/\r?\n/).filter(l => l.trim()).at(-1)
    if (!last || last === text) return undefined
    try {
      return JSON.parse(last)
    }
    catch {
      return undefined
    }
  }
}

export interface FetchMetadataOptions extends YtdlpRunOptions {
  /** Default 90 s. */
  timeoutMs?: number
  /** Clock for fetchedAt (tests). */
  now?: () => Date
}

/**
 * Reads the metadata with `-J` and checks it can be added (assertAddable). Throws YtdlpError (incl.
 * 'timeout', 'live', 'post-live', 'not-video'), or AbortError when `signal` aborts.
 */
export async function fetchMetadata(config: YtdlpConfig, url: string, options: FetchMetadataOptions = {}): Promise<YoutubeMetadata> {
  const { signal, log, timeoutMs = METADATA_TIMEOUT_MS, now = () => new Date() } = options
  const timer = new AbortController()
  const timeout = setTimeout(() => timer.abort(), timeoutMs)
  timeout.unref?.()
  const combined = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal
  try {
    let result
    try {
      result = await runYtdlp(config, metadataArgs(config, url), { signal: combined, log, collectStdout: true })
    }
    catch (err) {
      if (timer.signal.aborted && !signal?.aborted) {
        log?.(`[yt-dlp] 讀取影片資訊超過 ${Math.round(timeoutMs / 1000)} 秒，已中止`)
        throw new YtdlpError('timeout', METADATA_TIMEOUT_MESSAGE)
      }
      throw err
    }
    const json = result.code === 0 ? parseJsonOutput(result.stdout) : undefined
    if (json === undefined) {
      logFailure(log, '讀取影片資訊', result)
      const reason = result.code === 0 ? 'yt-dlp 沒有回傳影片資訊' : `yt-dlp 異常結束（${exitStatusText(result)}）`
      throw mapYtdlpError(result.errorLines, result, `${METADATA_FAILED_PREFIX}${reason}`)
    }
    const meta = parseMetadata(json, now())
    assertAddable(meta)
    return meta
  }
  catch (err) {
    await noteUpdateHint(err, config)
    throw err
  }
  finally {
    clearTimeout(timeout)
  }
}
