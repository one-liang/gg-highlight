import type { AppConfig } from '../config'
import type { Repositories } from '../db'
import type { MediaTools } from '../media'
import { createMetadataCache, type MetadataCache } from '../youtube/cache'
import { createYoutubeTools, ytdlpConfigFrom } from '../youtube/tools'
import type { YoutubeTools } from '../youtube/types'

/** Everything a job needs, injected so the queues can run against test doubles. */
export interface JobDeps {
  config: AppConfig
  repos: Repositories
  tools: MediaTools
  /** argv prefix of the transcriber CLI (normally config.transcriberCommand). */
  transcriberCommand: string[]
  /** Millisecond clock; only used to throttle progress writes. */
  now: () => number
  log: (message: string) => void
  /** Minimum time between two progress writes to the database. Default 250 ms. */
  progressIntervalMs?: number
  /** HTTP client for Ollama (config.ollama); tests may inject one. Defaults to globalThis.fetch. */
  fetch?: typeof fetch
  /** yt-dlp operations (default: config.ytdlpCommand); tests inject the fake yt-dlp. */
  youtube: YoutubeTools
  /** Metadata reads of the last 30 minutes, shared with the API routes (POST /api/youtube/probe). */
  metadataCache: MetadataCache
}

type Defaulted = 'transcriberCommand' | 'now' | 'log' | 'youtube' | 'metadataCache'

export type JobDepsInput = Omit<JobDeps, Defaulted> & Partial<Pick<JobDeps, Defaulted>>

export function resolveDeps(input: JobDepsInput): JobDeps {
  return {
    ...input,
    transcriberCommand: input.transcriberCommand ?? input.config.transcriberCommand,
    now: input.now ?? Date.now,
    log: input.log ?? (message => console.log(message)),
    youtube: input.youtube ?? createYoutubeTools(ytdlpConfigFrom(input.config)),
    metadataCache: input.metadataCache ?? createMetadataCache(),
  }
}

/** Common surface of the Analysis and Export queues. */
export interface JobQueue {
  /** Starts processing queued work (call recover() first after a restart). */
  start(): void
  /** Stops picking new work and aborts the running job, which stays as is for recover(). */
  stop(): Promise<void>
  /** Looks for queued work now (after something was queued). */
  kick(): void
  /** Aborts the running job of this video and drops its queued work. */
  cancel(videoId: string): Promise<void>
  /** Startup, before start(): work left 'running' by a previous process goes back to the queue. Returns the ids. */
  recover(): Promise<string[]>
  /** Resolves once nothing runs and nothing startable is queued. */
  whenIdle(): Promise<void>
}
