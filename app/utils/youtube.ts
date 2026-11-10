// YouTube helpers for 「加入影片」's YouTube tab, the library and the video page (design.md「YouTube」).
import type { AddVideoBody, Language, SourceVideo, YoutubeInfo, YoutubeLiveStatus } from '../../shared/types/domain'
import { parseYoutubeUrl } from '../../shared/utils/youtube-url'

/** Placeholder of the link field. */
export const YOUTUBE_URL_PLACEHOLDER = 'https://www.youtube.com/watch?v=…'

/** Shown while POST /api/youtube/probe runs (it usually takes 5–20 s, up to about 90 s). */
export const YOUTUBE_PROBE_LOADING_TEXT = '正在向 YouTube 讀取影片資訊…（約 5–20 秒）'

/** Rights notice of the YouTube preview (README「關於 YouTube」). */
export const YOUTUBE_RIGHTS_NOTICE = '請只下載你自己擁有或已取得授權的影片。影片檔會存在 data/downloads/，從影片庫移除時一起刪除。'

export type YoutubeInputState =
  /** Nothing typed yet: no message, the button stays disabled. */
  | { kind: 'empty' }
  | { kind: 'invalid', message: string }
  /** `url` is the canonical https://www.youtube.com/watch?v=<id>. */
  | { kind: 'valid', id: string, url: string }

/** Instant feedback for the link field, with the same parser the server uses (shared/utils/youtube-url.ts). */
export function youtubeInputState(text: string): YoutubeInputState {
  if (!text.trim()) return { kind: 'empty' }
  const parsed = parseYoutubeUrl(text)
  return parsed.ok ? { kind: 'valid', id: parsed.id, url: parsed.url } : { kind: 'invalid', message: parsed.message }
}

/** 「直播重播」 for a live stream replay, 「影片」 otherwise (only not_live / was_live can be added). */
export function youtubeKindLabel(liveStatus: YoutubeLiveStatus | null | undefined): string {
  return liveStatus === 'was_live' ? '直播重播' : '影片'
}

export function chatAvailabilityText(available: boolean): string {
  return available ? '有' : '沒有'
}

/** The heatmap often appears later (once the video has enough views), hence 「還沒有」. */
export function heatmapAvailabilityText(available: boolean): string {
  return available ? '有' : '還沒有'
}

/** Language preselected from the video's metadata; 中文 when it gives none. */
export function languageFromHint(hint: Language | null | undefined): Language {
  return hint ?? 'zh'
}

/** POST /api/videos body for a probed YouTube video: one audio track after download, so audioTrack is 0. */
export function youtubeAddBody(info: Pick<YoutubeInfo, 'url'>, language: Language): AddVideoBody {
  return { sourceKind: 'youtube', youtubeUrl: info.url, language, audioTrack: 0 }
}

/** Length to show: from the probed file, else (a YouTube video not downloaded yet) from YouTube; null when unknown. */
export function videoDurationSec(video: Pick<SourceVideo, 'media' | 'youtube'>): number | null {
  const sec = video.media?.durationSec ?? video.youtube?.durationSec ?? null
  return sec !== null && Number.isFinite(sec) && sec > 0 ? sec : null
}

/** 「在 YouTube 開啟」 target: the canonical watch URL of a YouTube video, else null. */
export function youtubeWatchUrl(video: Pick<SourceVideo, 'sourceKind' | 'youtubeUrl'>): string | null {
  if (video.sourceKind !== 'youtube' || !video.youtubeUrl) return null
  return /^https:\/\//i.test(video.youtubeUrl) ? video.youtubeUrl : null
}

/** "2026/10/01" from YouTube's YYYY-MM-DD (yt-dlp's YYYYMMDD also accepted); '' when missing or malformed. */
export function formatUploadDate(date: string | null | undefined): string {
  const m = date ? /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(date.trim()) : null
  return m ? `${m[1]}/${m[2]}/${m[3]}` : ''
}
