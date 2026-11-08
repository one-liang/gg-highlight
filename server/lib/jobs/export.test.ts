import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fixtures, type Fixtures } from '../../../tests/fixtures'
import type { Layout, MediaInfo } from '../../../shared/types/domain'
import type { ClipRecord, VideoRecord } from '../db'
import { probeMedia } from '../media'
import { CANCELLED_MESSAGE, MISSING_SOURCE_MESSAGE } from './errors'
import { clipFiles, ExportQueue } from './export'
import { createJobTestEnv, type JobTestEnv, waitFor } from './test-helpers/setup'

let fx: Fixtures
let env: JobTestEnv
let sourceMedia: MediaInfo
const queues: ExportQueue[] = []

beforeAll(async () => {
  fx = fixtures()
  const tools = { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }
  sourceMedia = await probeMedia(tools, fx.sampleEnMkv)
})

beforeEach(async () => {
  env = await createJobTestEnv()
})

afterEach(async () => {
  await Promise.all(queues.splice(0).map(q => q.stop()))
  await env.cleanup()
})

function makeQueue() {
  const queue = new ExportQueue({ config: env.config, repos: env.repos, tools: env.tools, transcriberCommand: [], log: () => {} })
  queues.push(queue)
  return queue
}

/** An analysed video with a transcript, like after a finished Analysis. */
function addAnalysedVideo(filePath = fx.sampleEnMkv, media: MediaInfo | null = sourceMedia): VideoRecord {
  const video = env.repos.videos.insert({
    title: '測試影片',
    sourceKind: 'watch-folder',
    filePath,
    youtubeUrl: null,
    language: 'en',
    audioTrack: 1,
    media,
  })
  env.repos.videos.updateAnalysis(video.id, { status: 'running' })
  env.repos.videos.updateAnalysis(video.id, { status: 'done' })
  env.repos.transcript.replace(video.id, [
    { start: 0.3, end: 2.9, text: 'Hello everyone, welcome back to the stream.' },
    { start: 3.1, end: 6.2, text: 'Today we are going to play a brand new game.' },
    { start: 6.6, end: 9.6, text: '哇，剛剛那一槍太厲害了！' },
  ])
  return env.repos.videos.get(video.id)!
}

function addClip(video: VideoRecord, opts: { start?: number, end?: number, layout?: Layout, burnSubtitles?: boolean } = {}): ClipRecord {
  const start = opts.start ?? 2
  const end = opts.end ?? 3.5
  const highlight = env.repos.highlights.insert({ videoId: video.id, start, end, status: 'selected', origin: 'manual', score: null, reason: null })
  return env.repos.clips.insert({
    videoId: video.id,
    highlightId: highlight.id,
    start,
    end,
    layout: opts.layout ?? 'blurred-background',
    burnSubtitles: opts.burnSubtitles ?? true,
  })
}

async function runToEnd(queue: ExportQueue) {
  queue.start()
  await queue.whenIdle()
}

const CASES: Array<{ layout: Layout, burnSubtitles: boolean, width: number, height: number }> = [
  { layout: 'blurred-background', burnSubtitles: true, width: 1080, height: 1920 },
  { layout: 'blurred-background', burnSubtitles: false, width: 1080, height: 1920 },
  { layout: 'center-crop', burnSubtitles: true, width: 1080, height: 1920 },
  { layout: 'center-crop', burnSubtitles: false, width: 1080, height: 1920 },
  { layout: 'original', burnSubtitles: true, width: 1280, height: 720 },
  { layout: 'original', burnSubtitles: false, width: 1280, height: 720 },
]

describe('ExportQueue: layouts', () => {
  it.each(CASES)('exports $layout (subtitles: $burnSubtitles) to mp4 + srt', async ({ layout, burnSubtitles, width, height }) => {
    const video = addAnalysedVideo()
    const clip = addClip(video, { layout, burnSubtitles })
    await runToEnd(makeQueue())

    const done = env.repos.clips.get(clip.id)!
    expect(done).toMatchObject({ status: 'done', progress: 1, error: null, fileName: `${clip.id}.mp4`, srtFileName: `${clip.id}.srt` })
    expect(done.finishedAt).not.toBeNull()

    const files = clipFiles(env, clip)
    expect(files.dir).toBe(path.join(env.dataDir, 'clips', video.id))
    const out = await probeMedia(env.tools, files.mp4)
    expect(out.width).toBe(width)
    expect(out.height).toBe(height)
    expect(out.durationSec).toBeGreaterThan(1.3)
    expect(out.durationSec).toBeLessThan(1.8)
    expect(out.audioTracks).toHaveLength(1)
    expect(Math.round(out.fps)).toBe(30)

    const srt = await fsp.readFile(files.srt, 'utf8')
    // The clip starts at 2 s: the first cue is cut to 0–0.9 s, the second starts at 1.1 s.
    expect(srt).toContain('00:00:00,000 --> 00:00:00,900')
    expect(srt).toContain('welcome back to the stream.')
    expect(srt).toContain('00:00:01,100 --> 00:00:01,500')
    expect(fs.existsSync(files.ass)).toBe(burnSubtitles)
    if (burnSubtitles) {
      const ass = await fsp.readFile(files.ass, 'utf8')
      expect(ass).toContain(`PlayResX: ${width}`)
      expect(ass).toContain(`PlayResY: ${height}`)
      expect(ass).toContain('Noto Sans CJK TC')
    }
    // No temp files left behind.
    expect(fs.readdirSync(files.dir).filter(n => n.includes('.tmp-'))).toEqual([])
  })

  it('uses the latest transcript text (edits) and writes an empty SRT when nothing is said', async () => {
    const video = addAnalysedVideo()
    env.repos.transcript.updateText(video.id, 0, '大家好，歡迎回來')
    const clip = addClip(video, { start: 0, end: 1.5, layout: 'original', burnSubtitles: true })
    const silent = addClip(video, { start: 9.8, end: 10.6, layout: 'original', burnSubtitles: true })
    await runToEnd(makeQueue())
    expect(await fsp.readFile(clipFiles(env, clip).srt, 'utf8')).toContain('大家好，歡迎回來')
    expect(env.repos.clips.get(silent.id)!.status).toBe('done')
    expect((await fsp.readFile(clipFiles(env, silent).srt, 'utf8')).trim()).toBe('')
  })

  it('probes the source when the video has no stored media yet', async () => {
    const video = addAnalysedVideo(fx.sampleEnMp4, null)
    const clip = addClip(video, { layout: 'original', burnSubtitles: false })
    await runToEnd(makeQueue())
    expect(env.repos.clips.get(clip.id)!.status).toBe('done')
  })

  it('exports queued clips one at a time, oldest first', async () => {
    const video = addAnalysedVideo()
    const a = addClip(video, { layout: 'original', burnSubtitles: false })
    const b = addClip(video, { layout: 'original', burnSubtitles: false })
    const order: string[] = []
    const original = env.repos.clips.update.bind(env.repos.clips)
    let running = 0
    let maxRunning = 0
    env.repos.clips.update = (id, patch) => {
      if (patch.status === 'running') {
        order.push(id)
        running++
        maxRunning = Math.max(maxRunning, running)
      }
      if (patch.status === 'done' || patch.status === 'failed') running--
      return original(id, patch)
    }
    await runToEnd(makeQueue())
    expect(order).toEqual([a.id, b.id])
    expect(maxRunning).toBe(1)
  })
})

describe('ExportQueue: failures, cancel and recover', () => {
  it('fails with 找不到原始影片檔 when the source is gone, leaving no files', async () => {
    const copy = path.join(env.dataDir, 'copy.mkv')
    await fsp.copyFile(fx.sampleEnMkv, copy)
    const video = addAnalysedVideo(copy)
    const clip = addClip(video)
    await fsp.rm(copy)
    await runToEnd(makeQueue())
    const failed = env.repos.clips.get(clip.id)!
    expect(failed).toMatchObject({ status: 'failed', error: MISSING_SOURCE_MESSAGE, fileName: null, srtFileName: null })
    const files = clipFiles(env, clip)
    expect(fs.existsSync(files.srt)).toBe(false)
    expect(fs.existsSync(files.mp4)).toBe(false)
  })

  it('reports an ffmpeg failure readably and cleans up', async () => {
    const broken = path.join(env.dataDir, 'broken.mp4')
    await fsp.writeFile(broken, Buffer.alloc(4096, 7))
    const video = addAnalysedVideo(broken)
    const clip = addClip(video)
    await runToEnd(makeQueue())
    const failed = env.repos.clips.get(clip.id)!
    expect(failed.status).toBe('failed')
    expect(failed.error).toMatch(/ffmpeg/)
    expect(failed.error).not.toMatch(/\n\s+at /)
    const files = clipFiles(env, clip)
    expect(fs.existsSync(files.srt)).toBe(false)
    expect(fs.existsSync(files.ass)).toBe(false)
    expect(fs.readdirSync(files.dir)).toEqual([])
  })

  it('cancel(videoId) aborts the running export and drops that video\'s queued clips only', async () => {
    const video = addAnalysedVideo()
    const other = addAnalysedVideo(fx.sampleEnMp4)
    const running = addClip(video, { start: 0, end: 10.5, layout: 'blurred-background', burnSubtitles: true })
    const queued = addClip(video, { layout: 'original' })
    const otherClip = addClip(other, { layout: 'original', burnSubtitles: false })
    const queue = makeQueue()
    queue.start()
    await waitFor(() => queue.runningClipId === running.id)
    await queue.cancel(video.id)

    expect(env.repos.clips.get(running.id)).toMatchObject({ status: 'failed', error: CANCELLED_MESSAGE, fileName: null })
    expect(env.repos.clips.get(queued.id)).toMatchObject({ status: 'failed', error: CANCELLED_MESSAGE })
    expect(fs.existsSync(clipFiles(env, running).mp4)).toBe(false)
    await queue.whenIdle()
    expect(env.repos.clips.get(otherClip.id)!.status).toBe('done')
  })

  it('recover() puts clips left running back in the queue', async () => {
    const video = addAnalysedVideo()
    const clip = addClip(video, { layout: 'original', burnSubtitles: false })
    env.repos.clips.update(clip.id, { status: 'running', progress: 0.4 })
    const files = clipFiles(env, clip)
    await fsp.mkdir(files.dir, { recursive: true })
    await fsp.writeFile(path.join(files.dir, `${clip.id}.tmp-abcd1234.mp4`), 'x')

    const queue = makeQueue()
    expect(await queue.recover()).toEqual([clip.id])
    expect(env.repos.clips.get(clip.id)).toMatchObject({ status: 'queued', progress: 0 })
    expect(fs.existsSync(path.join(files.dir, `${clip.id}.tmp-abcd1234.mp4`))).toBe(false)
    await runToEnd(queue)
    expect(env.repos.clips.get(clip.id)!.status).toBe('done')
  })

  it('stop() leaves the running clip as running for the next start', async () => {
    const video = addAnalysedVideo()
    const clip = addClip(video, { start: 0, end: 10.5, layout: 'blurred-background' })
    const queue = makeQueue()
    queue.start()
    await waitFor(() => queue.runningClipId === clip.id)
    await queue.stop()
    expect(env.repos.clips.get(clip.id)!.status).toBe('running')
    expect(fs.existsSync(clipFiles(env, clip).mp4)).toBe(false)
  })
})
