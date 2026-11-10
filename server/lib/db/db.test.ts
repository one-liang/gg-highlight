import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { Highlight, HighlightOrigin, HighlightStatus, MediaInfo, SignalState, YoutubeMeta } from '../../../shared/types/domain'
import {
  createRepositories, isKeptOnReanalysis, MIGRATIONS, migrate, openDatabase, schemaVersion, toClip,
  type ClipRecord, type Db, type NewVideo, type Repositories,
} from './index'

const LATEST = MIGRATIONS.at(-1)!.version
/** AnalysisState fields added in schema version 2, as a fresh video has them. */
const FRESH = { mode: 'full', version: null, signals: null } as const

const media: MediaInfo = {
  durationSec: 12.5,
  width: 1280,
  height: 720,
  fps: 30,
  videoCodec: 'h264',
  container: 'matroska,webm',
  audioTracks: [
    { index: 0, codec: 'aac', channels: 2, language: null, title: 'mix' },
    { index: 1, codec: 'aac', channels: 1, language: 'eng', title: null },
  ],
}

const youtube: YoutubeMeta = {
  id: 'dQw4w9WgXcQ',
  channel: '測試頻道',
  durationSec: 10_800.5,
  liveStatus: 'was_live',
  uploadDate: '2026-10-01',
  chatAvailable: true,
  heatmapAvailable: false,
}

function newVideo(overrides: Partial<NewVideo> = {}): NewVideo {
  return {
    title: '測試影片',
    sourceKind: 'watch-folder',
    filePath: path.join(os.tmpdir(), 'rec', 'a.mkv'),
    youtubeUrl: null,
    youtube: null,
    language: 'zh',
    audioTrack: 1,
    media,
    ...overrides,
  }
}

function count(db: Db, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
}

let db: Db
let repos: Repositories

beforeEach(() => {
  db = openDatabase(':memory:')
  repos = createRepositories(db)
})

afterEach(() => {
  vi.useRealTimers()
  db.close()
})

/** Moves Date forward so timestamps differ deterministically. */
function at(iso: string) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(iso))
}

describe('openDatabase', () => {
  it('migrates an in-memory database and enables foreign keys', () => {
    expect(schemaVersion(db)).toBe(MIGRATIONS.at(-1)!.version)
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1)
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[])
      .map(r => r.name)
    expect(tables).toEqual(expect.arrayContaining(['clips', 'highlights', 'schema_version', 'settings', 'transcript_segments', 'videos']))
  })

  it('creates the parent folder, uses WAL, and does not re-run migrations on reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-db-'))
    try {
      const file = path.join(dir, 'nested', 'deeper', 'gg-highlight.db')
      const first = openDatabase(file)
      expect(fs.existsSync(file)).toBe(true)
      expect((first.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
      expect((first.prepare('PRAGMA busy_timeout').get() as Record<string, number>).timeout).toBe(5000)
      const video = createRepositories(first).videos.insert(newVideo())
      first.close()

      const second = openDatabase(file)
      expect(schemaVersion(second)).toBe(LATEST)
      expect(count(second, 'schema_version')).toBe(MIGRATIONS.length)
      expect(createRepositories(second).videos.get(video.id)?.title).toBe('測試影片')
      second.close()
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('applies appended migrations in order and only once', () => {
    const extra = [...MIGRATIONS, { version: LATEST + 1, sql: 'CREATE TABLE extra (id INTEGER PRIMARY KEY)' }]
    expect(migrate(db, extra)).toBe(LATEST + 1)
    expect(migrate(db, extra)).toBe(LATEST + 1)
    expect(count(db, 'schema_version')).toBe(MIGRATIONS.length + 1)
    expect(count(db, 'extra')).toBe(0)
  })

  it('rolls back a failing migration', () => {
    const broken = [...MIGRATIONS, { version: LATEST + 1, sql: 'CREATE TABLE half (id INTEGER); THIS IS NOT SQL' }]
    expect(() => migrate(db, broken)).toThrow()
    expect(schemaVersion(db)).toBe(LATEST)
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'half'`).get()).toBeUndefined()
  })
})

describe('migration 2 (milestone 2 analysis fields)', () => {
  /** A milestone 1 database (schema version 1) with a done video that has highlights and clips. */
  function milestone1Db(): Db {
    const old = new DatabaseSync(':memory:')
    old.exec('PRAGMA foreign_keys = ON')
    migrate(old, MIGRATIONS.filter(m => m.version === 1))
    const ts = '2026-01-01T00:00:00.000Z'
    old.exec(`
      INSERT INTO videos (id, title, source_kind, file_path, language, analysis_status, created_at)
        VALUES ('done', 'd', 'watch-folder', '/rec/d.mkv', 'zh', 'done', '${ts}'),
               ('failed', 'f', 'watch-folder', '/rec/f.mkv', 'en', 'failed', '${ts}'),
               ('queued', 'q', 'upload', '/up/q.mp4', 'en', 'queued', '${ts}');
      INSERT INTO transcript_segments VALUES ('done', 0, 0, 1, '改過', '原文');
      INSERT INTO highlights VALUES ('h1', 'done', 1, 5, 'selected', 'manual', NULL, NULL, '${ts}', '${ts}'),
                                    ('h2', 'done', 8, 9, 'candidate', 'analysis', 0.5, 'r', '${ts}', '${ts}');
      INSERT INTO clips (id, video_id, highlight_id, "start", "end", layout, burn_subtitles, status, created_at)
        VALUES ('c1', 'done', 'h1', 1, 5, 'original', 1, 'done', '${ts}');
    `)
    return old
  }

  it('adds mode, version and signals without touching highlights, clips or the transcript', () => {
    const old = milestone1Db()
    try {
      expect(migrate(old)).toBe(LATEST)
      const r = createRepositories(old)
      expect(r.videos.get('done')!.analysis).toMatchObject({ status: 'done', mode: 'full', version: 1, signals: null })
      expect(r.videos.get('failed')!.analysis).toMatchObject({ status: 'failed', mode: 'full', version: null, signals: null })
      expect(r.videos.get('queued')!.analysis).toMatchObject({ status: 'queued', mode: 'full', version: null })
      expect(r.highlights.listByVideo('done').map(h => h.id)).toEqual(['h1', 'h2'])
      expect(r.clips.get('c1')).toMatchObject({ highlightId: 'h1', status: 'done' })
      expect(r.transcript.list('done')).toEqual([{ idx: 0, start: 0, end: 1, text: '改過', edited: true }])
      // the CHECK constraint guards the mode
      expect(() => old.exec(`UPDATE videos SET analysis_mode = 'nope' WHERE id = 'done'`)).toThrow()
    }
    finally {
      old.close()
    }
  })
})

describe('migration 3 (milestone 3 YouTube metadata)', () => {
  /** A milestone 2 database (schema version 2) with a done video that has highlights, clips and signals. */
  function milestone2Db(): Db {
    const old = new DatabaseSync(':memory:')
    old.exec('PRAGMA foreign_keys = ON')
    migrate(old, MIGRATIONS.filter(m => m.version <= 2))
    const ts = '2026-01-01T00:00:00.000Z'
    const signals = JSON.stringify([{ kind: 'loudness', status: 'used', reason: null }])
    old.exec(`
      INSERT INTO videos (id, title, source_kind, file_path, language, analysis_status, analysis_version, analysis_signals_json, created_at)
        VALUES ('done', 'd', 'watch-folder', '/rec/d.mkv', 'zh', 'done', 2, '${signals}', '${ts}'),
               ('yt', 'y', 'youtube', NULL, 'zh', 'queued', NULL, NULL, '${ts}');
      UPDATE videos SET youtube_url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' WHERE id = 'yt';
      INSERT INTO transcript_segments VALUES ('done', 0, 0, 1, '改過', '原文');
      INSERT INTO highlights VALUES ('h1', 'done', 1, 5, 'selected', 'manual', NULL, NULL, '${ts}', '${ts}');
      INSERT INTO clips (id, video_id, highlight_id, "start", "end", layout, burn_subtitles, status, created_at)
        VALUES ('c1', 'done', 'h1', 1, 5, 'original', 1, 'done', '${ts}');
    `)
    return old
  }

  it('adds the YouTube columns (null for existing videos) without touching anything else', () => {
    const old = milestone2Db()
    try {
      expect(schemaVersion(old)).toBe(2)
      expect(migrate(old)).toBe(LATEST)
      const r = createRepositories(old)
      expect(r.videos.get('done')).toMatchObject({ youtube: null, youtubeUrl: null, filePath: '/rec/d.mkv' })
      expect(r.videos.get('done')!.analysis).toMatchObject({
        status: 'done', version: 2, signals: [{ kind: 'loudness', status: 'used', reason: null }],
      })
      expect(r.videos.get('yt')).toMatchObject({ youtube: null, youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })
      expect(r.videos.findByYoutubeId('dQw4w9WgXcQ')).toBeNull()
      expect(r.highlights.listByVideo('done').map(h => h.id)).toEqual(['h1'])
      expect(r.clips.get('c1')).toMatchObject({ highlightId: 'h1', status: 'done' })
      expect(r.transcript.list('done')).toEqual([{ idx: 0, start: 0, end: 1, text: '改過', edited: true }])

      // The migrated database works like a fresh one.
      expect(r.videos.update('yt', { youtube })).toMatchObject({ youtube })
      expect(r.videos.findByYoutubeId(youtube.id)?.id).toBe('yt')
      const index = old.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'videos_youtube_id'`).get()
      expect(index).toEqual({ name: 'videos_youtube_id' })
    }
    finally {
      old.close()
    }
  })
})

describe('videos', () => {
  it('inserts with queued analysis and round-trips every field', () => {
    at('2026-01-01T00:00:00.000Z')
    const video = repos.videos.insert(newVideo())
    expect(video.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(video).toMatchObject({
      title: '測試影片',
      sourceKind: 'watch-folder',
      youtubeUrl: null,
      language: 'zh',
      audioTrack: 1,
      media,
      previewPath: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      analysis: { status: 'queued', mode: 'full', version: null, signals: null, step: null, progress: 0, error: null, startedAt: null, finishedAt: null },
    })
    expect(repos.videos.get(video.id)).toEqual(video)
    expect(repos.videos.get('nope')).toBeNull()
  })

  it('stores null media and youtube fields', () => {
    const video = repos.videos.insert(newVideo({ sourceKind: 'youtube', filePath: null, youtubeUrl: 'https://youtu.be/x', media: null }))
    expect(video.media).toBeNull()
    expect(video.filePath).toBeNull()
    expect(video.youtubeUrl).toBe('https://youtu.be/x')
    expect(video.youtube).toBeNull()
    expect(repos.videos.insert(newVideo()).youtube).toBeNull()
  })

  it('round-trips YouTube metadata and finds videos by YouTube id', () => {
    const url = `https://www.youtube.com/watch?v=${youtube.id}`
    const video = repos.videos.insert(newVideo({ sourceKind: 'youtube', filePath: null, youtubeUrl: url, youtube, media: null }))
    expect(video).toMatchObject({ sourceKind: 'youtube', filePath: null, youtubeUrl: url, youtube, media: null })
    expect(repos.videos.get(video.id)).toEqual(video)
    const row = db.prepare('SELECT youtube_id FROM videos WHERE id = ?').get(video.id) as { youtube_id: string }
    expect(row.youtube_id).toBe(youtube.id)

    repos.videos.insert(newVideo())
    expect(repos.videos.findByYoutubeId(youtube.id)?.id).toBe(video.id)
    // YouTube ids are case-sensitive.
    expect(repos.videos.findByYoutubeId(youtube.id.toLowerCase())).toBeNull()
    expect(repos.videos.findByYoutubeId('aaaaaaaaaaa')).toBeNull()
  })

  it('finds the oldest video when the same YouTube id was stored twice', () => {
    at('2026-01-01T00:00:00.000Z')
    const first = repos.videos.insert(newVideo({ sourceKind: 'youtube', filePath: null, youtube }))
    at('2026-01-02T00:00:00.000Z')
    repos.videos.insert(newVideo({ sourceKind: 'youtube', filePath: null, youtube }))
    expect(repos.videos.findByYoutubeId(youtube.id)?.id).toBe(first.id)
  })

  it('updates YouTube metadata together with the id lookup', () => {
    const video = repos.videos.insert(newVideo({ sourceKind: 'youtube', filePath: null, youtube }))
    const refreshed: YoutubeMeta = { ...youtube, heatmapAvailable: true, durationSec: null, liveStatus: null, channel: null, uploadDate: null }
    expect(repos.videos.update(video.id, { youtube: refreshed, filePath: '/data/downloads/x.mp4' }))
      .toMatchObject({ youtube: refreshed, filePath: '/data/downloads/x.mp4' })
    // Leaving youtube out keeps it.
    expect(repos.videos.update(video.id, { title: '新標題' })?.youtube).toEqual(refreshed)

    const other: YoutubeMeta = { ...youtube, id: 'abcdefghijk' }
    repos.videos.update(video.id, { youtube: other })
    expect(repos.videos.findByYoutubeId(youtube.id)).toBeNull()
    expect(repos.videos.findByYoutubeId(other.id)?.youtube).toEqual(other)

    expect(repos.videos.update(video.id, { youtube: null })?.youtube).toBeNull()
    expect(repos.videos.findByYoutubeId(other.id)).toBeNull()
  })

  it('reads unreadable stored YouTube metadata as null', () => {
    const video = repos.videos.insert(newVideo({ sourceKind: 'youtube', filePath: null, youtube }))
    const bad = [
      '{oops',
      '[]',
      'null',
      JSON.stringify({ ...youtube, id: 'short' }),
      JSON.stringify({ ...youtube, liveStatus: 'live' }),
      JSON.stringify({ ...youtube, durationSec: '60' }),
      JSON.stringify({ ...youtube, chatAvailable: undefined }),
    ]
    for (const json of bad) {
      db.prepare('UPDATE videos SET youtube_json = ? WHERE id = ?').run(json, video.id)
      expect(repos.videos.get(video.id)!.youtube, json).toBeNull()
    }
    // Unknown keys are dropped.
    db.prepare('UPDATE videos SET youtube_json = ? WHERE id = ?').run(JSON.stringify({ ...youtube, extra: 1 }), video.id)
    expect(repos.videos.get(video.id)!.youtube).toEqual(youtube)
  })

  it('lists newest first, even within the same millisecond', () => {
    at('2026-01-01T00:00:00.000Z')
    const a = repos.videos.insert(newVideo({ title: 'a' }))
    const b = repos.videos.insert(newVideo({ title: 'b' }))
    at('2026-01-02T00:00:00.000Z')
    const c = repos.videos.insert(newVideo({ title: 'c' }))
    expect(repos.videos.list().map(v => v.id)).toEqual([c.id, b.id, a.id])
  })

  it('finds by file path', () => {
    const a = repos.videos.insert(newVideo({ filePath: '/rec/a.mkv' }))
    repos.videos.insert(newVideo({ filePath: '/rec/b.mkv' }))
    expect(repos.videos.findByFilePath('/rec/a.mkv')?.id).toBe(a.id)
    expect(repos.videos.findByFilePath('/rec/c.mkv')).toBeNull()
  })

  it('updates title, path, media and preview; null for unknown ids', () => {
    const video = repos.videos.insert(newVideo({ media: null }))
    const updated = repos.videos.update(video.id, { title: '新標題', media, previewPath: '/data/videos/x/preview.mp4' })
    expect(updated).toMatchObject({ title: '新標題', media, previewPath: '/data/videos/x/preview.mp4', filePath: video.filePath })
    expect(repos.videos.update(video.id, { previewPath: null, filePath: '/x.mp4' })).toMatchObject({ previewPath: null, filePath: '/x.mp4' })
    expect(repos.videos.update(video.id, {})?.title).toBe('新標題')
    expect(repos.videos.update('nope', { title: 'x' })).toBeNull()
  })

  it('records analysis timestamps on each status change', () => {
    at('2026-01-01T00:00:00.000Z')
    const video = repos.videos.insert(newVideo())

    at('2026-01-01T00:01:00.000Z')
    let v = repos.videos.updateAnalysis(video.id, { status: 'running', step: 'probe', progress: 0 })!
    expect(v.analysis).toEqual({ ...FRESH, status: 'running', step: 'probe', progress: 0, error: null, startedAt: '2026-01-01T00:01:00.000Z', finishedAt: null })

    // Progress ticks repeat status 'running' without moving startedAt.
    at('2026-01-01T00:02:00.000Z')
    v = repos.videos.updateAnalysis(video.id, { status: 'running', step: 'transcribe', progress: 0.5 })!
    expect(v.analysis).toMatchObject({ step: 'transcribe', progress: 0.5, startedAt: '2026-01-01T00:01:00.000Z' })

    at('2026-01-01T00:03:00.000Z')
    v = repos.videos.updateAnalysis(video.id, { status: 'failed', error: '轉錄失敗' })!
    expect(v.analysis).toEqual({
      ...FRESH, status: 'failed', step: 'transcribe', progress: 0.5, error: '轉錄失敗',
      startedAt: '2026-01-01T00:01:00.000Z', finishedAt: '2026-01-01T00:03:00.000Z',
    })

    at('2026-01-01T00:04:00.000Z')
    v = repos.videos.updateAnalysis(video.id, { status: 'queued' })!
    expect(v.analysis).toEqual({ ...FRESH, status: 'queued', step: null, progress: 0, error: null, startedAt: null, finishedAt: null })
    const queuedAt = (db.prepare('SELECT analysis_queued_at AS q FROM videos WHERE id = ?').get(video.id) as { q: string }).q
    expect(queuedAt).toBe('2026-01-01T00:04:00.000Z')

    at('2026-01-01T00:05:00.000Z')
    repos.videos.updateAnalysis(video.id, { status: 'running', step: 'probe' })
    at('2026-01-01T00:06:00.000Z')
    v = repos.videos.updateAnalysis(video.id, { status: 'done', step: 'prepare-preview' })!
    expect(v.analysis).toEqual({
      ...FRESH, status: 'done', step: 'prepare-preview', progress: 1, error: null,
      startedAt: '2026-01-01T00:05:00.000Z', finishedAt: '2026-01-01T00:06:00.000Z',
    })
  })

  it('stores mode, version and signals; a re-queue keeps them unless given', () => {
    const video = repos.videos.insert(newVideo())
    const signals: SignalState[] = [
      { kind: 'loudness', status: 'used', reason: null },
      { kind: 'transcript', status: 'missing', reason: '連不到 Ollama（http://127.0.0.1:11434），請確認 Ollama 已啟動' },
    ]
    let v = repos.videos.updateAnalysis(video.id, { status: 'done', version: 2, signals })!
    expect(v.analysis).toMatchObject({ status: 'done', mode: 'full', version: 2, signals })
    v = repos.videos.updateAnalysis(video.id, { status: 'queued', mode: 'highlights' })!
    expect(v.analysis).toMatchObject({ status: 'queued', mode: 'highlights', version: 2, signals })
    v = repos.videos.updateAnalysis(video.id, { status: 'failed', error: 'x' })!
    expect(v.analysis).toMatchObject({ mode: 'highlights', version: 2 })
    v = repos.videos.updateAnalysis(video.id, { status: 'queued' })!
    expect(v.analysis.mode).toBe('highlights')
    v = repos.videos.updateAnalysis(video.id, { signals: null, version: null, mode: 'full' })!
    expect(v.analysis).toMatchObject({ mode: 'full', version: null, signals: null })
  })

  it('reads unreadable stored signals as null', () => {
    const video = repos.videos.insert(newVideo())
    for (const json of ['not json', '{}', '[{"kind":"nope","status":"used","reason":null}]', '[{"kind":"loudness","status":"used"}]']) {
      db.prepare('UPDATE videos SET analysis_signals_json = ? WHERE id = ?').run(json, video.id)
      expect(repos.videos.get(video.id)!.analysis.signals, json).toBeNull()
    }
  })

  it('lets explicit fields win over the status defaults', () => {
    const video = repos.videos.insert(newVideo())
    const v = repos.videos.updateAnalysis(video.id, { status: 'done', progress: 0.9, finishedAt: '2020-01-01T00:00:00.000Z' })!
    expect(v.analysis).toMatchObject({ progress: 0.9, finishedAt: '2020-01-01T00:00:00.000Z' })
    expect(repos.videos.updateAnalysis('nope', { status: 'running' })).toBeNull()
  })

  it('hands out queued videos FIFO by queue time; re-queued videos go to the back', () => {
    at('2026-01-01T00:00:00.000Z')
    const a = repos.videos.insert(newVideo({ title: 'a' }))
    const b = repos.videos.insert(newVideo({ title: 'b' }))
    at('2026-01-01T00:00:01.000Z')
    const c = repos.videos.insert(newVideo({ title: 'c' }))

    expect(repos.videos.nextQueued()?.id).toBe(a.id)
    repos.videos.updateAnalysis(a.id, { status: 'running' })
    expect(repos.videos.nextQueued()?.id).toBe(b.id)
    repos.videos.updateAnalysis(a.id, { status: 'failed', error: 'x' })

    at('2026-01-01T00:00:02.000Z')
    repos.videos.updateAnalysis(a.id, { status: 'queued' })
    expect(repos.videos.listByAnalysisStatus('queued').map(v => v.id)).toEqual([b.id, c.id, a.id])
    repos.videos.updateAnalysis(b.id, { status: 'running' })
    repos.videos.updateAnalysis(c.id, { status: 'running' })
    expect(repos.videos.nextQueued()?.id).toBe(a.id)
    expect(repos.videos.listByAnalysisStatus('running').map(v => v.id)).toEqual([b.id, c.id])
    repos.videos.updateAnalysis(a.id, { status: 'done' })
    expect(repos.videos.nextQueued()).toBeNull()
    expect(repos.videos.listByAnalysisStatus('failed')).toEqual([])
  })

  it('cascades transcript, highlights and clips on delete', () => {
    const video = repos.videos.insert(newVideo())
    const other = repos.videos.insert(newVideo({ title: 'other' }))
    for (const v of [video, other]) {
      repos.transcript.replace(v.id, [{ start: 0, end: 1, text: '你好' }])
      const h = repos.highlights.insert({ videoId: v.id, start: 0, end: 5, status: 'selected', origin: 'manual', score: null, reason: null })
      repos.clips.insert({ videoId: v.id, highlightId: h.id, start: 0, end: 5, layout: 'original', burnSubtitles: true })
    }
    repos.videos.delete(video.id)
    expect(repos.videos.get(video.id)).toBeNull()
    expect(repos.transcript.list(video.id)).toEqual([])
    expect(repos.highlights.listByVideo(video.id)).toEqual([])
    expect(repos.clips.listByVideo(video.id)).toEqual([])
    expect(count(db, 'transcript_segments')).toBe(1)
    expect(count(db, 'highlights')).toBe(1)
    expect(count(db, 'clips')).toBe(1)
    repos.videos.delete('nope')
  })
})

describe('transcript', () => {
  it('replaces segments with idx in array order', () => {
    const video = repos.videos.insert(newVideo())
    repos.transcript.replace(video.id, [
      { start: 0, end: 1.5, text: '第一句' },
      { start: 1.5, end: 3.25, text: '第二句' },
    ])
    expect(repos.transcript.list(video.id)).toEqual([
      { idx: 0, start: 0, end: 1.5, text: '第一句', edited: false },
      { idx: 1, start: 1.5, end: 3.25, text: '第二句', edited: false },
    ])
    repos.transcript.replace(video.id, [{ start: 5, end: 6, text: 'only' }])
    expect(repos.transcript.list(video.id)).toEqual([{ idx: 0, start: 5, end: 6, text: 'only', edited: false }])
    repos.transcript.replace(video.id, [])
    expect(repos.transcript.list(video.id)).toEqual([])
  })

  it('keeps the old segments when a replace fails half-way', () => {
    const video = repos.videos.insert(newVideo())
    repos.transcript.replace(video.id, [{ start: 0, end: 1, text: '原本' }])
    const bad = [{ start: 0, end: 1, text: '新的' }, { start: 1, end: 2, text: null as unknown as string }]
    expect(() => repos.transcript.replace(video.id, bad)).toThrow()
    expect(repos.transcript.list(video.id)).toEqual([{ idx: 0, start: 0, end: 1, text: '原本', edited: false }])
  })

  it('rejects segments for unknown videos', () => {
    expect(() => repos.transcript.replace('nope', [{ start: 0, end: 1, text: 'x' }])).toThrow()
  })

  it('marks segments edited only while the text differs from the ASR text', () => {
    const video = repos.videos.insert(newVideo())
    repos.transcript.replace(video.id, [{ start: 0, end: 1, text: '原文' }, { start: 1, end: 2, text: '第二' }])
    expect(repos.transcript.updateText(video.id, 0, '改過')).toEqual({ idx: 0, start: 0, end: 1, text: '改過', edited: true })
    expect(repos.transcript.list(video.id)[0]).toMatchObject({ text: '改過', edited: true })
    expect(repos.transcript.list(video.id)[1]).toMatchObject({ text: '第二', edited: false })
    expect(repos.transcript.updateText(video.id, 0, '原文')?.edited).toBe(false)
    expect(repos.transcript.updateText(video.id, 9, 'x')).toBeNull()
    expect(repos.transcript.updateText('nope', 0, 'x')).toBeNull()
  })

  it('resets edits when the transcript is replaced', () => {
    const video = repos.videos.insert(newVideo())
    repos.transcript.replace(video.id, [{ start: 0, end: 1, text: 'a' }])
    repos.transcript.updateText(video.id, 0, 'b')
    repos.transcript.replace(video.id, [{ start: 0, end: 1, text: 'c' }])
    expect(repos.transcript.list(video.id)[0]).toMatchObject({ text: 'c', edited: false })
  })
})

describe('highlights', () => {
  it('inserts, gets and lists by start time', () => {
    at('2026-01-01T00:00:00.000Z')
    const video = repos.videos.insert(newVideo())
    const late = repos.highlights.insert({ videoId: video.id, start: 30, end: 45, status: 'candidate', origin: 'analysis', score: 0.8, reason: '大笑' })
    const early = repos.highlights.insert({ videoId: video.id, start: 2.5, end: 10, status: 'selected', origin: 'manual', score: null, reason: null })
    expect(late).toEqual({
      id: late.id, videoId: video.id, start: 30, end: 45, status: 'candidate', origin: 'analysis', score: 0.8, reason: '大笑',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(repos.highlights.get(early.id)).toEqual(early)
    expect(repos.highlights.get('nope')).toBeNull()
    expect(repos.highlights.listByVideo(video.id).map(h => h.id)).toEqual([early.id, late.id])
  })

  it('updates fields and updatedAt', () => {
    at('2026-01-01T00:00:00.000Z')
    const video = repos.videos.insert(newVideo())
    const h = repos.highlights.insert({ videoId: video.id, start: 0, end: 10, status: 'candidate', origin: 'analysis', score: 0.5, reason: 'r' })
    at('2026-01-01T01:00:00.000Z')
    const updated = repos.highlights.update(h.id, { start: 1, end: 9, status: 'dismissed', score: null, reason: null })
    expect(updated).toMatchObject({ start: 1, end: 9, status: 'dismissed', score: null, reason: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T01:00:00.000Z' })
    expect(repos.highlights.update('nope', { status: 'selected' })).toBeNull()
  })

  it('rejects highlights for unknown videos', () => {
    expect(() => repos.highlights.insert({ videoId: 'nope', start: 0, end: 1, status: 'selected', origin: 'manual', score: null, reason: null })).toThrow()
  })

  it('deletes by video, optionally only one origin, cascading their clips', () => {
    const video = repos.videos.insert(newVideo())
    const other = repos.videos.insert(newVideo())
    const manual = repos.highlights.insert({ videoId: video.id, start: 0, end: 1, status: 'selected', origin: 'manual', score: null, reason: null })
    const auto = repos.highlights.insert({ videoId: video.id, start: 2, end: 3, status: 'candidate', origin: 'analysis', score: 0.1, reason: 'x' })
    const otherAuto = repos.highlights.insert({ videoId: other.id, start: 2, end: 3, status: 'candidate', origin: 'analysis', score: 0.1, reason: 'x' })
    const clip = repos.clips.insert({ videoId: video.id, highlightId: auto.id, start: 2, end: 3, layout: 'original', burnSubtitles: false })

    repos.highlights.deleteByVideo(video.id, 'analysis')
    expect(repos.highlights.listByVideo(video.id).map(h => h.id)).toEqual([manual.id])
    expect(repos.highlights.get(otherAuto.id)).not.toBeNull()
    expect(repos.clips.get(clip.id)).toBeNull()

    repos.highlights.deleteByVideo(video.id)
    expect(repos.highlights.listByVideo(video.id)).toEqual([])
    expect(repos.highlights.listByVideo(other.id)).toHaveLength(1)
  })
})

describe('highlights kept by a new Analysis', () => {
  function add(videoId: string, start: number, end: number, status: HighlightStatus, origin: HighlightOrigin): Highlight {
    return repos.highlights.insert({
      videoId, start, end, status, origin, score: origin === 'analysis' ? 0.5 : null, reason: origin === 'analysis' ? '舊的理由' : null,
    })
  }

  function exportClip(h: Highlight) {
    return repos.clips.insert({ videoId: h.videoId, highlightId: h.id, start: h.start, end: h.end, layout: 'original', burnSubtitles: true })
  }

  it('isKeptOnReanalysis replaces only analysis candidates without clips', () => {
    expect(isKeptOnReanalysis({ origin: 'analysis', status: 'candidate' }, false)).toBe(false)
    expect(isKeptOnReanalysis({ origin: 'analysis', status: 'candidate' }, true)).toBe(true)
    for (const status of ['selected', 'dismissed'] as const) {
      expect(isKeptOnReanalysis({ origin: 'analysis', status }, false)).toBe(true)
    }
    for (const status of ['candidate', 'selected', 'dismissed'] as const) {
      expect(isKeptOnReanalysis({ origin: 'manual', status }, false)).toBe(true)
    }
  })

  it('listKept and replaceAnalysisCandidates apply the same rule as isKeptOnReanalysis', () => {
    const video = repos.videos.insert(newVideo())
    const all: Array<{ h: Highlight, clips: boolean }> = []
    let t = 0
    for (const origin of ['analysis', 'manual'] as const) {
      for (const status of ['candidate', 'selected', 'dismissed'] as const) {
        for (const clips of [false, true]) {
          const h = add(video.id, t, t + 5, status, origin)
          if (clips) exportClip(h)
          all.push({ h, clips })
          t += 10
        }
      }
    }
    const expected = all.filter(({ h, clips }) => isKeptOnReanalysis(h, clips)).map(({ h }) => h.id)
    expect(repos.highlights.listKept(video.id).map(h => h.id)).toEqual(expected)
    expect(expected).toHaveLength(all.length - 1)
    repos.highlights.replaceAnalysisCandidates(video.id, [])
    expect(repos.highlights.listByVideo(video.id).map(h => h.id)).toEqual(expected)
  })

  it('replaces old candidates, keeps decided / manual / exported ones and never overlaps them', () => {
    at('2026-01-01T00:00:00.000Z')
    const video = repos.videos.insert(newVideo())
    const other = repos.videos.insert(newVideo({ title: 'other' }))
    const oldCandidate = add(video.id, 0, 20, 'candidate', 'analysis')
    const selected = add(video.id, 30, 50, 'selected', 'analysis')
    const dismissed = add(video.id, 60, 80, 'dismissed', 'analysis')
    const manual = add(video.id, 90, 100, 'selected', 'manual')
    const exported = add(video.id, 110, 130, 'candidate', 'analysis')
    const clip = exportClip(exported)
    const otherCandidate = add(other.id, 0, 20, 'candidate', 'analysis')

    at('2026-01-02T00:00:00.000Z')
    const inserted = repos.highlights.replaceAnalysisCandidates(video.id, [
      { start: 140, end: 160, score: 0.9, reason: '後面' },
      { start: 2, end: 18, score: 0.8, reason: '大家笑成一團' },
      { start: 45, end: 58, score: 0.7, reason: '和選用的重疊' },
      { start: 79.5, end: 89, score: 0.6, reason: '和捨棄的重疊' },
      { start: 100, end: 110, score: 0.5, reason: '剛好接在兩段中間' },
      { start: 150, end: 170, score: 0.4, reason: '和新的候選重疊' },
      { start: 175, end: 175, score: 0.4, reason: '沒有長度' },
    ])
    expect(inserted.map(h => [h.start, h.end, h.score, h.reason])).toEqual([
      [2, 18, 0.8, '大家笑成一團'],
      [100, 110, 0.5, '剛好接在兩段中間'],
      [140, 160, 0.9, '後面'],
    ])
    expect(inserted.every(h => h.origin === 'analysis' && h.status === 'candidate' && h.createdAt === '2026-01-02T00:00:00.000Z')).toBe(true)
    const ids = repos.highlights.listByVideo(video.id).map(h => h.id)
    expect(ids).not.toContain(oldCandidate.id)
    expect(ids).toEqual(expect.arrayContaining([selected.id, dismissed.id, manual.id, exported.id, ...inserted.map(h => h.id)]))
    expect(ids).toHaveLength(7)
    expect(repos.clips.get(clip.id)).not.toBeNull()
    expect(repos.highlights.get(otherCandidate.id)).not.toBeNull()
  })

  it('leaves everything as it was when the insert fails half-way', () => {
    const video = repos.videos.insert(newVideo())
    const old = add(video.id, 0, 20, 'candidate', 'analysis')
    const bad = [{ start: 30, end: 40, score: 0.5, reason: 'ok' }, { start: 50, end: 60, score: 0.5, reason: null as unknown as string }]
    db.exec(`CREATE TRIGGER no_null_reason BEFORE INSERT ON highlights WHEN NEW.origin = 'analysis' AND NEW.reason IS NULL
      BEGIN SELECT RAISE(ABORT, 'reason required'); END`)
    expect(() => repos.highlights.replaceAnalysisCandidates(video.id, bad)).toThrow('reason required')
    expect(repos.highlights.listByVideo(video.id).map(h => h.id)).toEqual([old.id])
  })
})

describe('clips', () => {
  function setup() {
    const video = repos.videos.insert(newVideo())
    const highlight = repos.highlights.insert({ videoId: video.id, start: 0, end: 10, status: 'selected', origin: 'manual', score: null, reason: null })
    return { video, highlight }
  }

  it('inserts queued clips and lists newest first', () => {
    const { video, highlight } = setup()
    at('2026-01-01T00:00:00.000Z')
    const a = repos.clips.insert({ videoId: video.id, highlightId: highlight.id, start: 0, end: 10, layout: 'blurred-background', burnSubtitles: true })
    const b = repos.clips.insert({ videoId: video.id, highlightId: highlight.id, start: 1, end: 9, layout: 'center-crop', burnSubtitles: false })
    expect(a).toEqual({
      id: a.id, videoId: video.id, highlightId: highlight.id, start: 0, end: 10, layout: 'blurred-background', burnSubtitles: true,
      status: 'queued', progress: 0, error: null, fileName: null, srtFileName: null, createdAt: '2026-01-01T00:00:00.000Z', finishedAt: null,
    })
    expect(b.burnSubtitles).toBe(false)
    expect(repos.clips.get(a.id)).toEqual(a)
    expect(repos.clips.get('nope')).toBeNull()
    expect(repos.clips.listByVideo(video.id).map(c => c.id)).toEqual([b.id, a.id])
  })

  it('keeps the range snapshot when the highlight changes', () => {
    const { video, highlight } = setup()
    const clip = repos.clips.insert({ videoId: video.id, highlightId: highlight.id, start: 0, end: 10, layout: 'original', burnSubtitles: true })
    repos.highlights.update(highlight.id, { start: 3, end: 4 })
    expect(repos.clips.get(clip.id)).toMatchObject({ start: 0, end: 10 })
  })

  it('updates status, progress and files, stamping finishedAt', () => {
    const { video, highlight } = setup()
    const clip = repos.clips.insert({ videoId: video.id, highlightId: highlight.id, start: 0, end: 10, layout: 'original', burnSubtitles: true })
    expect(repos.clips.update(clip.id, { status: 'running', progress: 0.25 })).toMatchObject({ status: 'running', progress: 0.25, finishedAt: null })
    at('2026-01-01T00:00:00.000Z')
    const done = repos.clips.update(clip.id, { status: 'done', fileName: `${clip.id}.mp4`, srtFileName: `${clip.id}.srt` })!
    expect(done).toMatchObject({ status: 'done', progress: 1, fileName: `${clip.id}.mp4`, srtFileName: `${clip.id}.srt`, finishedAt: '2026-01-01T00:00:00.000Z' })
    const failed = repos.clips.update(clip.id, { status: 'failed', error: '輸出失敗', finishedAt: '2026-02-02T00:00:00.000Z' })!
    expect(failed).toMatchObject({ status: 'failed', error: '輸出失敗', finishedAt: '2026-02-02T00:00:00.000Z' })
    expect(repos.clips.update('nope', { status: 'done' })).toBeNull()
  })

  it('hands out queued clips FIFO and lists by status', () => {
    const { video, highlight } = setup()
    at('2026-01-01T00:00:00.000Z')
    const a = repos.clips.insert({ videoId: video.id, highlightId: highlight.id, start: 0, end: 10, layout: 'original', burnSubtitles: true })
    const b = repos.clips.insert({ videoId: video.id, highlightId: highlight.id, start: 0, end: 10, layout: 'original', burnSubtitles: true })
    at('2026-01-01T00:00:01.000Z')
    const c = repos.clips.insert({ videoId: video.id, highlightId: highlight.id, start: 0, end: 10, layout: 'original', burnSubtitles: true })
    expect(repos.clips.nextQueued()?.id).toBe(a.id)
    repos.clips.update(a.id, { status: 'running' })
    expect(repos.clips.nextQueued()?.id).toBe(b.id)
    expect(repos.clips.listByStatus('queued').map(x => x.id)).toEqual([b.id, c.id])
    expect(repos.clips.listByStatus('running').map(x => x.id)).toEqual([a.id])
    repos.clips.update(b.id, { status: 'done' })
    repos.clips.update(c.id, { status: 'failed' })
    expect(repos.clips.nextQueued()).toBeNull()
  })

  it('rejects clips for unknown highlights', () => {
    const { video } = setup()
    expect(() => repos.clips.insert({ videoId: video.id, highlightId: 'nope', start: 0, end: 1, layout: 'original', burnSubtitles: true })).toThrow()
  })
})

describe('toClip', () => {
  it('turns file names into hasFile/hasSrt flags', () => {
    const record: ClipRecord = {
      id: 'c', videoId: 'v', highlightId: 'h', start: 1, end: 2, layout: 'center-crop', burnSubtitles: true,
      status: 'done', progress: 1, error: null, fileName: 'c.mp4', srtFileName: null, createdAt: 't', finishedAt: 't',
    }
    const clip = toClip(record)
    expect(clip).toEqual({
      id: 'c', videoId: 'v', highlightId: 'h', start: 1, end: 2, layout: 'center-crop', burnSubtitles: true,
      status: 'done', progress: 1, error: null, hasFile: true, hasSrt: false, createdAt: 't', finishedAt: 't',
    })
    expect(clip).not.toHaveProperty('fileName')
    expect(toClip({ ...record, fileName: null, srtFileName: 'c.srt' })).toMatchObject({ hasFile: false, hasSrt: true })
  })
})

describe('settings', () => {
  it('defaults to no watch folders', () => {
    expect(repos.settings.get()).toEqual({ watchFolders: [] })
  })

  it('saves and overwrites', () => {
    expect(repos.settings.save({ watchFolders: ['D:\\錄影', '/home/me/videos'] })).toEqual({ watchFolders: ['D:\\錄影', '/home/me/videos'] })
    expect(repos.settings.get()).toEqual({ watchFolders: ['D:\\錄影', '/home/me/videos'] })
    repos.settings.save({ watchFolders: [] })
    expect(repos.settings.get()).toEqual({ watchFolders: [] })
    expect(count(db, 'settings')).toBe(1)
  })

  it('ignores malformed stored values', () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('watchFolders', 'not json')`).run()
    expect(repos.settings.get()).toEqual({ watchFolders: [] })
    db.prepare(`UPDATE settings SET value = '[1, "/ok"]' WHERE key = 'watchFolders'`).run()
    expect(repos.settings.get()).toEqual({ watchFolders: ['/ok'] })
  })
})
