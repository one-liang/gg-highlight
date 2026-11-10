// Wiring of the yt-dlp tools: JobDeps defaults and the shared instances of the Services.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, ytdlpStampPath } from '../config'
import type { Repositories } from '../db'
import { resolveDeps } from '../jobs/types'
import { createServices } from '../services'
import { createMetadataCache } from './cache'
import { FAKE_YTDLP_IDS, fakeYtdlpCommand } from './test-helpers/fake-yt-dlp.mjs'
import { createYoutubeTools } from './tools'
import { YtdlpError, type YoutubeTools } from './types'

const watch = (id: string) => `https://www.youtube.com/watch?v=${id}`

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-ytdlp-tools-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('resolveDeps', () => {
  const base = () => ({
    config: loadConfig({ GG_DATA_DIR: path.join(dir, 'data'), GG_YTDLP_CMD: '["node","fake.mjs"]' }, dir),
    repos: {} as Repositories,
    tools: { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' },
  })

  it('defaults to yt-dlp tools from the config and a fresh metadata cache', () => {
    const deps = resolveDeps(base())
    expect(typeof deps.youtube.fetchMetadata).toBe('function')
    expect(typeof deps.youtube.downloadVideo).toBe('function')
    expect(typeof deps.youtube.downloadChat).toBe('function')
    expect(deps.metadataCache.get(FAKE_YTDLP_IDS.vodChat)).toBeNull()
    expect(resolveDeps(base()).metadataCache).not.toBe(deps.metadataCache)
  })

  it('keeps injected ones', () => {
    const youtube: YoutubeTools = createYoutubeTools({ command: ['x'], ffmpegPath: 'ffmpeg', nodePath: 'node', downloadsDir: dir, updateStampPath: null })
    const metadataCache = createMetadataCache()
    const deps = resolveDeps({ ...base(), youtube, metadataCache })
    expect(deps.youtube).toBe(youtube)
    expect(deps.metadataCache).toBe(metadataCache)
  })
})

describe('createServices', () => {
  it('shares one yt-dlp tools instance and one metadata cache with both queues', async () => {
    const config = loadConfig({ GG_DATA_DIR: path.join(dir, 'data') }, dir)
    const services = createServices(config, { dbFile: ':memory:', log: () => {} })
    try {
      expect(services.analysis.deps.youtube).toBe(services.youtube)
      expect(services.exports.deps.youtube).toBe(services.youtube)
      expect(services.analysis.deps.metadataCache).toBe(services.metadataCache)
      expect(services.exports.deps.metadataCache).toBe(services.metadataCache)
    }
    finally {
      await services.shutdown()
    }
  })

  it('ytdlpCommand replaces config.ytdlpCommand and never touches the update stamp', async () => {
    // A managed config (no GG_YTDLP_CMD): its stamp would be deleted by an 'unknown' error.
    const config = loadConfig({ GG_DATA_DIR: path.join(dir, 'data') }, dir)
    expect(config.ytdlpManaged).toBe(true)
    const stamp = ytdlpStampPath(config)
    fs.mkdirSync(path.dirname(stamp), { recursive: true })
    fs.writeFileSync(stamp, 'checked')

    const media = path.join(dir, 'media.mkv')
    fs.writeFileSync(media, crypto.randomBytes(4096))
    const logDir = path.join(dir, 'logs')
    const services = createServices(config, { dbFile: ':memory:', log: () => {}, ytdlpCommand: fakeYtdlpCommand({ media, logDir }) })
    try {
      const meta = await services.youtube.fetchMetadata(watch(FAKE_YTDLP_IDS.vodChat))
      expect(meta.title).toBe(`測試直播重播 ${FAKE_YTDLP_IDS.vodChat}`)
      const file = await services.youtube.downloadVideo({ url: meta.url, videoId: 'svc-1' })
      expect(file).toBe(path.join(config.dataDir, 'downloads', 'svc-1.mkv'))

      // The fake fails without its media file → 'unknown', which would suggest an update.
      const broken = createServices(config, { dbFile: ':memory:', log: () => {}, ytdlpCommand: fakeYtdlpCommand({ media: path.join(dir, 'missing.mkv'), logDir }) })
      try {
        const error = await broken.youtube.downloadVideo({ url: meta.url, videoId: 'svc-2' }).catch((err: unknown) => err)
        expect(error).toBeInstanceOf(YtdlpError)
        expect((error as YtdlpError).kind).toBe('unknown')
        expect(fs.existsSync(stamp)).toBe(true)
      }
      finally {
        await broken.shutdown()
      }
    }
    finally {
      await services.shutdown()
    }
  })
})
