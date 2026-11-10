// YouTube parts of the API: link parsing, metadata reads through the cache, error statuses, adding a video.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { H3Error } from 'h3'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { NOT_YOUTUBE_MESSAGE, PLAYLIST_OR_CHANNEL_MESSAGE } from '../../../shared/utils/youtube-url'
import { createRepositories, openDatabase, type Repositories } from '../db'
import { createMetadataCache, type MetadataCache } from '../youtube/cache'
import { YTDLP_ERROR_MESSAGES } from '../youtube/errors'
import { FAKE_YTDLP_IDS, fakeYtdlpCommand, readArgsLogs } from '../youtube/test-helpers/fake-yt-dlp.mjs'
import { createYoutubeTools } from '../youtube/tools'
import { type YoutubeMetadata, type YoutubeTools, YtdlpError } from '../youtube/types'
import {
  addYoutubeVideo, httpError, parseYoutubeLink, probeYoutube, readYoutubeMetadata, toYoutubeInfo, toYoutubeMeta,
  YOUTUBE_DUPLICATE_MESSAGE, YOUTUBE_METADATA_FAILED_MESSAGE, type YoutubeApiDeps, youtubeHttpError,
} from '.'

const ID = 'dQw4w9WgXcQ'
const WATCH_URL = `https://www.youtube.com/watch?v=${ID}`

function metadata(overrides: Partial<YoutubeMetadata> = {}): YoutubeMetadata {
  return {
    id: ID,
    url: WATCH_URL,
    title: '測試直播重播',
    channel: '測試頻道',
    durationSec: 3600,
    liveStatus: 'was_live',
    uploadDate: '2026-11-01',
    chatAvailable: true,
    heatmapAvailable: true,
    heatmap: [{ start: 0, end: 36, value: 1 }],
    languageHint: 'zh',
    fetchedAt: '2026-11-10T00:00:00.000Z',
    ...overrides,
  }
}

function statusOf(err: unknown): { statusCode: number, statusMessage: string } {
  const e = err as H3Error
  return { statusCode: e.statusCode, statusMessage: e.statusMessage ?? '' }
}

async function rejection(promise: Promise<unknown>): Promise<{ statusCode: number, statusMessage: string }> {
  try {
    await promise
  }
  catch (err) {
    return statusOf(err)
  }
  throw new Error('expected a rejection')
}

function thrown(fn: () => unknown): { statusCode: number, statusMessage: string } {
  try {
    fn()
  }
  catch (err) {
    return statusOf(err)
  }
  throw new Error('expected a throw')
}

/** YoutubeTools whose fetchMetadata answers from a queue of results; records the URLs asked. */
function stubTools(results: Array<YoutubeMetadata | Error | (() => YoutubeMetadata | Promise<YoutubeMetadata>)>) {
  const calls: string[] = []
  const tools: YoutubeTools = {
    async fetchMetadata(url) {
      calls.push(url)
      const next = results.shift()
      if (!next) throw new Error('unexpected fetchMetadata call')
      if (next instanceof Error) throw next
      return typeof next === 'function' ? next() : next
    },
    downloadVideo: () => Promise.reject(new Error('not in this test')),
    downloadChat: () => Promise.reject(new Error('not in this test')),
  }
  return { tools, calls }
}

let repos: Repositories
let cache: MetadataCache

beforeEach(() => {
  repos = createRepositories(openDatabase(':memory:'))
  cache = createMetadataCache()
})

function deps(tools: YoutubeTools, log?: (message: string) => void): YoutubeApiDeps {
  return { repos, youtube: tools, metadataCache: cache, log }
}

describe('parseYoutubeLink', () => {
  it('returns the id and the canonical link of a single video', () => {
    for (const input of [WATCH_URL, `https://youtu.be/${ID}?si=abc&t=30`, ` m.youtube.com/watch?v=${ID}&list=PL1 `, `https://www.youtube.com/live/${ID}`]) {
      expect(parseYoutubeLink(input), input).toEqual({ id: ID, url: WATCH_URL })
    }
  })

  it('400 for a link that is not a YouTube video, 422 for a playlist, channel or search', () => {
    for (const input of ['https://vimeo.com/123', 'hello', '', `https://www.youtube.com/watch?v=short`]) {
      expect(thrown(() => parseYoutubeLink(input)), input).toEqual({ statusCode: 400, statusMessage: NOT_YOUTUBE_MESSAGE })
    }
    for (const input of ['https://www.youtube.com/playlist?list=PL123', 'https://www.youtube.com/@someone', 'https://www.youtube.com/channel/UC123', 'https://www.youtube.com/results?search_query=x']) {
      expect(thrown(() => parseYoutubeLink(input)), input).toEqual({ statusCode: 422, statusMessage: PLAYLIST_OR_CHANNEL_MESSAGE })
    }
  })
})

describe('youtubeHttpError', () => {
  it('uses the YtdlpError status and text: 422 for the video, 502 for YouTube or the tool', () => {
    expect(statusOf(youtubeHttpError(new YtdlpError('private', YTDLP_ERROR_MESSAGES.private!)))).toEqual({ statusCode: 422, statusMessage: '這是私人影片，無法下載（自己的影片可以先在 YouTube Studio 改成「不公開」再加入）' })
    expect(statusOf(youtubeHttpError(new YtdlpError('post-live', YTDLP_ERROR_MESSAGES['post-live']!)))).toEqual({ statusCode: 422, statusMessage: YTDLP_ERROR_MESSAGES['post-live'] })
    expect(statusOf(youtubeHttpError(new YtdlpError('blocked', YTDLP_ERROR_MESSAGES.blocked!)))).toEqual({ statusCode: 502, statusMessage: YTDLP_ERROR_MESSAGES.blocked })
    expect(statusOf(youtubeHttpError(new YtdlpError('unknown', '下載失敗：ERROR: boom')))).toEqual({ statusCode: 502, statusMessage: '下載失敗：ERROR: boom' })
  })

  it('keeps HTTP errors and turns anything else into a generic 502, logging the details', () => {
    const http = httpError(400, '壞掉')
    expect(youtubeHttpError(http)).toBe(http)
    const logs: string[] = []
    expect(statusOf(youtubeHttpError(new TypeError('cannot read x'), m => logs.push(m)))).toEqual({ statusCode: 502, statusMessage: YOUTUBE_METADATA_FAILED_MESSAGE })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('cannot read x')
    expect(statusOf(youtubeHttpError('weird'))).toEqual({ statusCode: 502, statusMessage: YOUTUBE_METADATA_FAILED_MESSAGE })
  })
})

describe('toYoutubeMeta / toYoutubeInfo', () => {
  it('keeps only the Source Video fields', () => {
    expect(toYoutubeMeta(metadata())).toEqual({
      id: ID, channel: '測試頻道', durationSec: 3600, liveStatus: 'was_live', uploadDate: '2026-11-01', chatAvailable: true, heatmapAvailable: true,
    })
  })

  it('answers the probe fields, never the heatmap or the read time', () => {
    const info = toYoutubeInfo(metadata(), 'video-1')
    expect(info).toEqual({
      id: ID, url: WATCH_URL, title: '測試直播重播', channel: '測試頻道', durationSec: 3600, liveStatus: 'was_live', uploadDate: '2026-11-01',
      chatAvailable: true, heatmapAvailable: true, languageHint: 'zh', inLibraryVideoId: 'video-1',
    })
    expect(info).not.toHaveProperty('heatmap')
    expect(info).not.toHaveProperty('fetchedAt')
  })
})

describe('readYoutubeMetadata', () => {
  it('reads once, then answers from the cache', async () => {
    const { tools, calls } = stubTools([metadata()])
    const link = parseYoutubeLink(WATCH_URL)
    expect(await readYoutubeMetadata(deps(tools), link)).toEqual(metadata())
    expect(await readYoutubeMetadata(deps(tools), link)).toEqual(metadata())
    expect(calls).toEqual([WATCH_URL])
    expect(cache.get(ID)).toEqual(metadata())
  })

  it('checks a cached read\'s live status again', async () => {
    cache.set(metadata({ liveStatus: 'is_live' }))
    const { tools, calls } = stubTools([])
    expect(await rejection(readYoutubeMetadata(deps(tools), parseYoutubeLink(WATCH_URL)))).toEqual({ statusCode: 422, statusMessage: YTDLP_ERROR_MESSAGES.live })
    expect(calls).toEqual([])
  })

  it('maps a failed read and caches nothing', async () => {
    const { tools } = stubTools([new YtdlpError('blocked', YTDLP_ERROR_MESSAGES.blocked!), new Error('bug')])
    expect(await rejection(readYoutubeMetadata(deps(tools), parseYoutubeLink(WATCH_URL)))).toEqual({ statusCode: 502, statusMessage: YTDLP_ERROR_MESSAGES.blocked })
    expect(await rejection(readYoutubeMetadata(deps(tools, () => {}), parseYoutubeLink(WATCH_URL)))).toEqual({ statusCode: 502, statusMessage: YOUTUBE_METADATA_FAILED_MESSAGE })
    expect(cache.get(ID)).toBeNull()
  })
})

describe('probeYoutube and addYoutubeVideo', () => {
  it('probe: inLibraryVideoId is null until the video is added, then the Source Video id', async () => {
    const { tools, calls } = stubTools([metadata()])
    expect((await probeYoutube(deps(tools), `https://youtu.be/${ID}`)).inLibraryVideoId).toBeNull()
    const video = await addYoutubeVideo(deps(tools), { youtubeUrl: `https://youtu.be/${ID}?si=x`, language: 'en' })
    expect((await probeYoutube(deps(tools), WATCH_URL)).inLibraryVideoId).toBe(video.id)
    // probe, add and probe again: one read (the cache)
    expect(calls).toEqual([WATCH_URL])
  })

  it('probe: a video already in the Library is answered from the stored info, without yt-dlp', async () => {
    const first = stubTools([metadata()])
    const video = await addYoutubeVideo(deps(first.tools), { youtubeUrl: WATCH_URL, language: 'en' })
    // The 30-minute cache is gone (restart or expiry) and YouTube now refuses this PC / the video went private.
    cache = createMetadataCache()
    for (const failure of [new YtdlpError('blocked', YTDLP_ERROR_MESSAGES.blocked!), new YtdlpError('private', YTDLP_ERROR_MESSAGES.private!)]) {
      const { tools, calls } = stubTools([failure])
      expect(await probeYoutube(deps(tools), `https://youtu.be/${ID}?si=x`)).toEqual({
        ...toYoutubeMeta(metadata()),
        url: WATCH_URL,
        title: '測試直播重播',
        languageHint: null,
        inLibraryVideoId: video.id,
      })
      expect(calls).toEqual([])
    }
  })

  it('probe: 400 / 422 for bad links without running yt-dlp', async () => {
    const { tools, calls } = stubTools([])
    expect(await rejection(probeYoutube(deps(tools), 'https://example.com/watch?v=dQw4w9WgXcQ'))).toEqual({ statusCode: 400, statusMessage: NOT_YOUTUBE_MESSAGE })
    expect(await rejection(probeYoutube(deps(tools), 'https://www.youtube.com/playlist?list=PL1'))).toEqual({ statusCode: 422, statusMessage: PLAYLIST_OR_CHANNEL_MESSAGE })
    expect(calls).toEqual([])
  })

  it('add: a Source Video without file or MediaInfo, titled after YouTube, audio track 0, queued', async () => {
    const { tools } = stubTools([metadata()])
    const video = await addYoutubeVideo(deps(tools), { youtubeUrl: `https://www.youtube.com/shorts/${ID}`, language: 'zh' })
    expect(video).toMatchObject({
      title: '測試直播重播',
      sourceKind: 'youtube',
      filePath: null,
      youtubeUrl: WATCH_URL,
      youtube: toYoutubeMeta(metadata()),
      language: 'zh',
      audioTrack: 0,
      media: null,
      previewPath: null,
      analysis: { status: 'queued', mode: 'full' },
    })
    expect(repos.videos.findByYoutubeId(ID)?.id).toBe(video.id)
    expect(repos.videos.get(video.id)?.youtube).toEqual(toYoutubeMeta(metadata()))
  })

  it('add: 409 for a video already in the Library, checked before reading and again after', async () => {
    const first = stubTools([metadata()])
    await addYoutubeVideo(deps(first.tools), { youtubeUrl: WATCH_URL, language: 'zh' })
    const again = stubTools([])
    expect(await rejection(addYoutubeVideo(deps(again.tools), { youtubeUrl: `https://youtu.be/${ID}`, language: 'zh' }))).toEqual({ statusCode: 409, statusMessage: YOUTUBE_DUPLICATE_MESSAGE })
    expect(again.calls).toEqual([])

    // Added by another request while this one was reading the metadata.
    const other = 'abcdefghijk'
    const racing = stubTools([() => {
      repos.videos.insert({
        title: '先加入的', sourceKind: 'youtube', filePath: null, youtubeUrl: `https://www.youtube.com/watch?v=${other}`,
        youtube: toYoutubeMeta(metadata({ id: other })), language: 'zh', audioTrack: 0, media: null,
      })
      return metadata({ id: other, url: `https://www.youtube.com/watch?v=${other}` })
    }])
    expect(await rejection(addYoutubeVideo(deps(racing.tools), { youtubeUrl: `https://youtu.be/${other}`, language: 'zh' }))).toEqual({ statusCode: 409, statusMessage: YOUTUBE_DUPLICATE_MESSAGE })
    expect(repos.videos.list().filter(v => v.youtube?.id === other)).toHaveLength(1)
  })

  it('add: inserts nothing when the link or the read fails', async () => {
    const { tools } = stubTools([new YtdlpError('post-live', YTDLP_ERROR_MESSAGES['post-live']!)])
    expect(await rejection(addYoutubeVideo(deps(tools), { youtubeUrl: WATCH_URL, language: 'zh' }))).toEqual({ statusCode: 422, statusMessage: YTDLP_ERROR_MESSAGES['post-live'] })
    expect(await rejection(addYoutubeVideo(deps(tools), { youtubeUrl: 'https://www.youtube.com/@channel', language: 'zh' }))).toEqual({ statusCode: 422, statusMessage: PLAYLIST_OR_CHANNEL_MESSAGE })
    expect(await rejection(addYoutubeVideo(deps(tools), { youtubeUrl: 'not a link', language: 'zh' }))).toEqual({ statusCode: 400, statusMessage: NOT_YOUTUBE_MESSAGE })
    expect(repos.videos.list()).toEqual([])
  })
})

describe('with the fake yt-dlp', () => {
  let dir: string
  let logDir: string
  let tools: YoutubeTools

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-api-youtube-'))
    logDir = path.join(dir, 'logs')
    fs.mkdirSync(logDir)
    tools = createYoutubeTools({
      command: fakeYtdlpCommand({ logDir, durationSec: 120 }),
      ffmpegPath: 'ffmpeg',
      nodePath: process.execPath,
      downloadsDir: path.join(dir, 'downloads'),
      updateStampPath: null,
    })
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('probes a live replay with chat and heatmap, from a link with extra parameters', async () => {
    const id = FAKE_YTDLP_IDS.vodChat
    const info = await probeYoutube(deps(tools), `https://youtu.be/${id}?si=abc&t=42`)
    expect(info).toEqual({
      id, url: `https://www.youtube.com/watch?v=${id}`, title: `測試直播重播 ${id}`, channel: '測試頻道', durationSec: 120,
      liveStatus: 'was_live', uploadDate: '2026-11-01', chatAvailable: true, heatmapAvailable: true, languageHint: 'zh', inLibraryVideoId: null,
    })
    // yt-dlp got the canonical link
    expect(readArgsLogs(logDir, id).map(l => [l.mode, l.argv.at(-1)])).toEqual([['metadata', `https://www.youtube.com/watch?v=${id}`]])
    expect((await probeYoutube(deps(tools), `https://www.youtube.com/watch?v=${FAKE_YTDLP_IDS.noChat}`)).chatAvailable).toBe(false)
    expect((await probeYoutube(deps(tools), `https://www.youtube.com/watch?v=${FAKE_YTDLP_IDS.noHeatmap}`)).heatmapAvailable).toBe(false)
  })

  it('answers 422 for live, post-live and private videos and 502 for a bot check', async () => {
    const cases: Array<[string, number, string]> = [
      [FAKE_YTDLP_IDS.liveNow, 422, YTDLP_ERROR_MESSAGES.live!],
      [FAKE_YTDLP_IDS.postLive, 422, YTDLP_ERROR_MESSAGES['post-live']!],
      [FAKE_YTDLP_IDS.private, 422, YTDLP_ERROR_MESSAGES.private!],
      [FAKE_YTDLP_IDS.botCheck, 502, YTDLP_ERROR_MESSAGES.blocked!],
    ]
    for (const [id, statusCode, statusMessage] of cases) {
      expect(await rejection(probeYoutube(deps(tools, () => {}), `https://www.youtube.com/watch?v=${id}`)), id).toEqual({ statusCode, statusMessage })
      expect(cache.get(id), id).toBeNull()
    }
  })
})
