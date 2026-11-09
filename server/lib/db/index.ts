// SQLite (node:sqlite) storage for the Library. Repositories return domain objects.
//   types.ts         Db, records and the Repositories interface
//   schema.ts        openDatabase, versioned migrations, transaction helper
//   repositories.ts  createRepositories, toClip, isKeptOnReanalysis (which Highlights a new Analysis keeps)
export type { AnalysisCandidateDraft, ClipRecord, Db, NewHighlight, NewVideo, Repositories, VideoRecord } from './types'
export { MIGRATIONS, migrate, openDatabase, schemaVersion, transaction } from './schema'
export type { Migration } from './schema'
export { createRepositories, isKeptOnReanalysis, toClip } from './repositories'
