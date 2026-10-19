// Domain types shared by the server and the UI.
// Names follow GLOSSARY.md (English canonical names).

export type SourceKind = 'watch-folder' | 'upload' | 'youtube'

/** Spoken language chosen when a Source Video is added. Decides the ASR model. */
export type Language = 'zh' | 'en'

export type AnalysisStatus = 'queued' | 'running' | 'done' | 'failed'

/**
 * Steps of one Analysis, in run order. Milestone 1 runs probe → extract-audio →
 * transcribe → prepare-preview. Later milestones add download (YouTube),
 * signals and candidates.
 */
export type AnalysisStep =
  | 'download'
  | 'probe'
  | 'extract-audio'
  | 'transcribe'
  | 'prepare-preview'
  | 'signals'
  | 'candidates'

export type HighlightStatus = 'candidate' | 'selected' | 'dismissed'

export type HighlightOrigin = 'analysis' | 'manual'

export type Layout = 'blurred-background' | 'center-crop' | 'original'

export type ClipStatus = 'queued' | 'running' | 'done' | 'failed'

/** Upper length that Shorts/Reels accept; longer manual Highlights only get a warning. */
export const MAX_SHORTS_SECONDS = 180

export interface AudioTrack {
  /** Audio-relative index (0 = first audio stream), as used by ffmpeg `0:a:N`. */
  index: number
  codec: string
  channels: number
  language: string | null
  title: string | null
}

export interface MediaInfo {
  durationSec: number
  width: number
  height: number
  fps: number
  videoCodec: string
  /** ffprobe format_name, e.g. "matroska,webm" or "mov,mp4,m4a,3gp,3g2,mj2". */
  container: string
  audioTracks: AudioTrack[]
}

export interface AnalysisState {
  status: AnalysisStatus
  step: AnalysisStep | null
  /** Overall progress of the whole Analysis, 0–1. */
  progress: number
  error: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface SourceVideo {
  id: string
  title: string
  sourceKind: SourceKind
  /** Absolute path of the video file; null until a YouTube download finishes. */
  filePath: string | null
  youtubeUrl: string | null
  language: Language
  /** Audio track used for transcription (and later, signals). Preview and Clips use track 0. */
  audioTrack: number
  media: MediaInfo | null
  analysis: AnalysisState
  /** True when filePath is set but the file no longer exists on disk. */
  fileMissing: boolean
  createdAt: string
}

export interface TranscriptSegment {
  /** 0-based position in the Transcript. */
  idx: number
  start: number
  end: number
  text: string
  /** True once the user changed the text away from the ASR result. */
  edited: boolean
}

export interface Highlight {
  id: string
  videoId: string
  start: number
  end: number
  status: HighlightStatus
  origin: HighlightOrigin
  /** Highlight Score, 0–1; null for manual Highlights. */
  score: number | null
  /** Highlight Reason; null for manual Highlights. */
  reason: string | null
  createdAt: string
  updatedAt: string
}

export interface Clip {
  id: string
  videoId: string
  highlightId: string
  /** Range snapshot taken at Export time; later Highlight edits don't change it. */
  start: number
  end: number
  layout: Layout
  burnSubtitles: boolean
  status: ClipStatus
  progress: number
  error: string | null
  /** True once the clip file exists and can be downloaded. */
  hasFile: boolean
  hasSrt: boolean
  createdAt: string
  finishedAt: string | null
}

/** A file inside a Watch Folder, as listed for "加入影片". */
export interface WatchFolderFile {
  path: string
  name: string
  folder: string
  sizeBytes: number
  modifiedAt: string
  /** True if a Source Video in the Library already points at this path. */
  inLibrary: boolean
}

export interface Settings {
  watchFolders: string[]
}

export interface SystemInfo {
  version: string
  videoEncoder: 'h264_nvenc' | 'libx264'
  dataDir: string
  fontsReady: boolean
}

// ---- API request bodies ----

export interface AddVideoBody {
  sourceKind: 'watch-folder' | 'upload'
  /** For watch-folder: absolute path inside a configured Watch Folder. */
  filePath?: string
  /** For upload: id returned by POST /api/uploads. */
  uploadId?: string
  language: Language
  audioTrack: number
}

export interface UploadResult {
  uploadId: string
  fileName: string
  media: MediaInfo
}

export interface CreateHighlightBody {
  start: number
  end: number
}

export interface UpdateHighlightBody {
  start?: number
  end?: number
  status?: HighlightStatus
}

export interface CreateClipBody {
  layout: Layout
  burnSubtitles: boolean
}

export interface UpdateSegmentBody {
  text: string
}
