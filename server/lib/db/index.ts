// SQLite (node:sqlite) storage for the Library. Repositories return domain objects.
import type { DatabaseSync } from 'node:sqlite'
import type {
  AnalysisState, Clip, Highlight, HighlightOrigin, HighlightStatus, Language, Layout, MediaInfo,
  Settings, SourceKind, SourceVideo, TranscriptSegment,
} from '../../../shared/types/domain'
import type { SegmentDraft } from '../subtitles'

export type Db = DatabaseSync

/** A stored Source Video; fileMissing is computed by the library layer. */
export type VideoRecord = Omit<SourceVideo, 'fileMissing'> & { previewPath: string | null }

export interface NewVideo {
  title: string
  sourceKind: SourceKind
  filePath: string | null
  youtubeUrl: string | null
  language: Language
  audioTrack: number
  media: MediaInfo | null
}

export type ClipRecord = Omit<Clip, 'hasFile' | 'hasSrt'> & {
  fileName: string | null
  srtFileName: string | null
}

export interface NewHighlight {
  videoId: string
  start: number
  end: number
  status: HighlightStatus
  origin: HighlightOrigin
  score: number | null
  reason: string | null
}

export interface Repositories {
  videos: {
    /** New videos start with analysis status 'queued'. */
    insert(video: NewVideo): VideoRecord
    get(id: string): VideoRecord | null
    /** Newest first. */
    list(): VideoRecord[]
    findByFilePath(filePath: string): VideoRecord | null
    update(id: string, patch: Partial<Pick<VideoRecord, 'title' | 'filePath' | 'media' | 'previewPath'>>): VideoRecord | null
    updateAnalysis(id: string, patch: Partial<AnalysisState>): VideoRecord | null
    /** Oldest queued video (FIFO by the time it was queued), or null. */
    nextQueued(): VideoRecord | null
    listByAnalysisStatus(status: AnalysisState['status']): VideoRecord[]
    /** Deletes the row; transcript, highlights and clips cascade. */
    delete(id: string): void
  }
  transcript: {
    /** Replaces all segments of a video (idx = array order). */
    replace(videoId: string, segments: SegmentDraft[]): void
    list(videoId: string): TranscriptSegment[]
    /** Sets the text; `edited` becomes text !== original ASR text. Null if no such segment. */
    updateText(videoId: string, idx: number, text: string): TranscriptSegment | null
  }
  highlights: {
    insert(highlight: NewHighlight): Highlight
    get(id: string): Highlight | null
    /** Ordered by start time. */
    listByVideo(videoId: string): Highlight[]
    update(id: string, patch: Partial<Pick<Highlight, 'start' | 'end' | 'status' | 'score' | 'reason'>>): Highlight | null
    deleteByVideo(videoId: string, origin?: HighlightOrigin): void
  }
  clips: {
    /** New clips start 'queued' with progress 0. */
    insert(clip: { videoId: string, highlightId: string, start: number, end: number, layout: Layout, burnSubtitles: boolean }): ClipRecord
    get(id: string): ClipRecord | null
    /** Newest first. */
    listByVideo(videoId: string): ClipRecord[]
    update(id: string, patch: Partial<Pick<ClipRecord, 'status' | 'progress' | 'error' | 'fileName' | 'srtFileName' | 'finishedAt'>>): ClipRecord | null
    /** Oldest queued clip, or null. */
    nextQueued(): ClipRecord | null
    listByStatus(status: ClipRecord['status']): ClipRecord[]
  }
  settings: {
    get(): Settings
    save(settings: Settings): Settings
  }
}

/** Opens (creating folders and file as needed) and migrates the database. Use ':memory:' in tests. */
export function openDatabase(file: string): Db {
  throw new Error('not implemented')
}

export function createRepositories(db: Db): Repositories {
  throw new Error('not implemented')
}

export function toClip(record: ClipRecord): Clip {
  throw new Error('not implemented')
}
