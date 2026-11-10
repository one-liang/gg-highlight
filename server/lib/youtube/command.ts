// yt-dlp argv builders (design.md「yt-dlp」「下載」, ADR-0003). Pure except the ffmpeg existence check.
import fs from 'node:fs'
import path from 'node:path'
import type { YtdlpConfig } from './types'

/** One progress line per update: `GGDL <format id> <JSON of the progress fields>` (parsed by progress.ts). */
export const PROGRESS_TEMPLATE
  = 'download:GGDL %(info.format_id)s %(progress.{status,downloaded_bytes,total_bytes,total_bytes_estimate,fragment_index,fragment_count})j'
/** Printed once the final file is in place: `GGFILE <JSON string of the absolute path>`. */
export const FILE_PRINT_TEMPLATE = 'after_move:GGFILE %(filepath)j'
export const FORMAT_SELECTOR = 'bv*+ba/b'
/** At most 1080p (smallest side), preferring H.264 + AAC so browsers play the file as is. */
export const FORMAT_SORT = 'res:1080,vcodec:h264,acodec:aac'

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** --ffmpeg-location only for an existing absolute path: a bare name like `ffmpeg` makes yt-dlp give up on ffmpeg. */
export function usableFfmpegLocation(ffmpegPath: string, exists: (p: string) => boolean = fs.existsSync): boolean {
  return path.isAbsolute(ffmpegPath) && exists(ffmpegPath)
}

/** Flags of every run: ignore user config, never a playlist, never self-update, Node as a JS runtime fallback. */
export function baseArgs(config: Pick<YtdlpConfig, 'ffmpegPath' | 'nodePath'>, exists?: (p: string) => boolean): string[] {
  const args = ['--no-config', '--no-playlist', '--no-update', '--js-runtimes', `node:${config.nodePath}`]
  if (usableFfmpegLocation(config.ffmpegPath, exists)) args.push('--ffmpeg-location', config.ffmpegPath)
  return args
}

/** `-J`: the metadata as one JSON document on stdout. */
export function metadataArgs(config: Pick<YtdlpConfig, 'ffmpegPath' | 'nodePath'>, url: string, exists?: (p: string) => boolean): string[] {
  return [...baseArgs(config, exists), '-J', '--skip-download', '--', url]
}

/** Output template: <videoId>.<ext> inside downloadsDir (subtitles become <videoId>.<lang>.<ext>). */
function outputArgs(config: Pick<YtdlpConfig, 'downloadsDir'>, videoId: string): string[] {
  // The id goes into yt-dlp's output template, so it must not contain template syntax or path parts.
  if (!SAFE_ID_RE.test(videoId)) throw new Error(`不合法的影片 ID：${videoId}`)
  return ['-P', config.downloadsDir, '-o', `${videoId}.%(ext)s`]
}

/** Video file download with machine-readable progress and the final path. */
export function videoDownloadArgs(config: Omit<YtdlpConfig, 'command' | 'updateStampPath'>, url: string, videoId: string, exists?: (p: string) => boolean): string[] {
  return [
    ...baseArgs(config, exists),
    '-f', FORMAT_SELECTOR,
    '-S', FORMAT_SORT,
    '--merge-output-format', 'mp4',
    ...outputArgs(config, videoId),
    '--newline',
    '--progress',
    '--progress-delta', '1',
    '--progress-template', PROGRESS_TEMPLATE,
    '--print', FILE_PRINT_TEMPLATE,
    '--', url,
  ]
}

/** Live chat replay only (a separate run: a chat failure must not fail the video download). */
export function chatDownloadArgs(config: Omit<YtdlpConfig, 'command' | 'updateStampPath'>, url: string, videoId: string, exists?: (p: string) => boolean): string[] {
  return [
    ...baseArgs(config, exists),
    '--skip-download',
    '--write-subs',
    '--sub-langs', 'live_chat',
    ...outputArgs(config, videoId),
    '--', url,
  ]
}

/** <downloadsDir>/<videoId>.live_chat.json: yt-dlp names subtitles <output name without ext>.<lang>.<ext>. */
export function chatFilePath(downloadsDir: string, videoId: string): string {
  return path.join(downloadsDir, `${videoId}.live_chat.json`)
}

/** Where yt-dlp writes the chat while downloading (appended to, never resumed: delete before a new run). */
export function chatPartPath(downloadsDir: string, videoId: string): string {
  return `${chatFilePath(downloadsDir, videoId)}.part`
}
