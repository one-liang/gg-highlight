// Milestone 3 Analysis of YouTube videos with the fake yt-dlp (never the network): the download step,
// 'full' re-runs with and without the downloaded file, 'highlights' runs (metadata refresh, never the
// video file), the chat density and replay heatmap Signals, failures, cancel and recover.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AnalysisState, YoutubeMeta } from '../../../shared/types/domain'
import { canonicalYoutubeUrl } from '../../../shared/utils/youtube-url'
import { downloadsDir } from '../library'
import { readSignalsFile, writeSignalsFile } from '../signals'
import {
  CHAT_FAILED_PREFIX, chatFilePath, createMetadataCache, createYoutubeTools, parseMetadata, YTDLP_ERROR_CAUSES, YTDLP_ERROR_MESSAGES, YtdlpError,
  type MetadataCache, type YoutubeTools,
} from '../youtube'
import { FAKE_YTDLP_IDS, fakeMetadata, fakeYtdlpCommand, readArgsLogs } from '../youtube/test-helpers/fake-yt-dlp.mjs'
import { AnalysisQueue, analysisFiles } from './analysis'
import type { AnalysisRun } from './analysis-steps'
import {
  CHAT_TOO_FEW_REASON, CHAT_UNREADABLE_REASON, FLAT_HEATMAP_REASON, formatPerMinute, HEATMAP_FAILED_PREFIX, NO_CHAT_REASON,
  NO_HEATMAP_REASON, storedMetaOf, youtubeSignals, youtubeSourceOf, type YoutubeRunData,
} from './analysis-youtube'
import { CANCELLED_MESSAGE, MISSING_DOWNLOAD_MESSAGE } from './errors'
import { createJobTestEnv, fakeTranscriberCommand, type JobTestEnv, makeBurstVideo, processAlive, waitFor } from './test-helpers/setup'

/** The fake's -J duration and the media's length. */
const DURATION = 60
/** Heatmap burst after the first 30 s (inside them the Signal caps it: 沒有明顯起伏). */
const HEATMAP_PEAK = 36
const CHAT_USED = /^平均每分鐘 \d+(?:\.\d)? 則$/

let mediaDir: string
let media: string
let env: JobTestEnv
let logDir: string
const queues: AnalysisQueue[] = []
const logs: string[] = []

beforeAll(async () => {
  mediaDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gg-yt-media-'))
  media = makeBurstVideo(path.join(mediaDir, 'stream.mkv'), { durationSec: DURATION, burstAt: 24 })
})

afterAll(async () => {
  if (mediaDir) await fsp.rm(mediaDir, { recursive: true, force: true })
})

beforeEach(async () => {
  env = await createJobTestEnv()
  logDir = path.join(env.dataDir, 'ytdlp-logs')
  logs.length = 0
})

afterEach(async () => {
  await Promise.all(queues.splice(0).map(q => q.stop()))
  await env.cleanup()
})

function fakeTools(opts: { heatmapPeakSec?: number | null, slowMs?: number } = {}): YoutubeTools {
  const heatmapPeakSec = opts.heatmapPeakSec === null ? undefined : opts.heatmapPeakSec ?? HEATMAP_PEAK
  return createYoutubeTools({
    command: fakeYtdlpCommand({ media, logDir, durationSec: DURATION, heatmapPeakSec, slowMs: opts.slowMs }),
    ffmpegPath: env.config.ffmpegPath,
    nodePath: process.execPath,
    downloadsDir: downloadsDir(env.config),
    updateStampPath: null,
  })
}

function makeQueue(opts: { youtube?: YoutubeTools, metadataCache?: MetadataCache, transcriber?: string } = {}) {
  const queue = new AnalysisQueue({
    config: env.config,
    repos: env.repos,
    tools: env.tools,
    transcriberCommand: fakeTranscriberCommand(opts.transcriber ?? 'ok'),
    log: message => logs.push(message),
    progressIntervalMs: 0,
    youtube: opts.youtube ?? fakeTools(),
    // A new queue gets a new (empty) metadata cache unless one is shared.
    ...(opts.metadataCache ? { metadataCache: opts.metadataCache } : {}),
  })
  queues.push(queue)
  return queue
}

/** A YouTube video as POST /api/videos adds it: no file, no media, the metadata of the probe. */
function addYoutubeVideo(youtubeId: string = FAKE_YTDLP_IDS.vodChat, youtube: Partial<YoutubeMeta> = {}) {
  return env.repos.videos.insert({
    title: `YouTube ${youtubeId}`,
    sourceKind: 'youtube',
    filePath: null,
    youtubeUrl: canonicalYoutubeUrl(youtubeId),
    youtube: {
      id: youtubeId, channel: '測試頻道', durationSec: DURATION, liveStatus: 'was_live', uploadDate: '2026-11-01',
      chatAvailable: true, heatmapAvailable: true, ...youtube,
    },
    language: 'en',
    audioTrack: 0,
    media: null,
  })
}

function recordAnalysisWrites() {
  const writes: Array<{ id: string, patch: Partial<AnalysisState> }> = []
  const original = env.repos.videos.updateAnalysis.bind(env.repos.videos)
  env.repos.videos.updateAnalysis = (id, patch) => {
    writes.push({ id, patch: { ...patch } })
    return original(id, patch)
  }
  return writes
}

async function runToEnd(queue: AnalysisQueue) {
  queue.start()
  await queue.whenIdle()
}

async function rerun(queue: AnalysisQueue, videoId: string, mode: 'full' | 'highlights') {
  queue.enqueue(videoId, mode)
  await runToEnd(queue)
  return env.repos.videos.get(videoId)!
}

/** yt-dlp runs of this YouTube id so far, by kind. */
function ytdlpRuns(youtubeId: string = FAKE_YTDLP_IDS.vodChat) {
  return readArgsLogs(logDir, youtubeId).map(log => log.mode)
}

const statesOf = (videoId: string) => env.repos.videos.get(videoId)!.analysis.signals?.map(s => `${s.kind}:${s.status}`)
const stepsOf = (writes: ReturnType<typeof recordAnalysisWrites>, id: string) => [...new Set(writes.filter(w => w.id === id).map(w => w.patch.step).filter(Boolean))]
const chatFile = (videoId: string) => chatFilePath(downloadsDir(env.config), videoId)
const mine = (videoId: string) => logs.filter(l => l.startsWith(`[analysis ${videoId}]`)).join('\n')

describe('YouTube full Analysis: the download step', () => {
  it('first run: metadata, video file and chat replay are downloaded, then all six steps; chat and heatmap are used', async () => {
    const writes = recordAnalysisWrites()
    const video = addYoutubeVideo()
    await runToEnd(makeQueue())

    const done = env.repos.videos.get(video.id)!
    expect(done.analysis).toMatchObject({ status: 'done', mode: 'full', version: 2, step: null, progress: 1, error: null })
    expect(stepsOf(writes, video.id)).toEqual(['download', 'probe', 'extract-audio', 'transcribe', 'prepare-preview', 'signals', 'candidates'])
    // The weights of a run that downloads: download 20 %, so probe starts at 0.2.
    const ours = writes.filter(w => w.id === video.id)
    expect(ours).toContainEqual({ id: video.id, patch: { step: 'probe', progress: 0.2 } })
    const progress = ours.map(w => w.patch.progress).filter((p): p is number => typeof p === 'number')
    expect([...progress].sort((a, b) => a - b)).toEqual(progress)
    expect(progress.some(p => p > 0.006 && p < 0.176)).toBe(true) // inside the video file download

    // The file is <downloads>/<Source Video id>.<ext> and is now the video's file.
    expect(done.filePath).toBe(path.join(downloadsDir(env.config), `${video.id}.mkv`))
    expect(fs.existsSync(done.filePath!)).toBe(true)
    expect(done.media?.durationSec).toBeCloseTo(DURATION, 0)
    expect(fs.existsSync(chatFile(video.id))).toBe(true)
    expect(ytdlpRuns()).toEqual(['metadata', 'video', 'chat'])

    // Ollama is off in these tests.
    expect(done.analysis.signals).toEqual([
      { kind: 'loudness', status: 'used', reason: null },
      { kind: 'transcript', status: 'missing', reason: '已關閉 AI 讀逐字稿（GG_OLLAMA_URL=off）' },
      { kind: 'chat', status: 'used', reason: expect.stringMatching(CHAT_USED) },
      { kind: 'heatmap', status: 'used', reason: null },
    ])
    expect(env.repos.highlights.listByVideo(video.id).length).toBeGreaterThan(0)

    // The metadata read is stored with the video, the heatmap in signals.json (version 2).
    expect(done.youtube).toEqual(storedMetaOf(parseMetadata(fakeMetadata(FAKE_YTDLP_IDS.vodChat, DURATION, { heatmapPeakSec: HEATMAP_PEAK }))))
    const signals = await readSignalsFile(analysisFiles(env, video.id).signals)
    expect(signals?.version).toBe(2)
    expect(signals?.heatmap?.markers).toHaveLength(100)
    expect(Number.isNaN(Date.parse(signals!.heatmap!.fetchedAt))).toBe(false)
    expect(signals?.loudness?.db).toHaveLength(Math.ceil(done.media!.durationSec))

    const log = mine(video.id)
    expect(log).toContain('向 YouTube 讀取影片資訊')
    expect(log).toContain('下載影片檔（最高 1080p）')
    expect(log).toContain(`影片檔下載完成（${video.id}.mkv）`)
    expect(log).toContain('聊天室重播下載完成')
    expect(log).toMatch(/聊天室密度：算進 \d+ 則訊息，平均每小時 \d+ 則，採用/)
    expect(log).toContain('重播熱度：100 段，採用')
    expect(logs).toContainEqual(`[analysis ${video.id}] 找到 1 個候選精華片段（依據音量、聊天室、重播熱度）`)
  })

  it('uses the metadata the API read in the last 30 minutes instead of reading it again', async () => {
    const tools = fakeTools()
    const cache = createMetadataCache()
    cache.set(await tools.fetchMetadata(canonicalYoutubeUrl(FAKE_YTDLP_IDS.vodChat)))
    const video = addYoutubeVideo()
    await runToEnd(makeQueue({ youtube: tools, metadataCache: cache }))
    expect(env.repos.videos.get(video.id)!.analysis.status).toBe('done')
    // the probe's -J, then only the downloads
    expect(ytdlpRuns()).toEqual(['metadata', 'video', 'chat'])
    expect(mine(video.id)).toContain('沿用 30 分鐘內讀過的影片資訊')
  })

  it('a full re-run with the file on disk keeps it (no video download, light weights) but reads the metadata again', async () => {
    const video = addYoutubeVideo()
    await runToEnd(makeQueue())
    const first = env.repos.videos.get(video.id)!
    const mtime = fs.statSync(first.filePath!).mtimeMs
    await queues[0]!.stop()
    logs.length = 0

    const writes = recordAnalysisWrites()
    const done = await rerun(makeQueue(), video.id, 'full')
    expect(done.analysis).toMatchObject({ status: 'done', mode: 'full', error: null })
    expect(stepsOf(writes, video.id)[0]).toBe('download')
    expect(writes).toContainEqual({ id: video.id, patch: { step: 'probe', progress: 0.02 } })
    expect(done.filePath).toBe(first.filePath)
    expect(fs.statSync(done.filePath!).mtimeMs).toBe(mtime)
    // a new -J (the new queue's cache is empty); no video run, and the chat file is kept
    expect(ytdlpRuns()).toEqual(['metadata', 'video', 'chat', 'metadata'])
    expect(mine(video.id)).toContain(`沿用已下載的影片檔（${video.id}.mkv）`)
    expect(mine(video.id)).toContain('沿用已下載的聊天室重播')
    expect(statesOf(video.id)).toEqual(['loudness:used', 'transcript:missing', 'chat:used', 'heatmap:used'])
  })

  it('a full re-run after the downloaded file was deleted downloads it again', async () => {
    const video = addYoutubeVideo()
    await runToEnd(makeQueue())
    const first = env.repos.videos.get(video.id)!
    await queues[0]!.stop()
    await fsp.rm(first.filePath!)

    const writes = recordAnalysisWrites()
    const done = await rerun(makeQueue(), video.id, 'full')
    expect(done.analysis).toMatchObject({ status: 'done', error: null })
    expect(writes).toContainEqual({ id: video.id, patch: { step: 'probe', progress: 0.2 } })
    expect(fs.existsSync(done.filePath!)).toBe(true)
    expect(ytdlpRuns()).toEqual(['metadata', 'video', 'chat', 'metadata', 'video'])
  })

  it('with the file on disk, a failed metadata read is logged and the run goes on with the stored data and the last heatmap', async () => {
    const video = addYoutubeVideo()
    await runToEnd(makeQueue())
    await queues[0]!.stop()
    const tools = fakeTools()
    const blocked: YoutubeTools = {
      ...tools,
      fetchMetadata: async () => {
        throw new YtdlpError('blocked', YTDLP_ERROR_MESSAGES.blocked!)
      },
    }
    const done = await rerun(makeQueue({ youtube: blocked }), video.id, 'full')
    expect(done.analysis).toMatchObject({ status: 'done', error: null })
    expect(statesOf(video.id)).toEqual(['loudness:used', 'transcript:missing', 'chat:used', 'heatmap:used'])
    expect(mine(video.id)).toContain(`讀取影片資訊失敗，沿用已下載的影片檔與上次的資料：${YTDLP_ERROR_CAUSES.blocked}`)
    expect(mine(video.id)).toMatch(/這次讀不到影片資訊，沿用上次取得的重播熱度（/)
    // the carried heatmap stays in signals.json
    expect((await readSignalsFile(analysisFiles(env, video.id).signals))?.heatmap?.markers).toHaveLength(100)
  })

  it('a video without a chat replay: no chat download, the chat Signal is missing with the reason', async () => {
    const video = addYoutubeVideo(FAKE_YTDLP_IDS.noChat, { chatAvailable: false, liveStatus: 'not_live' })
    await runToEnd(makeQueue())
    const done = env.repos.videos.get(video.id)!
    expect(done.analysis.status).toBe('done')
    expect(done.analysis.signals?.slice(2)).toEqual([
      { kind: 'chat', status: 'missing', reason: NO_CHAT_REASON },
      { kind: 'heatmap', status: 'used', reason: null },
    ])
    expect(ytdlpRuns(FAKE_YTDLP_IDS.noChat)).toEqual(['metadata', 'video'])
    expect(fs.existsSync(chatFile(video.id))).toBe(false)
  })

  it('a video without a heatmap: the heatmap Signal is missing and signals.json keeps none', async () => {
    const video = addYoutubeVideo(FAKE_YTDLP_IDS.noHeatmap, { heatmapAvailable: false })
    await runToEnd(makeQueue())
    const done = env.repos.videos.get(video.id)!
    expect(done.analysis.signals?.slice(2)).toEqual([
      { kind: 'chat', status: 'used', reason: expect.stringMatching(CHAT_USED) },
      { kind: 'heatmap', status: 'missing', reason: NO_HEATMAP_REASON },
    ])
    expect((await readSignalsFile(analysisFiles(env, video.id).signals))?.heatmap).toBeNull()
  })

  it('a heatmap whose only rise is in the first 30 s is flat: missing 重播熱度沒有明顯起伏', async () => {
    const video = addYoutubeVideo()
    await runToEnd(makeQueue({ youtube: fakeTools({ heatmapPeakSec: null }) }))
    expect(env.repos.videos.get(video.id)!.analysis.signals?.[3]).toEqual({ kind: 'heatmap', status: 'missing', reason: FLAT_HEATMAP_REASON })
  })
})

describe('YouTube full Analysis: failures, cancel and recover', () => {
  it('a failed chat download only makes the chat Signal missing; the run finishes', async () => {
    const video = addYoutubeVideo(FAKE_YTDLP_IDS.chatFail)
    await runToEnd(makeQueue())
    const done = env.repos.videos.get(video.id)!
    expect(done.analysis).toMatchObject({ status: 'done', error: null })
    expect(done.analysis.signals?.slice(2)).toEqual([
      // The cause only: the finished Analysis has no 重試 button (the UI names 只重新找精華片段).
      { kind: 'chat', status: 'missing', reason: `${CHAT_FAILED_PREFIX}：YouTube 暫時拒絕這台電腦的連線（被當成機器人或請求太頻繁）` },
      { kind: 'heatmap', status: 'used', reason: null },
    ])
    expect(fs.existsSync(chatFile(video.id))).toBe(false)
    expect(mine(video.id)).toContain('（分析照常繼續，這次不用聊天室密度）')
  })

  it.each([
    ['still live', FAKE_YTDLP_IDS.liveNow, YTDLP_ERROR_MESSAGES.live],
    ['just ended', FAKE_YTDLP_IDS.postLive, YTDLP_ERROR_MESSAGES['post-live']],
    // yt-dlp reports a stream that has not started as an ERROR line (no formats), not as live_status.
    ['not started', FAKE_YTDLP_IDS.upcoming, YTDLP_ERROR_MESSAGES.live],
  ])('a live stream (%s) fails the download step with the live-status message, before any download', async (_name, youtubeId, message) => {
    const video = addYoutubeVideo(youtubeId)
    await runToEnd(makeQueue())
    const failed = env.repos.videos.get(video.id)!
    expect(failed.analysis).toMatchObject({ status: 'failed', step: 'download', error: message })
    expect(failed.filePath).toBeNull()
    expect(ytdlpRuns(youtubeId)).toEqual(['metadata'])
  })

  it('HTTP 403 while downloading: 下載影片失敗：YouTube 可能改版了…; the partial file stays for the retry', async () => {
    const video = addYoutubeVideo(FAKE_YTDLP_IDS.download403)
    await runToEnd(makeQueue())
    const failed = env.repos.videos.get(video.id)!
    expect(failed.analysis).toMatchObject({ status: 'failed', step: 'download', error: `下載影片失敗：${YTDLP_ERROR_MESSAGES.outdated}` })
    expect(failed.analysis.error).toMatch(/^下載影片失敗：YouTube 可能改版了/)
    expect(failed.filePath).toBeNull()
    expect(fs.readdirSync(downloadsDir(env.config))).toContain(`${video.id}.f137.mp4.part`)
  })

  it('retries used up while downloading (yt-dlp\'s "ERROR: \\r[download] Got error: …" line) are still read: 403 → 可能改版了', async () => {
    const video = addYoutubeVideo(FAKE_YTDLP_IDS.retryErrors)
    await runToEnd(makeQueue())
    expect(env.repos.videos.get(video.id)!.analysis).toMatchObject({ status: 'failed', step: 'download', error: `下載影片失敗：${YTDLP_ERROR_MESSAGES.outdated}` })
  })

  it('a metadata failure when the file must be downloaded fails the step with the yt-dlp message', async () => {
    const video = addYoutubeVideo(FAKE_YTDLP_IDS.private)
    await runToEnd(makeQueue())
    expect(env.repos.videos.get(video.id)!.analysis).toMatchObject({
      status: 'failed', step: 'download', error: `下載影片失敗：${YTDLP_ERROR_MESSAGES.private}`,
    })
  })

  it('cancel during the video download stops yt-dlp; the partial download stays', async () => {
    const video = addYoutubeVideo(FAKE_YTDLP_IDS.slowDownload)
    const queue = makeQueue({ youtube: fakeTools({ slowMs: 200 }) })
    queue.start()
    const part = path.join(downloadsDir(env.config), `${video.id}.mkv.part`)
    await waitFor(() => fs.existsSync(part) && env.repos.videos.get(video.id)!.analysis.step === 'download')
    const [run] = readArgsLogs(logDir, FAKE_YTDLP_IDS.slowDownload).filter(l => l.mode === 'video')
    await queue.cancel(video.id)
    expect(env.repos.videos.get(video.id)!.analysis).toMatchObject({ status: 'failed', step: 'download', error: CANCELLED_MESSAGE })
    await waitFor(() => !processAlive(run!.pid), 5000)
    expect(fs.existsSync(part)).toBe(true)
    expect(env.repos.videos.get(video.id)!.filePath).toBeNull()
  })

  it('recover() re-queues a run interrupted while downloading as full and leaves data/downloads alone', async () => {
    const video = addYoutubeVideo()
    env.repos.videos.updateAnalysis(video.id, { status: 'running', step: 'download', progress: 0.1 })
    const dir = downloadsDir(env.config)
    await fsp.mkdir(dir, { recursive: true })
    const leftovers = [`${video.id}.mkv.part`, `${video.id}.f137.mp4.part`, `${video.id}.live_chat.json.part`]
    for (const name of leftovers) await fsp.writeFile(path.join(dir, name), 'partial')

    const queue = makeQueue()
    expect(await queue.recover()).toEqual([video.id])
    expect(env.repos.videos.get(video.id)!.analysis).toMatchObject({ status: 'queued', mode: 'full' })
    expect(fs.readdirSync(dir).sort()).toEqual([...leftovers].sort())
  })
})

describe('YouTube highlights-only Analysis', () => {
  it('never downloads the video file; reads the metadata again for the heatmap and reuses the cached loudness', async () => {
    const cache = createMetadataCache()
    const video = addYoutubeVideo()
    await runToEnd(makeQueue({ metadataCache: cache }))
    await queues[0]!.stop()
    const first = env.repos.videos.get(video.id)!
    await fsp.rm(first.filePath!)
    logs.length = 0

    const writes = recordAnalysisWrites()
    // Even with a fresh cache entry, 'highlights' reads the metadata again.
    const done = await rerun(makeQueue({ metadataCache: cache }), video.id, 'highlights')
    expect(done.analysis).toMatchObject({ status: 'done', mode: 'highlights', error: null })
    expect(stepsOf(writes, video.id)).toEqual(['extract-audio', 'signals', 'candidates'])
    expect(ytdlpRuns()).toEqual(['metadata', 'video', 'chat', 'metadata'])
    expect(done.filePath).toBe(first.filePath)
    expect(fs.existsSync(first.filePath!)).toBe(false)
    expect(statesOf(video.id)).toEqual(['loudness:used', 'transcript:missing', 'chat:used', 'heatmap:used'])
    expect(mine(video.id)).toContain('沿用上次分析的音量資料，不重新擷取音訊')
    // the signals step starts with the YouTube data (0–10 % of it = 10–18.5 % overall)
    const progress = writes.filter(w => w.id === video.id).map(w => w.patch.progress).filter((p): p is number => typeof p === 'number')
    expect(progress.some(p => p > 0.1 && p < 0.185)).toBe(true)
  })

  it('downloads the chat replay again when its file is missing (after an earlier failure)', async () => {
    const video = addYoutubeVideo()
    await runToEnd(makeQueue())
    await queues[0]!.stop()
    await fsp.rm(chatFile(video.id))

    const done = await rerun(makeQueue(), video.id, 'highlights')
    expect(done.analysis.status).toBe('done')
    expect(ytdlpRuns()).toEqual(['metadata', 'video', 'chat', 'metadata', 'chat'])
    expect(fs.existsSync(chatFile(video.id))).toBe(true)
    expect(statesOf(video.id)?.[2]).toBe('chat:used')
  })

  it('a failed metadata read uses the last heatmap from signals.json; without one the heatmap is missing with the error', async () => {
    const video = addYoutubeVideo()
    await runToEnd(makeQueue())
    await queues[0]!.stop()
    const failing: YoutubeTools = {
      ...fakeTools(),
      fetchMetadata: async () => {
        throw new YtdlpError('timeout', YTDLP_ERROR_MESSAGES.timeout!)
      },
    }

    const carried = await rerun(makeQueue({ youtube: failing }), video.id, 'highlights')
    expect(carried.analysis.signals?.[3]).toEqual({ kind: 'heatmap', status: 'used', reason: null })
    expect(mine(video.id)).toContain(`無法重新讀取影片資訊，沿用上次的資料：${YTDLP_ERROR_CAUSES.timeout}`)

    const files = analysisFiles(env, video.id)
    const signals = (await readSignalsFile(files.signals))!
    await writeSignalsFile(files.signals, { ...signals, heatmap: null })
    const none = await rerun(makeQueue({ youtube: failing }), video.id, 'highlights')
    expect(none.analysis).toMatchObject({ status: 'done' })
    expect(none.analysis.signals?.[3]).toEqual({ kind: 'heatmap', status: 'missing', reason: `${HEATMAP_FAILED_PREFIX}向 YouTube 讀取影片資訊逾時` })
    // the chat replay on disk still counts
    expect(none.analysis.signals?.[2]).toMatchObject({ kind: 'chat', status: 'used' })
  })

  it('a milestone 2 signals.json (version 1) still gives the cached loudness; the new file is version 2 with the heatmap', async () => {
    const video = addYoutubeVideo()
    await runToEnd(makeQueue())
    await queues[0]!.stop()
    const files = analysisFiles(env, video.id)
    const signals = (await readSignalsFile(files.signals))!
    await fsp.writeFile(files.signals, JSON.stringify({ version: 1, loudness: signals.loudness, transcript: null }))
    await fsp.rm(env.repos.videos.get(video.id)!.filePath!)
    logs.length = 0

    const done = await rerun(makeQueue(), video.id, 'highlights')
    expect(done.analysis.signals?.[0]).toEqual({ kind: 'loudness', status: 'used', reason: null })
    expect(mine(video.id)).toContain('沿用上次分析的音量資料，不重新擷取音訊')
    const rewritten = await readSignalsFile(files.signals)
    expect(rewritten?.version).toBe(2)
    expect(rewritten?.loudness).toEqual(signals.loudness)
    expect(rewritten?.heatmap?.markers).toHaveLength(100)
    expect(JSON.parse(await fsp.readFile(files.signals, 'utf8')).version).toBe(2)
  })

  it('without the downloaded file and without cached loudness: loudness missing with 下載的影片檔不見了', async () => {
    const video = addYoutubeVideo()
    await runToEnd(makeQueue())
    await queues[0]!.stop()
    const files = analysisFiles(env, video.id)
    await fsp.rm(files.signals)
    await fsp.rm(env.repos.videos.get(video.id)!.filePath!)

    const done = await rerun(makeQueue(), video.id, 'highlights')
    expect(done.analysis.status).toBe('done')
    expect(done.analysis.signals?.[0]).toEqual({ kind: 'loudness', status: 'missing', reason: MISSING_DOWNLOAD_MESSAGE })
    expect(ytdlpRuns().filter(m => m === 'video')).toHaveLength(1)
  })
})

describe('youtubeSignals', () => {
  const durationSec = 600
  /** 100 buckets of 6 s, flat 0.2 with a rise to 1 at 300–330 s. */
  const markers = Array.from({ length: 100 }, (_, k) => ({ start: k * 6, end: (k + 1) * 6, value: k >= 50 && k < 55 ? 1 : 0.2 }))
  const meta = (heatmap: typeof markers | null, chatAvailable = true) => ({
    ...parseMetadata(fakeMetadata(FAKE_YTDLP_IDS.vodChat, durationSec)),
    heatmap,
    heatmapAvailable: heatmap !== null,
    chatAvailable,
    fetchedAt: '2026-11-10T00:00:00.000Z',
  })
  const previous = { markers, fetchedAt: '2026-11-01T00:00:00.000Z' }
  const runLogs: string[] = []
  const videoId = '00000000-0000-4000-8000-000000000001'
  const run = () => ({ deps: { config: env.config }, videoId, signal: new AbortController().signal, log: (m: string) => runLogs.push(m) }) as unknown as AnalysisRun
  const data = (read: YoutubeRunData['read'], extra: Partial<YoutubeRunData> = {}): YoutubeRunData => ({ read, chatAvailable: true, chatFailure: null, ...extra })

  async function writeChat(messagesPerMinute: number) {
    const file = chatFile(videoId)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const lines: string[] = []
    const total = Math.round(messagesPerMinute * durationSec / 60)
    for (let i = 0; i < total; i++) {
      const item = { liveChatTextMessageRenderer: { id: `m${i}`, authorExternalChannelId: `UC${i % 50}`, message: { runs: [{ text: '這關好難' }] } } }
      lines.push(JSON.stringify({ replayChatItemAction: { actions: [{ addChatItemAction: { item } }], videoOffsetTimeMsec: String(Math.round((i + 0.5) * durationSec * 1000 / total)) } }))
    }
    await fsp.writeFile(file, `${lines.join('\n')}\n`)
  }

  beforeEach(() => {
    runLogs.length = 0
  })

  it('heatmap: a read heatmap is used and saved; a flat one is missing but kept in signals.json', async () => {
    const used = await youtubeSignals(run(), data({ ok: true, meta: meta(markers) }), durationSec, null)
    expect(used.states[1]).toEqual({ kind: 'heatmap', status: 'used', reason: null })
    expect(used.heatmap?.values).toHaveLength(durationSec)
    expect(used.heatmap!.values[310]).toBeCloseTo(1)
    expect(used.heatmap!.values[100]).toBe(0)
    expect(used.heatmapFile).toEqual({ markers, fetchedAt: '2026-11-10T00:00:00.000Z' })

    const flatMarkers = markers.map(m => ({ ...m, value: 0.5 }))
    const flat = await youtubeSignals(run(), data({ ok: true, meta: meta(flatMarkers) }), durationSec, previous)
    expect(flat.states[1]).toEqual({ kind: 'heatmap', status: 'missing', reason: FLAT_HEATMAP_REASON })
    expect(flat.heatmap).toBeNull()
    expect(flat.heatmapFile?.markers).toEqual(flatMarkers)

    const invalid = await youtubeSignals(run(), data({ ok: true, meta: meta(markers.slice(0, 5)) }), durationSec, null)
    expect(invalid.states[1]).toEqual({ kind: 'heatmap', status: 'missing', reason: NO_HEATMAP_REASON })
  })

  it('heatmap: none in the read → the last one, else missing; a failed read without a last one names the error', async () => {
    const none = await youtubeSignals(run(), data({ ok: true, meta: meta(null) }), durationSec, null)
    expect(none.states[1]).toEqual({ kind: 'heatmap', status: 'missing', reason: NO_HEATMAP_REASON })
    expect(none.heatmapFile).toBeNull()

    const carried = await youtubeSignals(run(), data({ ok: true, meta: meta(null) }), durationSec, previous)
    expect(carried.states[1].status).toBe('used')
    expect(carried.heatmapFile).toBe(previous)
    expect(runLogs.join('\n')).toContain('這次的影片資訊沒有重播熱度，沿用上次取得的重播熱度（2026-11-01T00:00:00.000Z）')

    const failed = await youtubeSignals(run(), data({ ok: false, reason: '網路斷了' }), durationSec, null)
    expect(failed.states[1]).toEqual({ kind: 'heatmap', status: 'missing', reason: '無法取得重播熱度：網路斷了' })
  })

  it('chat: the missing reasons without a file', async () => {
    const read = { ok: true as const, meta: meta(markers) }
    expect((await youtubeSignals(run(), data(read, { chatAvailable: false }), durationSec, null)).states[0])
      .toEqual({ kind: 'chat', status: 'missing', reason: NO_CHAT_REASON })
    expect((await youtubeSignals(run(), data(read, { chatFailure: '聊天室重播下載失敗：x' }), durationSec, null)).states[0])
      .toEqual({ kind: 'chat', status: 'missing', reason: '聊天室重播下載失敗：x' })
    expect((await youtubeSignals(run(), data(read), durationSec, null)).states[0])
      .toEqual({ kind: 'chat', status: 'missing', reason: CHAT_UNREADABLE_REASON })
  })

  it('chat: fewer than 2 counted messages per minute is not used; enough is used with 平均每分鐘 N 則', async () => {
    const read = { ok: true as const, meta: meta(markers, false) }
    await writeChat(1.5)
    const few = await youtubeSignals(run(), data(read, { chatAvailable: false }), durationSec, null)
    expect(few.states[0]).toEqual({ kind: 'chat', status: 'missing', reason: CHAT_TOO_FEW_REASON })
    expect(few.chat).toBeNull()
    expect(runLogs.join('\n')).toContain('聊天室密度：算進 15 則訊息，平均每小時 90 則，少於 120 則，不採用')

    // an existing file counts even when this read does not list the chat
    await writeChat(3)
    const enough = await youtubeSignals(run(), data(read, { chatAvailable: false }), durationSec, null)
    expect(enough.states[0]).toEqual({ kind: 'chat', status: 'used', reason: '平均每分鐘 3 則' })
    expect(enough.chat).toHaveLength(durationSec)
  })

  it('formatPerMinute: one decimal below 10 per minute, whole numbers from 10', () => {
    expect(formatPerMinute(120)).toBe('2')
    expect(formatPerMinute(150)).toBe('2.5')
    expect(formatPerMinute(599)).toBe('10')
    expect(formatPerMinute(750)).toBe('13')
    expect(formatPerMinute(43_200)).toBe('720')
  })

  it('youtubeSourceOf: the stored id and canonical URL, the id parsed from the URL, or an error', () => {
    const youtube = { id: 'ggVodChat01', channel: null, durationSec: null, liveStatus: null, uploadDate: null, chatAvailable: false, heatmapAvailable: false }
    expect(youtubeSourceOf({ youtubeUrl: 'https://youtu.be/ggVodChat01?t=3', youtube }))
      .toEqual({ url: 'https://www.youtube.com/watch?v=ggVodChat01', youtubeId: 'ggVodChat01', stored: youtube })
    expect(youtubeSourceOf({ youtubeUrl: 'https://www.youtube.com/watch?v=ggNoChat001', youtube: null }))
      .toEqual({ url: 'https://www.youtube.com/watch?v=ggNoChat001', youtubeId: 'ggNoChat001', stored: null })
    expect(() => youtubeSourceOf({ youtubeUrl: null, youtube: null })).toThrow('這支影片沒有可用的 YouTube 連結')
  })
})
