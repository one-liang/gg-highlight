import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaInfo } from '../../../shared/types/domain'
import {
  createRepositories, MIGRATIONS, migrate, openDatabase, schemaVersion, toClip,
  type ClipRecord, type Db, type NewVideo, type Repositories,
} from './index'

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

function newVideo(overrides: Partial<NewVideo> = {}): NewVideo {
  return {
    title: '測試影片',
    sourceKind: 'watch-folder',
    filePath: path.join(os.tmpdir(), 'rec', 'a.mkv'),
    youtubeUrl: null,
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
      expect(schemaVersion(second)).toBe(1)
      expect(count(second, 'schema_version')).toBe(1)
      expect(createRepositories(second).videos.get(video.id)?.title).toBe('測試影片')
      second.close()
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('applies appended migrations in order and only once', () => {
    const extra = [...MIGRATIONS, { version: 2, sql: 'CREATE TABLE extra (id INTEGER PRIMARY KEY)' }]
    expect(migrate(db, extra)).toBe(2)
    expect(migrate(db, extra)).toBe(2)
    expect(count(db, 'schema_version')).toBe(2)
    expect(count(db, 'extra')).toBe(0)
  })

  it('rolls back a failing migration', () => {
    const broken = [...MIGRATIONS, { version: 2, sql: 'CREATE TABLE half (id INTEGER); THIS IS NOT SQL' }]
    expect(() => migrate(db, broken)).toThrow()
    expect(schemaVersion(db)).toBe(1)
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'half'`).get()).toBeUndefined()
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
      analysis: { status: 'queued', step: null, progress: 0, error: null, startedAt: null, finishedAt: null },
    })
    expect(repos.videos.get(video.id)).toEqual(video)
    expect(repos.videos.get('nope')).toBeNull()
  })

  it('stores null media and youtube fields', () => {
    const video = repos.videos.insert(newVideo({ sourceKind: 'youtube', filePath: null, youtubeUrl: 'https://youtu.be/x', media: null }))
    expect(video.media).toBeNull()
    expect(video.filePath).toBeNull()
    expect(video.youtubeUrl).toBe('https://youtu.be/x')
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
    expect(v.analysis).toEqual({ status: 'running', step: 'probe', progress: 0, error: null, startedAt: '2026-01-01T00:01:00.000Z', finishedAt: null })

    // Progress ticks repeat status 'running' without moving startedAt.
    at('2026-01-01T00:02:00.000Z')
    v = repos.videos.updateAnalysis(video.id, { status: 'running', step: 'transcribe', progress: 0.5 })!
    expect(v.analysis).toMatchObject({ step: 'transcribe', progress: 0.5, startedAt: '2026-01-01T00:01:00.000Z' })

    at('2026-01-01T00:03:00.000Z')
    v = repos.videos.updateAnalysis(video.id, { status: 'failed', error: '轉錄失敗' })!
    expect(v.analysis).toEqual({
      status: 'failed', step: 'transcribe', progress: 0.5, error: '轉錄失敗',
      startedAt: '2026-01-01T00:01:00.000Z', finishedAt: '2026-01-01T00:03:00.000Z',
    })

    at('2026-01-01T00:04:00.000Z')
    v = repos.videos.updateAnalysis(video.id, { status: 'queued' })!
    expect(v.analysis).toEqual({ status: 'queued', step: null, progress: 0, error: null, startedAt: null, finishedAt: null })
    const queuedAt = (db.prepare('SELECT analysis_queued_at AS q FROM videos WHERE id = ?').get(video.id) as { q: string }).q
    expect(queuedAt).toBe('2026-01-01T00:04:00.000Z')

    at('2026-01-01T00:05:00.000Z')
    repos.videos.updateAnalysis(video.id, { status: 'running', step: 'probe' })
    at('2026-01-01T00:06:00.000Z')
    v = repos.videos.updateAnalysis(video.id, { status: 'done', step: 'prepare-preview' })!
    expect(v.analysis).toEqual({
      status: 'done', step: 'prepare-preview', progress: 1, error: null,
      startedAt: '2026-01-01T00:05:00.000Z', finishedAt: '2026-01-01T00:06:00.000Z',
    })
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
