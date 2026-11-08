// The app's singletons (config, database, repositories, ffmpeg tools, queues) for API routes and plugins.
// Built lazily on first use, so importing this module (e.g. during `nuxt build`) opens nothing.
import path from 'node:path'
import { type AppConfig, getConfig } from './config'
import { createRepositories, type Db, openDatabase, type Repositories } from './db'
import { AnalysisQueue, ExportQueue } from './jobs'
import type { MediaTools } from './media'

export interface Services {
  config: AppConfig
  db: Db
  repos: Repositories
  tools: MediaTools
  analysis: AnalysisQueue
  exports: ExportQueue
  /** Stops both queues (aborting running jobs, which recover() picks up next time) and closes the database. */
  shutdown(timeoutMs?: number): Promise<void>
}

export interface CreateServicesOptions {
  /** Database file; defaults to <dataDir>/gg-highlight.db. ':memory:' for tests. */
  dbFile?: string
  transcriberCommand?: string[]
  log?: (message: string) => void
}

export function databasePath(config: AppConfig): string {
  return path.join(config.dataDir, 'gg-highlight.db')
}

export function createServices(config: AppConfig = getConfig(), opts: CreateServicesOptions = {}): Services {
  const db = openDatabase(opts.dbFile ?? databasePath(config))
  const repos = createRepositories(db)
  const tools: MediaTools = { ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath }
  const deps = {
    config,
    repos,
    tools,
    transcriberCommand: opts.transcriberCommand ?? config.transcriberCommand,
    log: opts.log ?? ((message: string) => console.log(message)),
  }
  const analysis = new AnalysisQueue(deps)
  const exports = new ExportQueue(deps)
  let closing: Promise<void> | null = null

  return {
    config,
    db,
    repos,
    tools,
    analysis,
    exports,
    shutdown(timeoutMs = 10_000) {
      closing ??= (async () => {
        let timer: NodeJS.Timeout | undefined
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs)
          timer.unref?.()
        })
        await Promise.race([Promise.all([analysis.stop(), exports.stop()]), timeout])
        clearTimeout(timer)
        try {
          db.close()
        }
        catch {
          // already closed
        }
      })()
      return closing
    },
  }
}

let current: Services | null = null

/** The shared Services, created on first call. */
export function useServices(): Services {
  current ??= createServices()
  return current
}

export function hasServices(): boolean {
  return current !== null
}

/** Tests: shuts down the current Services (if any) and installs `next` (or nothing). */
export async function resetServices(next: Services | null = null): Promise<void> {
  const previous = current
  current = next
  if (previous && previous !== next) await previous.shutdown()
}
