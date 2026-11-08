// SQLite (node:sqlite) storage for the Library. Repositories return domain objects.
//   types.ts         Db, records and the Repositories interface
//   schema.ts        openDatabase, versioned migrations, transaction helper
//   repositories.ts  createRepositories, toClip
export type { ClipRecord, Db, NewHighlight, NewVideo, Repositories, VideoRecord } from './types'
export { MIGRATIONS, migrate, openDatabase, schemaVersion, transaction } from './schema'
export type { Migration } from './schema'
export { createRepositories, toClip } from './repositories'
