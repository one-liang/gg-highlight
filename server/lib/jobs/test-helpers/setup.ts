// Shared setup for the job tests: temp data folder, in-memory database, fake transcriber.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type AppConfig, loadConfig } from '../../config'
import { createRepositories, openDatabase, type Db, type Repositories } from '../../db'
import type { MediaTools } from '../../media'

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
export const FAKE_TRANSCRIBER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-transcriber.mjs')

const SYSTEM_NOTO = '/usr/share/fonts/opentype/noto'

/** A folder with a CJK font for libass: the repo fonts/ folder, else the system Noto folder. */
export function testFontsDir(): string {
  const repoFonts = path.join(ROOT_DIR, 'fonts')
  const hasFont = (dir: string) => {
    try {
      return fs.readdirSync(dir).some(name => /^NotoSansCJK.*\.(?:otf|ttc)$/i.test(name))
    }
    catch {
      return false
    }
  }
  if (hasFont(repoFonts)) return repoFonts
  if (hasFont(SYSTEM_NOTO)) return SYSTEM_NOTO
  return repoFonts
}

export function fakeTranscriberCommand(scenario = 'ok'): string[] {
  return [process.execPath, FAKE_TRANSCRIBER, `--scenario=${scenario}`]
}

export interface JobTestEnv {
  dataDir: string
  config: AppConfig
  db: Db
  repos: Repositories
  tools: MediaTools
  cleanup: () => Promise<void>
}

export async function createJobTestEnv(): Promise<JobTestEnv> {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gg-jobs-'))
  const config: AppConfig = {
    ...loadConfig({ GG_DATA_DIR: dataDir, GG_VIDEO_ENCODER: 'libx264', GG_ASR_DEVICE: 'cpu' }, ROOT_DIR),
    fontsDir: testFontsDir(),
    asrModels: { zh: 'test/zh-model', en: 'test/en-model' },
  }
  const db = openDatabase(':memory:')
  const repos = createRepositories(db)
  const tools: MediaTools = { ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath }
  return {
    dataDir,
    config,
    db,
    repos,
    tools,
    cleanup: async () => {
      try {
        db.close()
      }
      catch {
        // already closed
      }
      await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
}

/** Polls until `check` returns a truthy value. */
export async function waitFor<T>(check: () => T | Promise<T>, timeoutMs = 30_000, intervalMs = 25): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value as NonNullable<T>
    if (Date.now() > deadline) throw new Error('waitFor: timed out')
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}
