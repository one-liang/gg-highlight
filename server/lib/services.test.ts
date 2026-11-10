import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config'
import { AnalysisQueue, ExportQueue } from './jobs'
import { createServices, databasePath, hasServices, resetServices } from './services'

let tmp: string

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gg-services-'))
})

afterEach(async () => {
  await resetServices()
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('services', () => {
  it('opens <dataDir>/gg-highlight.db and wires the queues to the config', async () => {
    const config = loadConfig({ GG_DATA_DIR: path.join(tmp, 'data'), GG_TRANSCRIBER_CMD: '["node","fake.mjs"]' }, tmp)
    const services = createServices(config, { log: () => {} })
    expect(databasePath(config)).toBe(path.join(tmp, 'data', 'gg-highlight.db'))
    expect(fs.existsSync(databasePath(config))).toBe(true)
    expect(services.analysis).toBeInstanceOf(AnalysisQueue)
    expect(services.exports).toBeInstanceOf(ExportQueue)
    expect(services.analysis.deps.transcriberCommand).toEqual(['node', 'fake.mjs'])
    expect(services.analysis.deps.config.ollama).toEqual(config.ollama)
    expect(services.tools).toEqual({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' })
    expect(services.repos.settings.get()).toEqual({ watchFolders: [] })

    await services.shutdown()
    // Closed: the database can no longer be used; a second shutdown is harmless.
    expect(() => services.repos.videos.list()).toThrow()
    await services.shutdown()
  })

  it('resetServices installs and shuts down the shared instance', async () => {
    const config = loadConfig({ GG_DATA_DIR: path.join(tmp, 'data') }, tmp)
    const first = createServices(config, { dbFile: ':memory:', log: () => {} })
    await resetServices(first)
    expect(hasServices()).toBe(true)
    first.analysis.start()
    await resetServices(null)
    expect(hasServices()).toBe(false)
    expect(() => first.repos.videos.list()).toThrow()
  })

  it('shutdown stops the queues even when a job ignores the abort for a while', async () => {
    const config = loadConfig({ GG_DATA_DIR: path.join(tmp, 'data') }, tmp)
    const services = createServices(config, { dbFile: ':memory:', log: () => {} })
    services.analysis.start()
    services.exports.start()
    const started = Date.now()
    await services.shutdown(200)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
