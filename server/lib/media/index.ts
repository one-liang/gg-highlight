// ffmpeg/ffprobe wrappers: probing, audio extraction, browser preview and clip export.
import type { Layout, MediaInfo } from '../../../shared/types/domain'

export interface MediaTools {
  ffmpegPath: string
  ffprobePath: string
}

export type VideoEncoder = 'h264_nvenc' | 'libx264'

export interface RunOptions {
  cwd?: string
  signal?: AbortSignal
  /** Media duration the command processes; enables onProgress (0–1) from `-progress`. */
  durationSec?: number
  onProgress?: (progress: number) => void
}

/** Runs ffmpeg; rejects with an Error carrying the stderr tail; rejects with AbortError on abort. */
export function runFfmpeg(tools: MediaTools, args: string[], opts?: RunOptions): Promise<void> {
  throw new Error('not implemented')
}

export function probeMedia(tools: MediaTools, filePath: string): Promise<MediaInfo> {
  throw new Error('not implemented')
}

/** Extracts one audio track as 16 kHz mono 16-bit WAV for ASR. */
export function extractAudio(
  tools: MediaTools,
  input: { filePath: string, audioTrack: number, durationSec: number },
  outWav: string,
  opts?: RunOptions,
): Promise<void> {
  throw new Error('not implemented')
}

/**
 * How the browser will play the source: 'original' when the container is mp4/mov with
 * h264/av1/vp9 video and aac/mp3/opus (or no) first audio track; 'remux' when only the
 * container (or audio codec) is the problem; 'transcode' otherwise.
 */
export function previewPlan(media: MediaInfo): 'original' | 'remux' | 'transcode' {
  throw new Error('not implemented')
}

/**
 * Makes a browser-playable mp4 at outPath (video + audio track 0) when previewPlan says so.
 * Returns null when the original file can be played as is.
 */
export function preparePreview(
  tools: MediaTools,
  input: { filePath: string, media: MediaInfo },
  outPath: string,
  opts?: RunOptions & { encoder?: VideoEncoder },
): Promise<{ previewPath: string | null }> {
  throw new Error('not implemented')
}

/** Picks h264_nvenc when a tiny test encode succeeds, else libx264. Cached per ffmpeg path. */
export function detectVideoEncoder(tools: MediaTools, override?: VideoEncoder | null): Promise<VideoEncoder> {
  throw new Error('not implemented')
}

export interface ExportJob {
  input: string
  media: MediaInfo
  start: number
  end: number
  layout: Layout
  /** ASS subtitle file to burn in, or null for no subtitles. */
  assPath: string | null
  fontsDir: string
  output: string
  encoder: VideoEncoder
}

/** 1080x1920 for the vertical Layouts; source size capped at 1080p (even dims) for 'original'. */
export function outputSizeFor(layout: Layout, media: MediaInfo): { width: number, height: number } {
  throw new Error('not implemented')
}

/**
 * Escapes a file path for use as a filter option value inside an ffmpeg filtergraph
 * (e.g. subtitles=filename=...:fontsdir=...), including Windows drive letters.
 */
export function escapeFilterPath(filePath: string): string {
  throw new Error('not implemented')
}

/** Full ffmpeg argv (without the binary) for one Clip export. Audio = track 0 when present. */
export function buildExportArgs(job: ExportJob): string[] {
  throw new Error('not implemented')
}

export function exportClip(tools: MediaTools, job: ExportJob, opts?: RunOptions): Promise<void> {
  throw new Error('not implemented')
}

/** True when fontsDir holds at least one .otf/.ttf/.ttc file. */
export function fontsReady(fontsDir: string): Promise<boolean> {
  throw new Error('not implemented')
}
