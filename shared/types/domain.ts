// Domain types shared by the server and the UI.
// Names follow GLOSSARY.md (English canonical names).

export type SourceKind = 'watch-folder' | 'upload' | 'youtube'

/** Spoken language chosen when a Source Video is added. Decides the ASR model. */
export type Language = 'zh' | 'en'

export type AnalysisStatus = 'queued' | 'running' | 'done' | 'failed'

/**
 * Steps of one Analysis, in run order. A 'full' run: probe → extract-audio → transcribe →
 * prepare-preview → signals → candidates. A 'highlights' run: extract-audio (skipped when the
 * loudness is cached) → signals → candidates. Milestone 3 adds download (YouTube).
 */
export type AnalysisStep =
  | 'download'
  | 'probe'
  | 'extract-audio'
  | 'transcribe'
  | 'prepare-preview'
  | 'signals'
  | 'candidates'

/**
 * 'full' = transcribe again and find highlights; 'highlights' = keep the Transcript (and the user's
 * edits) and only find highlights again. The first Analysis of a video is always 'full'.
 */
export type AnalysisMode = 'full' | 'highlights'

/**
 * Version of the Analysis pipeline. 1 = milestone 1 (Transcript only), 2 = milestone 2 (Signals and
 * candidate Highlights). A done Analysis with a lower version gets a "find highlights" banner.
 */
export const ANALYSIS_VERSION = 2

/** `error` of an Analysis or Clip whose job was cancelled (e.g. the video was removed mid-run). */
export const CANCELLED_MESSAGE = '已取消'

/** The four Signals of GLOSSARY.md. Milestone 2 has loudness and transcript; milestone 3 adds chat and heatmap. */
export type SignalKind = 'loudness' | 'transcript' | 'chat' | 'heatmap'

/**
 * SignalState.reason of a transcript Signal that is missing on purpose or for lack of speech: unlike
 * the other reasons (Ollama not running, no model…), running 只重新找精華片段 again does not help.
 */
export const TRANSCRIPT_SIGNAL_DISABLED_REASON = '已關閉 AI 讀逐字稿（GG_OLLAMA_URL=off）'
export const TRANSCRIPT_SIGNAL_EMPTY_REASON = '逐字稿沒有內容'

export interface SignalState {
  kind: SignalKind
  /** 'used' = it contributed to the Highlight Score; 'missing' = not available this time (no penalty). */
  status: 'used' | 'missing'
  /** zh-TW note for the user: why it is missing, or a caveat when used (e.g. "2 個區段讀取失敗"). */
  reason: string | null
}

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
  /** Mode of the current / last run. */
  mode: AnalysisMode
  /** ANALYSIS_VERSION of the last run that finished ('done'); null while never finished. */
  version: number | null
  /** Signals of the last run that reached the candidates step; null before that. */
  signals: SignalState[] | null
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

export type OllamaStatus =
  /** Reachable, new enough, model pulled. */
  | 'ready'
  /** GG_OLLAMA_URL=off. */
  | 'disabled'
  /** Nothing answers at the URL (not installed or not running). */
  | 'unreachable'
  /** Older than the minimum version (0.31.2). */
  | 'outdated'
  /** Running, but the model is not pulled. */
  | 'model-missing'

export interface OllamaInfo {
  /** Base URL, e.g. http://127.0.0.1:11434; null when disabled. */
  url: string | null
  model: string
  status: OllamaStatus
  /** Ollama's version when reachable. */
  version: string | null
}

export interface SystemInfo {
  version: string
  videoEncoder: 'h264_nvenc' | 'libx264'
  /** True when GG_VIDEO_ENCODER chose the encoder instead of detection. */
  videoEncoderForced: boolean
  dataDir: string
  fontsReady: boolean
  ollama: OllamaInfo
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

export interface ReanalyzeBody {
  mode: AnalysisMode
}
