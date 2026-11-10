import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fixtures, type Fixtures } from '../../../tests/fixtures'
import type { AnalysisState, Language } from '../../../shared/types/domain'
import type { NewVideo } from '../db'
import { probeMedia } from '../media'
import { CAN_FAKE_FFMPEG, fakeFfmpegCalls, writeFailingNvencFfmpeg } from '../media/test-utils'
import { AnalysisQueue, analysisFiles, checkAudioTrack } from './analysis'
import { CANCELLED_MESSAGE, MISSING_SOURCE_MESSAGE } from './errors'
import { createJobTestEnv, fakeTranscriberCommand, type JobTestEnv, processAlive, waitFor } from './test-helpers/setup'

let fx: Fixtures
let env: JobTestEnv
const queues: AnalysisQueue[] = []
const logs: string[] = []

beforeAll(() => {
  fx = fixtures()
})

beforeEach(async () => {
  env = await createJobTestEnv()
  logs.length = 0
})

afterEach(async () => {
  await Promise.all(queues.splice(0).map(q => q.stop()))
  await env.cleanup()
})

function makeQueue(scenario = 'ok', extra: { progressIntervalMs?: number } = {}) {
  const queue = new AnalysisQueue({
    config: env.config,
    repos: env.repos,
    tools: env.tools,
    transcriberCommand: fakeTranscriberCommand(scenario),
    log: message => logs.push(message),
    ...extra,
  })
  queues.push(queue)
  return queue
}

function addVideo(filePath: string, opts: { audioTrack?: number, language?: Language } = {}) {
  const video: NewVideo = {
    title: path.parse(filePath).name,
    sourceKind: 'watch-folder',
    filePath,
    youtubeUrl: null,
    youtube: null,
    language: opts.language ?? 'en',
    audioTrack: opts.audioTrack ?? 0,
    media: null,
  }
  return env.repos.videos.insert(video)
}

/** Records every analysis write so tests can check order and progress. */
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

describe('AnalysisQueue: happy path', () => {
  it('runs probe → extract-audio → transcribe → prepare-preview → signals → candidates and stores the results (mkv → remuxed preview)', async () => {
    const writes = recordAnalysisWrites()
    const video = addVideo(fx.sampleEnMkv, { audioTrack: 1, language: 'en' })
    const queue = makeQueue('ok', { progressIntervalMs: 0 })
    await runToEnd(queue)

    const done = env.repos.videos.get(video.id)!
    expect(done.analysis).toMatchObject({ status: 'done', step: null, progress: 1, error: null })
    expect(done.analysis.startedAt).not.toBeNull()
    expect(done.analysis.finishedAt).not.toBeNull()
    expect(done.media?.audioTracks).toHaveLength(2)
    expect(done.media?.width).toBe(1280)

    const segments = env.repos.transcript.list(video.id)
    expect(segments.length).toBeGreaterThanOrEqual(3)
    expect(segments.map(s => s.text).join(' ')).toMatch(/welcome back to the stream/)
    expect(segments.every(s => s.end > s.start && !s.edited)).toBe(true)
    expect(segments.map(s => s.idx)).toEqual(segments.map((_, i) => i))

    const files = analysisFiles(env, video.id)
    expect(done.previewPath).toBe(files.preview)
    const preview = await probeMedia(env.tools, files.preview)
    expect(preview.container).toContain('mp4')
    expect(preview.audioTracks).toHaveLength(1)
    expect(fs.existsSync(files.audio)).toBe(false)
    expect(fs.existsSync(files.rawTranscript)).toBe(true)

    const args = JSON.parse(await fsp.readFile(`${files.rawTranscript}.args.json`, 'utf8')) as { argv: string[], audioExists: boolean }
    expect(args.audioExists).toBe(true)
    const argv = args.argv.join(' ')
    expect(argv).toContain(`--model ${env.config.asrModels.en}`)
    expect(argv).toContain('--device cpu')
    expect(argv).toContain('--language en')
    expect(argv).toContain(`--audio ${files.audio}`)

    const mine = writes.filter(w => w.id === video.id)
    const steps = [...new Set(mine.map(w => w.patch.step).filter(s => s))]
    expect(steps).toEqual(['probe', 'extract-audio', 'transcribe', 'prepare-preview', 'signals', 'candidates'])
    const progress = mine.map(w => w.patch.progress).filter((p): p is number => typeof p === 'number')
    expect([...progress].sort((a, b) => a - b)).toEqual(progress)
    // Inside transcribe (7 %–67 %) the fake reports 0.1…1.0.
    expect(progress.some(p => p > 0.07 && p < 0.67)).toBe(true)
    // Ollama is off in these tests: loudness only, never a real Ollama.
    expect(done.analysis).toMatchObject({ mode: 'full', version: 2 })
    expect(done.analysis.signals?.map(s => `${s.kind}:${s.status}`)).toEqual(['loudness:used', 'transcript:missing'])
    expect(logs.join('\n')).toContain('使用 CPU 執行語音辨識')
  })

  it('keeps a browser-playable mp4 as is (no preview file) and removes a stale one', async () => {
    const video = addVideo(fx.sampleEnMp4)
    const files = analysisFiles(env, video.id)
    await fsp.mkdir(files.dir, { recursive: true })
    await fsp.writeFile(files.preview, 'stale')
    await runToEnd(makeQueue())
    const done = env.repos.videos.get(video.id)!
    expect(done.analysis.status).toBe('done')
    expect(done.previewPath).toBeNull()
    expect(fs.existsSync(files.preview)).toBe(false)
  })

  it('converts a Chinese transcript to Taiwan Traditional and uses the zh model', async () => {
    const video = addVideo(fx.sampleZhMkv, { language: 'zh', audioTrack: 1 })
    await runToEnd(makeQueue())
    const done = env.repos.videos.get(video.id)!
    expect(done.analysis.status).toBe('done')
    const text = env.repos.transcript.list(video.id).map(s => s.text).join('')
    expect(text).toContain('歡迎回到直播')
    expect(text).toContain('軟體')
    expect(text).not.toContain('欢迎')
    const args = await fsp.readFile(`${analysisFiles(env, video.id).rawTranscript}.args.json`, 'utf8')
    expect(args).toContain(env.config.asrModels.zh)
  })

  it('processes queued videos one at a time, oldest first', async () => {
    const writes = recordAnalysisWrites()
    const a = addVideo(fx.sampleEnMp4)
    const b = addVideo(fx.verticalMp4)
    await runToEnd(makeQueue())
    expect(env.repos.videos.get(a.id)!.analysis.status).toBe('done')
    expect(env.repos.videos.get(b.id)!.analysis.status).toBe('done')
    const starts = writes.filter(w => w.patch.status === 'running').map(w => w.id)
    expect(starts).toEqual([a.id, b.id])
    // b only starts after a finished.
    const aDone = writes.findIndex(w => w.id === a.id && w.patch.status === 'done')
    const bStart = writes.findIndex(w => w.id === b.id && w.patch.status === 'running')
    expect(aDone).toBeLessThan(bStart)
  })
})

describe('AnalysisQueue: NVENC busy at runtime', () => {
  it.skipIf(!CAN_FAKE_FFMPEG)('transcodes the preview with libx264 instead, logs it, and finishes (injected failing NVENC)', async () => {
    // a codec browsers cannot play, so the preview step transcodes
    const source = path.join(env.dataDir, 'mpeg4.mkv')
    const made = spawnSync(env.tools.ffmpegPath, ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', source], { encoding: 'utf8' })
    expect(made.status, made.stderr).toBe(0)
    const fake = await writeFailingNvencFfmpeg(await fsp.mkdtemp(path.join(env.dataDir, 'fake-')))
    const queue = new AnalysisQueue({
      config: { ...env.config, videoEncoderOverride: 'h264_nvenc' },
      repos: env.repos,
      tools: { ...env.tools, ffmpegPath: fake.ffmpegPath },
      transcriberCommand: fakeTranscriberCommand('ok'),
      log: message => logs.push(message),
    })
    queues.push(queue)
    const video = addVideo(source)
    await runToEnd(queue)

    const done = env.repos.videos.get(video.id)!
    expect(done.analysis).toMatchObject({ status: 'done', error: null })
    expect(done.previewPath).toBe(analysisFiles(env, video.id).preview)
    expect((await probeMedia(env.tools, done.previewPath!)).videoCodec).toBe('h264')
    // extract-audio (no video encoder), then the preview: NVENC, then libx264
    expect((await fakeFfmpegCalls(fake.calls)).slice(-2)).toEqual(['h264_nvenc', 'libx264'])
    expect(logs).toContainEqual(expect.stringMatching(new RegExp(`^\\[analysis ${video.id}\\] NVENC 硬體編碼失敗，改用 CPU（libx264）重新編碼：`)))
  })
})

describe('AnalysisQueue: failures', () => {
  it('fails with a Chinese message when the chosen audio track does not exist', async () => {
    const video = addVideo(fx.sampleEnMkv, { audioTrack: 5 })
    await runToEnd(makeQueue())
    const failed = env.repos.videos.get(video.id)!
    expect(failed.analysis.status).toBe('failed')
    expect(failed.analysis.step).toBe('probe')
    expect(failed.analysis.error).toBe('找不到第 6 條音軌（這支影片只有 2 條音軌）')
    expect(failed.media?.audioTracks).toHaveLength(2)
    expect(fs.existsSync(analysisFiles(env, video.id).audio)).toBe(false)
  })

  it('fails for a video without audio', async () => {
    const video = addVideo(fx.noAudioMp4)
    await runToEnd(makeQueue())
    expect(env.repos.videos.get(video.id)!.analysis.error).toBe('這支影片沒有音訊，無法辨識語音')
  })

  it('fails with 找不到原始影片檔 when the source file is gone', async () => {
    const video = addVideo(path.join(env.dataDir, 'nope', 'gone.mp4'))
    await runToEnd(makeQueue())
    const failed = env.repos.videos.get(video.id)!
    expect(failed.analysis).toMatchObject({ status: 'failed', step: 'probe', error: MISSING_SOURCE_MESSAGE })
  })

  it('reports a transcriber failure readably (no traceback) and still deletes audio.wav', async () => {
    const video = addVideo(fx.sampleEnMp4)
    await runToEnd(makeQueue('fail'))
    const failed = env.repos.videos.get(video.id)!
    expect(failed.analysis.status).toBe('failed')
    expect(failed.analysis.step).toBe('transcribe')
    expect(failed.analysis.error).toBe('語音辨識失敗：語音辨識模型載入失敗（測試）')
    expect(failed.analysis.error).not.toMatch(/Traceback|File "/)
    expect(fs.existsSync(analysisFiles(env, video.id).audio)).toBe(false)
    expect(env.repos.transcript.list(video.id)).toEqual([])
  })

  it('reports a missing transcriber in Chinese', async () => {
    const video = addVideo(fx.sampleEnMp4)
    const queue = new AnalysisQueue({
      config: env.config,
      repos: env.repos,
      tools: env.tools,
      transcriberCommand: [path.join(env.dataDir, 'no-such-transcriber')],
      log: () => {},
    })
    queues.push(queue)
    await runToEnd(queue)
    expect(env.repos.videos.get(video.id)!.analysis.error).toBe('找不到轉錄程式，請先執行安裝腳本')
  })

  it('a retried video runs again from scratch', async () => {
    const video = addVideo(fx.sampleEnMp4)
    const queue = makeQueue('fail')
    await runToEnd(queue)
    expect(env.repos.videos.get(video.id)!.analysis.status).toBe('failed')
    await queue.stop()
    const ok = makeQueue()
    ok.start()
    ok.enqueue(video.id)
    await waitFor(() => env.repos.videos.get(video.id)!.analysis.status === 'done')
    expect(env.repos.transcript.list(video.id).length).toBeGreaterThan(0)
  })
})

describe('AnalysisQueue: cancel, stop and recover', () => {
  it('cancel during transcribe kills the transcriber, marks the video and moves on', async () => {
    const pidFile = path.join(env.dataDir, 'pid.json')
    process.env.GG_FAKE_PID_FILE = pidFile
    try {
      const video = addVideo(fx.sampleEnMp4)
      const next = addVideo(path.join(env.dataDir, 'missing.mp4'))
      const queue = makeQueue('slow')
      queue.start()
      await waitFor(() => env.repos.videos.get(video.id)!.analysis.step === 'transcribe' && fs.existsSync(pidFile))
      const { pid } = JSON.parse(await fsp.readFile(pidFile, 'utf8')) as { pid: number }
      expect(processAlive(pid)).toBe(true)
      expect(queue.runningVideoId).toBe(video.id)

      await queue.cancel(video.id)
      const cancelled = env.repos.videos.get(video.id)!
      expect(cancelled.analysis).toMatchObject({ status: 'failed', step: 'transcribe', error: CANCELLED_MESSAGE })
      expect(fs.existsSync(analysisFiles(env, video.id).audio)).toBe(false)
      await waitFor(() => !processAlive(pid), 5000)

      // The queue keeps going with the next video.
      await waitFor(() => env.repos.videos.get(next.id)!.analysis.status === 'failed')
      expect(env.repos.videos.get(next.id)!.analysis.error).toBe(MISSING_SOURCE_MESSAGE)
    }
    finally {
      delete process.env.GG_FAKE_PID_FILE
    }
  })

  it('cancel of a queued video drops it from the queue', async () => {
    const video = addVideo(fx.sampleEnMp4)
    const queue = makeQueue()
    await queue.cancel(video.id)
    expect(env.repos.videos.get(video.id)!.analysis).toMatchObject({ status: 'failed', error: CANCELLED_MESSAGE })
    await runToEnd(queue)
    expect(env.repos.transcript.list(video.id)).toEqual([])
    // Cancelling a video that is not running is harmless.
    await queue.cancel('unknown-id')
  })

  it('stop() during a run leaves it running; recover() + start() redo it from the beginning in the same mode', async () => {
    const pidFile = path.join(env.dataDir, 'pid.json')
    process.env.GG_FAKE_PID_FILE = pidFile
    let pid = 0
    const video = addVideo(fx.sampleEnMkv, { audioTrack: 1 })
    try {
      const slow = makeQueue('slow')
      slow.start()
      await waitFor(() => fs.existsSync(pidFile))
      pid = (JSON.parse(await fsp.readFile(pidFile, 'utf8')) as { pid: number }).pid
      await slow.stop()
    }
    finally {
      delete process.env.GG_FAKE_PID_FILE
    }
    const stopped = env.repos.videos.get(video.id)!
    expect(stopped.analysis.status).toBe('running')
    expect(stopped.analysis.step).toBe('transcribe')
    await waitFor(() => !processAlive(pid), 5000)

    // Simulate partial results of the interrupted run.
    env.repos.transcript.replace(video.id, [{ start: 0, end: 1, text: 'partial' }])
    const files = analysisFiles(env, video.id)
    await fsp.writeFile(files.audio, 'x')
    await fsp.writeFile(path.join(files.dir, 'preview.tmp-1234.mp4'), 'x')
    await fsp.writeFile(path.join(files.dir, 'signals.tmp-1234.json'), 'x')

    const queue = makeQueue()
    const recovered = await queue.recover()
    expect(recovered).toEqual([video.id])
    const requeued = env.repos.videos.get(video.id)!
    expect(requeued.analysis).toMatchObject({ status: 'queued', mode: 'full', step: null, progress: 0, error: null })
    // The transcript stays until the re-run's transcribe step replaces it.
    expect(env.repos.transcript.list(video.id).map(s => s.text)).toEqual(['partial'])
    expect(fs.readdirSync(files.dir).filter(n => /^(?:audio\.|preview\.tmp-|signals\.tmp-)/.test(n))).toEqual([])

    await runToEnd(queue)
    const done = env.repos.videos.get(video.id)!
    expect(done.analysis.status).toBe('done')
    expect(env.repos.transcript.list(video.id).map(s => s.text)).not.toContain('partial')
  })

  it('recovered videos keep their place ahead of videos queued later', async () => {
    const first = addVideo(fx.sampleEnMp4)
    env.repos.videos.updateAnalysis(first.id, { status: 'running', step: 'transcribe', progress: 0.4 })
    await new Promise(resolve => setTimeout(resolve, 5))
    const second = addVideo(fx.verticalMp4)
    const writes = recordAnalysisWrites()
    const queue = makeQueue()
    expect(await queue.recover()).toEqual([first.id])
    await runToEnd(queue)
    const starts = writes.filter(w => w.patch.status === 'running').map(w => w.id)
    expect(starts).toEqual([first.id, second.id])
  })
})

describe('checkAudioTrack', () => {
  const media = { durationSec: 1, width: 2, height: 2, fps: 30, videoCodec: 'h264', container: 'mp4', audioTracks: [] as never[] }
  it('accepts an existing track and rejects others', () => {
    const track = { index: 0, codec: 'aac', channels: 2, language: null, title: null }
    expect(() => checkAudioTrack({ ...media, audioTracks: [track] }, 0)).not.toThrow()
    expect(() => checkAudioTrack({ ...media, audioTracks: [track] }, 1)).toThrow('找不到第 2 條音軌（這支影片只有 1 條音軌）')
    expect(() => checkAudioTrack({ ...media, audioTracks: [track] }, -1)).toThrow()
    expect(() => checkAudioTrack(media, 0)).toThrow('這支影片沒有音訊')
  })
})
