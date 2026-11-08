// Opening the database and versioned schema migrations.
// Append new migrations to MIGRATIONS; never edit one that has shipped.
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Db } from './types'

export interface Migration {
  version: number
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE videos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('watch-folder', 'upload', 'youtube')),
        file_path TEXT,
        youtube_url TEXT,
        language TEXT NOT NULL CHECK (language IN ('zh', 'en')),
        audio_track INTEGER NOT NULL DEFAULT 0,
        media_json TEXT,
        preview_path TEXT,
        analysis_status TEXT NOT NULL DEFAULT 'queued'
          CHECK (analysis_status IN ('queued', 'running', 'done', 'failed')),
        analysis_step TEXT,
        analysis_progress REAL NOT NULL DEFAULT 0,
        analysis_error TEXT,
        analysis_queued_at TEXT,
        analysis_started_at TEXT,
        analysis_finished_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX videos_created_at ON videos (created_at);
      CREATE INDEX videos_file_path ON videos (file_path);
      CREATE INDEX videos_analysis_queue ON videos (analysis_status, analysis_queued_at);

      CREATE TABLE transcript_segments (
        video_id TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        "start" REAL NOT NULL,
        "end" REAL NOT NULL,
        text TEXT NOT NULL,
        original_text TEXT NOT NULL,
        PRIMARY KEY (video_id, idx)
      );

      CREATE TABLE highlights (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
        "start" REAL NOT NULL,
        "end" REAL NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('candidate', 'selected', 'dismissed')),
        origin TEXT NOT NULL CHECK (origin IN ('analysis', 'manual')),
        score REAL,
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX highlights_video ON highlights (video_id, "start");

      CREATE TABLE clips (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
        highlight_id TEXT NOT NULL REFERENCES highlights (id) ON DELETE CASCADE,
        "start" REAL NOT NULL,
        "end" REAL NOT NULL,
        layout TEXT NOT NULL CHECK (layout IN ('blurred-background', 'center-crop', 'original')),
        burn_subtitles INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
        progress REAL NOT NULL DEFAULT 0,
        error TEXT,
        file_name TEXT,
        srt_file_name TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX clips_video ON clips (video_id, created_at);
      CREATE INDEX clips_highlight ON clips (highlight_id);
      CREATE INDEX clips_queue ON clips (status, created_at);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
]

let savepointSeq = 0

/** Runs fn inside a SAVEPOINT, so it nests safely inside an outer transaction. */
export function transaction<T>(db: Db, fn: () => T): T {
  const name = `sp_${++savepointSeq}`
  db.exec(`SAVEPOINT ${name}`)
  try {
    const result = fn()
    db.exec(`RELEASE ${name}`)
    return result
  }
  catch (err) {
    db.exec(`ROLLBACK TO ${name}`)
    db.exec(`RELEASE ${name}`)
    throw err
  }
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number | null } | undefined
  return row?.version ?? 0
}

/** Applies every migration newer than the stored version, each in its own transaction. */
export function migrate(db: Db, migrations: Migration[] = MIGRATIONS): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `)
  let current = schemaVersion(db)
  const pending = [...migrations].sort((a, b) => a.version - b.version).filter(m => m.version > current)
  for (const migration of pending) {
    transaction(db, () => {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
        .run(migration.version, new Date().toISOString())
    })
    current = migration.version
  }
  return current
}

/** Opens (creating folders and file as needed) and migrates the database. Use ':memory:' in tests. */
export function openDatabase(file: string): Db {
  const inMemory = file === ':memory:'
  if (!inMemory) fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  const db = new DatabaseSync(inMemory ? file : path.resolve(file))
  try {
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    if (!inMemory) db.exec('PRAGMA journal_mode = WAL')
    migrate(db)
  }
  catch (err) {
    db.close()
    throw err
  }
  return db
}
