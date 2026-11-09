// Repositories: SQL rows <-> domain objects. Ids are random UUIDs, timestamps ISO strings.
import { randomUUID } from 'node:crypto'
import type { SQLInputValue } from 'node:sqlite'
import type {
  AnalysisMode, AnalysisState, AnalysisStatus, AnalysisStep, Clip, ClipStatus, Highlight, HighlightOrigin,
  HighlightStatus, Language, Layout, MediaInfo, Settings, SignalKind, SignalState, SourceKind, TranscriptSegment,
} from '../../../shared/types/domain'
import { transaction } from './schema'
import type { ClipRecord, Db, Repositories, VideoRecord } from './types'

type Row = Record<string, SQLInputValue>

interface VideoRow {
  id: string
  title: string
  source_kind: SourceKind
  file_path: string | null
  youtube_url: string | null
  language: Language
  audio_track: number
  media_json: string | null
  preview_path: string | null
  analysis_status: AnalysisStatus
  analysis_step: AnalysisStep | null
  analysis_progress: number
  analysis_error: string | null
  analysis_queued_at: string | null
  analysis_started_at: string | null
  analysis_finished_at: string | null
  analysis_mode: AnalysisMode
  analysis_version: number | null
  analysis_signals_json: string | null
  created_at: string
}

interface SegmentRow {
  idx: number
  start: number
  end: number
  text: string
  original_text: string
}

interface HighlightRow {
  id: string
  video_id: string
  start: number
  end: number
  status: HighlightStatus
  origin: HighlightOrigin
  score: number | null
  reason: string | null
  created_at: string
  updated_at: string
}

interface ClipRow {
  id: string
  video_id: string
  highlight_id: string
  start: number
  end: number
  layout: Layout
  burn_subtitles: number
  status: ClipStatus
  progress: number
  error: string | null
  file_name: string | null
  srt_file_name: string | null
  created_at: string
  finished_at: string | null
}

const DEFAULT_SETTINGS: Settings = { watchFolders: [] }

function now(): string {
  return new Date().toISOString()
}

function parseMedia(json: string | null): MediaInfo | null {
  if (!json) return null
  try {
    return JSON.parse(json) as MediaInfo
  }
  catch {
    return null
  }
}

const SIGNAL_KINDS: ReadonlySet<string> = new Set<SignalKind>(['loudness', 'transcript', 'chat', 'heatmap'])

function isSignalState(value: unknown): value is SignalState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.kind === 'string' && SIGNAL_KINDS.has(v.kind)
    && (v.status === 'used' || v.status === 'missing')
    && (v.reason === null || typeof v.reason === 'string')
}

/** Stored SignalState[]; null when absent or not a valid list. */
function parseSignals(json: string | null): SignalState[] | null {
  if (!json) return null
  try {
    const value: unknown = JSON.parse(json)
    if (!Array.isArray(value) || !value.every(isSignalState)) return null
    return value.map(({ kind, status, reason }) => ({ kind, status, reason }))
  }
  catch {
    return null
  }
}

function toVideo(row: VideoRow): VideoRecord {
  return {
    id: row.id,
    title: row.title,
    sourceKind: row.source_kind,
    filePath: row.file_path,
    youtubeUrl: row.youtube_url,
    language: row.language,
    audioTrack: row.audio_track,
    media: parseMedia(row.media_json),
    analysis: {
      status: row.analysis_status,
      mode: row.analysis_mode,
      version: row.analysis_version,
      signals: parseSignals(row.analysis_signals_json),
      step: row.analysis_step,
      progress: row.analysis_progress,
      error: row.analysis_error,
      startedAt: row.analysis_started_at,
      finishedAt: row.analysis_finished_at,
    },
    previewPath: row.preview_path,
    createdAt: row.created_at,
  }
}

function toSegment(row: SegmentRow): TranscriptSegment {
  return {
    idx: row.idx,
    start: row.start,
    end: row.end,
    text: row.text,
    edited: row.text !== row.original_text,
  }
}

function toHighlight(row: HighlightRow): Highlight {
  return {
    id: row.id,
    videoId: row.video_id,
    start: row.start,
    end: row.end,
    status: row.status,
    origin: row.origin,
    score: row.score,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toClipRecord(row: ClipRow): ClipRecord {
  return {
    id: row.id,
    videoId: row.video_id,
    highlightId: row.highlight_id,
    start: row.start,
    end: row.end,
    layout: row.layout,
    burnSubtitles: row.burn_subtitles !== 0,
    status: row.status,
    progress: row.progress,
    error: row.error,
    fileName: row.file_name,
    srtFileName: row.srt_file_name,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  }
}

/**
 * Keep rule of a new Analysis (design.md「重新分析」): selected, dismissed and manual Highlights, and
 * any Highlight with clips, stay; only analysis candidates that were never exported are replaced.
 * REPLACEABLE_SQL below is the same rule in SQL.
 */
export function isKeptOnReanalysis(highlight: Pick<Highlight, 'origin' | 'status'>, hasClips: boolean): boolean {
  return !(highlight.origin === 'analysis' && highlight.status === 'candidate' && !hasClips)
}

/** WHERE condition (on the highlights table) for the Highlights a new Analysis replaces. */
const REPLACEABLE_SQL = `(origin = 'analysis' AND status = 'candidate'
  AND NOT EXISTS (SELECT 1 FROM clips WHERE clips.highlight_id = highlights.id))`

function overlaps(a: { start: number, end: number }, b: { start: number, end: number }): boolean {
  return a.start < b.end && b.start < a.end
}

export function toClip(record: ClipRecord): Clip {
  const { fileName, srtFileName, ...rest } = record
  return { ...rest, hasFile: fileName !== null, hasSrt: srtFileName !== null }
}

/** UPDATE <table> SET <columns> WHERE id = :id; returns false when nothing matched. */
function updateById(db: Db, table: string, id: string, columns: Row): boolean {
  const names = Object.keys(columns)
  if (names.length === 0) return true
  const set = names.map(name => `"${name}" = :${name}`).join(', ')
  const result = db.prepare(`UPDATE ${table} SET ${set} WHERE id = :id`).run({ ...columns, id })
  return Number(result.changes) > 0
}

function parseWatchFolders(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

export function createRepositories(db: Db): Repositories {
  const caseInsensitivePaths = process.platform === 'win32'

  const getVideo = (id: string) => {
    const row = db.prepare('SELECT * FROM videos WHERE id = ?').get(id) as VideoRow | undefined
    return row ? toVideo(row) : null
  }
  const getHighlight = (id: string) => {
    const row = db.prepare('SELECT * FROM highlights WHERE id = ?').get(id) as HighlightRow | undefined
    return row ? toHighlight(row) : null
  }
  const getClip = (id: string) => {
    const row = db.prepare('SELECT * FROM clips WHERE id = ?').get(id) as ClipRow | undefined
    return row ? toClipRecord(row) : null
  }

  const videos: Repositories['videos'] = {
    insert(video) {
      const id = randomUUID()
      const ts = now()
      db.prepare(`
        INSERT INTO videos (
          id, title, source_kind, file_path, youtube_url, language, audio_track, media_json,
          preview_path, analysis_status, analysis_step, analysis_progress, analysis_error,
          analysis_queued_at, analysis_started_at, analysis_finished_at, created_at
        ) VALUES (
          :id, :title, :sourceKind, :filePath, :youtubeUrl, :language, :audioTrack, :media,
          NULL, 'queued', NULL, 0, NULL, :ts, NULL, NULL, :ts
        )
      `).run({
        id,
        title: video.title,
        sourceKind: video.sourceKind,
        filePath: video.filePath,
        youtubeUrl: video.youtubeUrl,
        language: video.language,
        audioTrack: video.audioTrack,
        media: video.media ? JSON.stringify(video.media) : null,
        ts,
      })
      return getVideo(id)!
    },

    get: getVideo,

    list() {
      const rows = db.prepare('SELECT * FROM videos ORDER BY created_at DESC, rowid DESC').all() as unknown as VideoRow[]
      return rows.map(toVideo)
    },

    findByFilePath(filePath) {
      const collate = caseInsensitivePaths ? ' COLLATE NOCASE' : ''
      const row = db.prepare(`SELECT * FROM videos WHERE file_path = ?${collate} ORDER BY created_at, rowid LIMIT 1`)
        .get(filePath) as VideoRow | undefined
      return row ? toVideo(row) : null
    },

    update(id, patch) {
      const columns: Row = {}
      if (patch.title !== undefined) columns.title = patch.title
      if (patch.filePath !== undefined) columns.file_path = patch.filePath
      if (patch.media !== undefined) columns.media_json = patch.media ? JSON.stringify(patch.media) : null
      if (patch.previewPath !== undefined) columns.preview_path = patch.previewPath
      if (!updateById(db, 'videos', id, columns)) return null
      return getVideo(id)
    },

    updateAnalysis(id, patch) {
      const current = getVideo(id)
      if (!current) return null
      const columns: Row = {}
      const ts = now()
      const status = patch.status
      // Side effects only on a status change, so progress ticks ('running' again) keep startedAt.
      if (status !== undefined && status !== current.analysis.status) {
        columns.analysis_status = status
        if (status === 'queued') {
          columns.analysis_queued_at = ts
          columns.analysis_step = null
          columns.analysis_progress = 0
          columns.analysis_error = null
          columns.analysis_started_at = null
          columns.analysis_finished_at = null
        }
        else if (status === 'running') {
          columns.analysis_started_at = ts
          columns.analysis_finished_at = null
          columns.analysis_error = null
        }
        else {
          columns.analysis_finished_at = ts
          if (status === 'done') {
            columns.analysis_progress = 1
            columns.analysis_error = null
          }
        }
      }
      if (patch.step !== undefined) columns.analysis_step = patch.step
      if (patch.progress !== undefined) columns.analysis_progress = patch.progress
      if (patch.error !== undefined) columns.analysis_error = patch.error
      if (patch.startedAt !== undefined) columns.analysis_started_at = patch.startedAt
      if (patch.finishedAt !== undefined) columns.analysis_finished_at = patch.finishedAt
      if (patch.mode !== undefined) columns.analysis_mode = patch.mode
      if (patch.version !== undefined) columns.analysis_version = patch.version
      if (patch.signals !== undefined) columns.analysis_signals_json = patch.signals ? JSON.stringify(patch.signals) : null
      updateById(db, 'videos', id, columns)
      return getVideo(id)
    },

    nextQueued() {
      const row = db.prepare(`
        SELECT * FROM videos WHERE analysis_status = 'queued'
        ORDER BY analysis_queued_at, rowid LIMIT 1
      `).get() as VideoRow | undefined
      return row ? toVideo(row) : null
    },

    listByAnalysisStatus(status: AnalysisState['status']) {
      const rows = db.prepare('SELECT * FROM videos WHERE analysis_status = ? ORDER BY analysis_queued_at, rowid')
        .all(status) as unknown as VideoRow[]
      return rows.map(toVideo)
    },

    delete(id) {
      db.prepare('DELETE FROM videos WHERE id = ?').run(id)
    },
  }

  const transcript: Repositories['transcript'] = {
    replace(videoId, segments) {
      transaction(db, () => {
        db.prepare('DELETE FROM transcript_segments WHERE video_id = ?').run(videoId)
        const insert = db.prepare(`
          INSERT INTO transcript_segments (video_id, idx, "start", "end", text, original_text)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        segments.forEach((segment, idx) => {
          insert.run(videoId, idx, segment.start, segment.end, segment.text, segment.text)
        })
      })
    },

    list(videoId) {
      const rows = db.prepare(`
        SELECT idx, "start", "end", text, original_text FROM transcript_segments
        WHERE video_id = ? ORDER BY idx
      `).all(videoId) as unknown as SegmentRow[]
      return rows.map(toSegment)
    },

    updateText(videoId, idx, text) {
      const result = db.prepare('UPDATE transcript_segments SET text = ? WHERE video_id = ? AND idx = ?')
        .run(text, videoId, idx)
      if (Number(result.changes) === 0) return null
      const row = db.prepare(`
        SELECT idx, "start", "end", text, original_text FROM transcript_segments
        WHERE video_id = ? AND idx = ?
      `).get(videoId, idx) as SegmentRow | undefined
      return row ? toSegment(row) : null
    },
  }

  const listHighlights = (videoId: string, where = '') => {
    const rows = db.prepare(`SELECT * FROM highlights WHERE video_id = ?${where} ORDER BY "start", "end", rowid`)
      .all(videoId) as unknown as HighlightRow[]
    return rows.map(toHighlight)
  }

  const highlights: Repositories['highlights'] = {
    insert(highlight) {
      const id = randomUUID()
      const ts = now()
      db.prepare(`
        INSERT INTO highlights (id, video_id, "start", "end", status, origin, score, reason, created_at, updated_at)
        VALUES (:id, :videoId, :start, :end, :status, :origin, :score, :reason, :ts, :ts)
      `).run({
        id,
        videoId: highlight.videoId,
        start: highlight.start,
        end: highlight.end,
        status: highlight.status,
        origin: highlight.origin,
        score: highlight.score,
        reason: highlight.reason,
        ts,
      })
      return getHighlight(id)!
    },

    get: getHighlight,

    listByVideo(videoId) {
      return listHighlights(videoId)
    },

    update(id, patch) {
      const columns: Row = {}
      if (patch.start !== undefined) columns.start = patch.start
      if (patch.end !== undefined) columns.end = patch.end
      if (patch.status !== undefined) columns.status = patch.status
      if (patch.score !== undefined) columns.score = patch.score
      if (patch.reason !== undefined) columns.reason = patch.reason
      if (Object.keys(columns).length > 0) columns.updated_at = now()
      if (!updateById(db, 'highlights', id, columns)) return null
      return getHighlight(id)
    },

    deleteByVideo(videoId, origin) {
      if (origin) db.prepare('DELETE FROM highlights WHERE video_id = ? AND origin = ?').run(videoId, origin)
      else db.prepare('DELETE FROM highlights WHERE video_id = ?').run(videoId)
    },

    listKept(videoId) {
      return listHighlights(videoId, ` AND NOT ${REPLACEABLE_SQL}`)
    },

    replaceAnalysisCandidates(videoId, drafts) {
      return transaction(db, () => {
        db.prepare(`DELETE FROM highlights WHERE video_id = ? AND ${REPLACEABLE_SQL}`).run(videoId)
        // Re-read inside the transaction: the user may have selected, exported or added Highlights
        // while the candidates were being computed.
        const taken: Array<{ start: number, end: number }> = listHighlights(videoId)
        const inserted: Highlight[] = []
        for (const draft of [...drafts].sort((a, b) => a.start - b.start)) {
          if (!(draft.end > draft.start) || taken.some(range => overlaps(range, draft))) continue
          taken.push(draft)
          inserted.push(highlights.insert({
            videoId, start: draft.start, end: draft.end, status: 'candidate', origin: 'analysis', score: draft.score, reason: draft.reason,
          }))
        }
        return inserted
      })
    },
  }

  const clips: Repositories['clips'] = {
    insert(clip) {
      const id = randomUUID()
      db.prepare(`
        INSERT INTO clips (
          id, video_id, highlight_id, "start", "end", layout, burn_subtitles, status, progress,
          error, file_name, srt_file_name, created_at, finished_at
        ) VALUES (
          :id, :videoId, :highlightId, :start, :end, :layout, :burnSubtitles, 'queued', 0,
          NULL, NULL, NULL, :ts, NULL
        )
      `).run({
        id,
        videoId: clip.videoId,
        highlightId: clip.highlightId,
        start: clip.start,
        end: clip.end,
        layout: clip.layout,
        burnSubtitles: clip.burnSubtitles ? 1 : 0,
        ts: now(),
      })
      return getClip(id)!
    },

    get: getClip,

    listByVideo(videoId) {
      const rows = db.prepare('SELECT * FROM clips WHERE video_id = ? ORDER BY created_at DESC, rowid DESC')
        .all(videoId) as unknown as ClipRow[]
      return rows.map(toClipRecord)
    },

    update(id, patch) {
      const current = getClip(id)
      if (!current) return null
      const columns: Row = {}
      if (patch.status !== undefined && patch.status !== current.status) {
        columns.status = patch.status
        if (patch.status === 'done' || patch.status === 'failed') columns.finished_at = now()
        if (patch.status === 'done') columns.progress = 1
      }
      if (patch.progress !== undefined) columns.progress = patch.progress
      if (patch.error !== undefined) columns.error = patch.error
      if (patch.fileName !== undefined) columns.file_name = patch.fileName
      if (patch.srtFileName !== undefined) columns.srt_file_name = patch.srtFileName
      if (patch.finishedAt !== undefined) columns.finished_at = patch.finishedAt
      updateById(db, 'clips', id, columns)
      return getClip(id)
    },

    nextQueued() {
      const row = db.prepare(`SELECT * FROM clips WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1`)
        .get() as ClipRow | undefined
      return row ? toClipRecord(row) : null
    },

    listByStatus(status) {
      const rows = db.prepare('SELECT * FROM clips WHERE status = ? ORDER BY created_at, rowid')
        .all(status) as unknown as ClipRow[]
      return rows.map(toClipRecord)
    },
  }

  const settings: Repositories['settings'] = {
    get() {
      const rows = db.prepare('SELECT key, value FROM settings').all() as unknown as { key: string, value: string }[]
      const result: Settings = { ...DEFAULT_SETTINGS, watchFolders: [...DEFAULT_SETTINGS.watchFolders] }
      for (const { key, value } of rows) {
        let parsed: unknown
        try {
          parsed = JSON.parse(value)
        }
        catch {
          continue
        }
        if (key === 'watchFolders') result.watchFolders = parseWatchFolders(parsed)
      }
      return result
    },

    save(next) {
      const upsert = db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
      `)
      transaction(db, () => {
        upsert.run('watchFolders', JSON.stringify(parseWatchFolders(next.watchFolders)))
      })
      return settings.get()
    },
  }

  return { videos, transcript, highlights, clips, settings }
}
