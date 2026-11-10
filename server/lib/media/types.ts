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
