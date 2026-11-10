// The YouTube parts of an Analysis (design.md「YouTube」): the download step of a 'full' run, the metadata
// refresh at the start of a 'highlights' run's signals step, and the chat density / replay heatmap Signals.
import path from 'node:path'
import type { SignalState, YoutubeMeta } from '../../../shared/types/domain'
import { canonicalYoutubeUrl, parseYoutubeUrl } from '../../../shared/utils/youtube-url'
import type { VideoRecord } from '../db'
import { downloadsDir } from '../library/removal'
import type { SignalsFile } from '../signals'
import {
  assertAddable, CHAT_MIN_PER_HOUR, chatDensity, chatDownloadFailureReason, chatFilePath, heatmapTrack, METADATA_TIMEOUT_MS,
  readChatMessages, type YoutubeMetadata, YtdlpError,
} from '../youtube'
import { DOWNLOAD_STEP_SHARES } from './analysis-steps'
import type { AnalysisRun } from './analysis-steps'
import { ytdlpReason } from './errors'
import { isFile } from './files'
import { throwIfAborted } from './worker'

export const NO_CHAT_REASON = '這支影片沒有聊天室重播（不是直播重播，或重播剪輯過）'
export const CHAT_UNREADABLE_REASON = '讀不到聊天室重播檔'
export const CHAT_TOO_FEW_REASON = '聊天室訊息太少（平均每分鐘不到 2 則），不採用'
export const NO_HEATMAP_REASON = '這支影片沒有 YouTube 重播熱度（觀看次數不夠多或影片太新）'
export const FLAT_HEATMAP_REASON = '重播熱度沒有明顯起伏'
export const HEATMAP_FAILED_PREFIX = '無法取得重播熱度：'

/** Which YouTube video a Source Video is. */
export interface YoutubeSource {
  /** Canonical https://www.youtube.com/watch?v=<id>. */
  url: string
  youtubeId: string
  /** The metadata stored with the video (from the last successful read). */
  stored: YoutubeMeta | null
}

/** This run's metadata read: the metadata, or why it could not be read. */
export type MetadataRead =
  | { ok: true, meta: YoutubeMetadata }
  | { ok: false, reason: string }

/** What the download step (or the 'highlights' refresh) hands to the chat / heatmap Signals. */
export interface YoutubeRunData {
  read: MetadataRead
  /** The metadata (this run's, else the stored one) lists a live chat replay. */
  chatAvailable: boolean
  /** Missing reason of the chat Signal after a failed chat download (聊天室重播下載失敗：…); null otherwise. */
  chatFailure: string | null
}

/** The chat and heatmap Signals of a YouTube video. */
export interface YoutubeSignals {
  /** [chat, heatmap]. */
  states: [SignalState, SignalState]
  /** Per-second chat density when the Signal is used. */
  chat: Float32Array | null
  /** Per-second replay heatmap (and the seconds it covers) when the Signal is used. */
  heatmap: { values: Float32Array, covered: Uint8Array } | null
  /** signals.json's heatmap: the markers this run used (read now, or carried over from the last file). */
  heatmapFile: SignalsFile['heatmap']
}

export function youtubeSourceOf(video: Pick<VideoRecord, 'youtubeUrl' | 'youtube'>): YoutubeSource {
  const parsed = video.youtubeUrl ? parseYoutubeUrl(video.youtubeUrl) : null
  const youtubeId = video.youtube?.id ?? (parsed?.ok ? parsed.id : null)
  if (!youtubeId) throw new Error('這支影片沒有可用的 YouTube 連結')
  return { url: parsed?.ok ? parsed.url : canonicalYoutubeUrl(youtubeId), youtubeId, stored: video.youtube }
}

function errorText(err: unknown): string {
  if (err instanceof YtdlpError) return ytdlpReason(err)
  if (err instanceof Error) return err.message || '原因不明'
  return String(err)
}

/** Live-status rejections (still live, just ended) fail the download step even when the file is on disk. */
function isLiveStatusError(err: unknown): boolean {
  return err instanceof YtdlpError && (err.kind === 'live' || err.kind === 'post-live')
}

/** The YouTube fields kept with the video (the rest of a read is only needed during the run). */
export function storedMetaOf(meta: YoutubeMetadata): YoutubeMeta {
  const { id, channel, durationSec, liveStatus, uploadDate, chatAvailable, heatmapAvailable } = meta
  return { id, channel, durationSec, liveStatus, uploadDate, chatAvailable, heatmapAvailable }
}

/**
 * The metadata of this run: a read of the last 30 minutes when `useCache` (its live status checked
 * again), else a new `-J` read (at most 90 s), which also refreshes the cache. Stores the YouTube
 * fields with the video. Throws YtdlpError or AbortError.
 */
async function readMetadata(run: AnalysisRun, source: YoutubeSource, useCache: boolean): Promise<YoutubeMetadata> {
  const { deps } = run
  let meta = useCache ? deps.metadataCache.get(source.youtubeId) : null
  if (meta) {
    assertAddable(meta)
    run.log('沿用 30 分鐘內讀過的影片資訊')
  }
  else {
    run.log('向 YouTube 讀取影片資訊')
    meta = await deps.youtube.fetchMetadata(source.url, { signal: run.signal, log: run.log, timeoutMs: METADATA_TIMEOUT_MS })
    deps.metadataCache.set(meta)
  }
  throwIfAborted(run.signal)
  deps.repos.videos.update(run.videoId, { youtube: storedMetaOf(meta) })
  return meta
}

function chatAvailableOf(read: MetadataRead, source: YoutubeSource): boolean {
  return read.ok ? read.meta.chatAvailable : source.stored?.chatAvailable ?? false
}

function durationOf(read: MetadataRead, source: YoutubeSource): number {
  return (read.ok ? read.meta.durationSec : null) ?? source.stored?.durationSec ?? 0
}

function chatFileOf(run: AnalysisRun): string {
  return chatFilePath(downloadsDir(run.deps.config), run.videoId)
}

/**
 * The live chat replay: kept when <videoId>.live_chat.json exists, downloaded when the metadata lists
 * one. A failed download only returns the chat Signal's missing reason; an abort rejects.
 */
async function ensureChat(run: AnalysisRun, source: YoutubeSource, read: MetadataRead, onProgress: (fraction: number) => void): Promise<string | null> {
  if (await isFile(chatFileOf(run))) {
    run.log('沿用已下載的聊天室重播')
    return null
  }
  if (!chatAvailableOf(read, source)) {
    run.log('影片資訊沒有聊天室重播，不下載')
    return null
  }
  run.log('下載聊天室重播')
  try {
    await run.deps.youtube.downloadChat({
      url: source.url,
      videoId: run.videoId,
      durationSec: durationOf(read, source),
      signal: run.signal,
      log: run.log,
      onProgress,
    })
    run.log('聊天室重播下載完成')
    return null
  }
  catch (err) {
    if (run.signal.aborted) throw err
    const reason = chatDownloadFailureReason(err)
    run.log(`${reason}（分析照常繼續，這次不用聊天室密度）`)
    return reason
  }
}

/**
 * The download step of a YouTube video's 'full' run (design.md「下載」): metadata (3 %), the video file
 * unless `fileOnDisk` (85 %; sets the video's and the run's filePath), the live chat replay (12 %).
 * A metadata read that fails (other than a live-status rejection) only matters when the file has to
 * be downloaded; with the file on disk the run goes on with the stored data and the last heatmap.
 * A chat failure never fails the step.
 */
export async function runDownloadStep(run: AnalysisRun, source: YoutubeSource, fileOnDisk: boolean): Promise<YoutubeRunData> {
  const { deps, progress, signal } = run
  const shares = DOWNLOAD_STEP_SHARES
  progress.step('download')

  let read: MetadataRead
  try {
    read = { ok: true, meta: await readMetadata(run, source, true) }
  }
  catch (err) {
    if (signal.aborted || !fileOnDisk || isLiveStatusError(err)) throw err
    const reason = errorText(err)
    run.log(`讀取影片資訊失敗，沿用已下載的影片檔與上次的資料：${reason}`)
    read = { ok: false, reason }
  }
  progress.update(shares.metadata)

  if (fileOnDisk && run.filePath) {
    run.log(`沿用已下載的影片檔（${path.basename(run.filePath)}）`)
  }
  else {
    run.log('下載影片檔（最高 1080p）')
    const filePath = await deps.youtube.downloadVideo({
      url: source.url,
      videoId: run.videoId,
      signal,
      log: run.log,
      onProgress: fraction => progress.update(shares.metadata + shares.video * fraction),
    })
    throwIfAborted(signal)
    deps.repos.videos.update(run.videoId, { filePath })
    run.filePath = filePath
    run.log(`影片檔下載完成（${path.basename(filePath)}）`)
  }
  progress.update(shares.metadata + shares.video)

  const chatFailure = await ensureChat(run, source, read, fraction => progress.update(shares.metadata + shares.video + shares.chat * fraction))
  throwIfAborted(signal)
  progress.update(1)
  return { read, chatAvailable: chatAvailableOf(read, source), chatFailure }
}

/**
 * A YouTube video's 'highlights' run, start of the signals step: reads the metadata again (for the
 * heatmap; never the cache, at most 90 s) and downloads the chat replay when the file is missing and
 * the metadata lists one. Never downloads the video file. A failed read is logged; the Signals then
 * use the stored data and the last heatmap. `onProgress`: 0–1 over this part.
 */
export async function refreshYoutubeData(run: AnalysisRun, source: YoutubeSource, onProgress: (fraction: number) => void): Promise<YoutubeRunData> {
  let read: MetadataRead
  try {
    read = { ok: true, meta: await readMetadata(run, source, false) }
  }
  catch (err) {
    if (run.signal.aborted) throw err
    const reason = errorText(err)
    run.log(`無法重新讀取影片資訊，沿用上次的資料：${reason}`)
    read = { ok: false, reason }
  }
  onProgress(0.5)
  const chatFailure = await ensureChat(run, source, read, fraction => onProgress(0.5 + 0.5 * fraction))
  throwIfAborted(run.signal)
  onProgress(1)
  return { read, chatAvailable: chatAvailableOf(read, source), chatFailure }
}

/** 平均每分鐘 N 則: one decimal below 10 per minute (2.5, 3), whole numbers from 10 on (12, 130). */
export function formatPerMinute(perHour: number): string {
  const perMinute = perHour / 60
  return String(perMinute >= 10 ? Math.round(perMinute) : Math.round(perMinute * 10) / 10)
}

function state(kind: SignalState['kind'], status: SignalState['status'], reason: string | null): SignalState {
  return { kind, status, reason }
}

/** design.md「聊天室密度」: from <videoId>.live_chat.json, recomputed every run. */
async function chatSignal(run: AnalysisRun, data: YoutubeRunData, durationSec: number): Promise<{ state: SignalState, values: Float32Array | null }> {
  const missing = (reason: string) => {
    run.log(`聊天室密度沒有用到：${reason}`)
    return { state: state('chat', 'missing', reason), values: null }
  }
  const file = chatFileOf(run)
  // An existing file is used even when this run's metadata no longer lists the chat (a read degraded by YouTube).
  if (!(await isFile(file))) return missing(data.chatFailure ?? (data.chatAvailable ? CHAT_UNREADABLE_REASON : NO_CHAT_REASON))
  let density
  try {
    density = chatDensity(await readChatMessages(file, durationSec), durationSec)
  }
  catch (err) {
    run.log(`讀取聊天室重播檔失敗：${errorText(err)}`)
    return missing(CHAT_UNREADABLE_REASON)
  }
  const rate = `算進 ${density.counted} 則訊息，平均每小時 ${Math.round(density.perHour)} 則`
  if (density.perHour < CHAT_MIN_PER_HOUR) {
    run.log(`聊天室密度：${rate}，少於 ${CHAT_MIN_PER_HOUR} 則，不採用`)
    return { state: state('chat', 'missing', CHAT_TOO_FEW_REASON), values: null }
  }
  run.log(`聊天室密度：${rate}，採用`)
  return { state: state('chat', 'used', `平均每分鐘 ${formatPerMinute(density.perHour)} 則`), values: density.values }
}

/**
 * design.md「重播熱度」: the markers of this run's read; without them (read failed, or the read has no
 * heatmap) the ones of the last signals.json.
 */
function heatmapSignal(run: AnalysisRun, data: YoutubeRunData, durationSec: number, previous: SignalsFile['heatmap']): Pick<YoutubeSignals, 'heatmap' | 'heatmapFile'> & { state: SignalState } {
  const missing = (reason: string, heatmapFile: SignalsFile['heatmap']) => {
    run.log(`重播熱度沒有用到：${reason}`)
    return { state: state('heatmap', 'missing', reason), heatmap: null, heatmapFile }
  }
  const { read } = data
  let file: NonNullable<SignalsFile['heatmap']>
  if (read.ok && read.meta.heatmap) {
    file = { markers: read.meta.heatmap, fetchedAt: read.meta.fetchedAt }
  }
  else if (previous) {
    file = previous
    run.log(`${read.ok ? '這次的影片資訊沒有重播熱度' : '這次讀不到影片資訊'}，沿用上次取得的重播熱度（${previous.fetchedAt}）`)
  }
  else {
    return missing(read.ok ? NO_HEATMAP_REASON : `${HEATMAP_FAILED_PREFIX}${read.reason}`, null)
  }
  const track = heatmapTrack(file.markers, durationSec)
  if (track.kind === 'flat') return missing(FLAT_HEATMAP_REASON, file)
  if (track.kind === 'invalid') return missing(NO_HEATMAP_REASON, file)
  run.log(`重播熱度：${file.markers.length} 段，採用`)
  return { state: state('heatmap', 'used', null), heatmap: { values: track.values, covered: track.covered }, heatmapFile: file }
}

/**
 * The chat and heatmap Signals of a YouTube video over `durationSec` (the probed length). `previous`:
 * the heatmap of the last signals.json, used when this run has none.
 */
export async function youtubeSignals(run: AnalysisRun, data: YoutubeRunData, durationSec: number, previous: SignalsFile['heatmap']): Promise<YoutubeSignals> {
  const chat = await chatSignal(run, data, durationSec)
  throwIfAborted(run.signal)
  const heatmap = heatmapSignal(run, data, durationSec, previous)
  return { states: [chat.state, heatmap.state], chat: chat.values, heatmap: heatmap.heatmap, heatmapFile: heatmap.heatmapFile }
}
