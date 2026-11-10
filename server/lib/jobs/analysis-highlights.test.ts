// Milestone 2 Analysis: Signals (loudness + the fake Ollama reading the Transcript), candidate
// Highlights, 'highlights'-only re-runs, transcript cleanup, cancel / shutdown / recover with the LLM.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AnalysisMode, AnalysisState, Highlight, Language } from '../../../shared/types/domain'
import { checkReanalyze, requireTranscriptReady, transcriptReady } from '../api'
import { buildCandidates, LOUDNESS_REASON } from '../highlights'
import { DEFAULT_OLLAMA_MODEL } from '../llm'
import { type FakeOllama, startFakeOllama } from '../llm/test-helpers/fake-ollama.mjs'
import { readSignalsFile } from '../signals'
import { AnalysisQueue, analysisFiles } from './analysis'
import { signalTracks, type SignalsOutcome } from './analysis-highlights'
import { CANCELLED_MESSAGE, MISSING_SOURCE_MESSAGE } from './errors'
import { createJobTestEnv, fakeTranscriberCommand, type JobTestEnv, makeBurstVideo, waitFor } from './test-helpers/setup'

/** 45 s, 34 dB louder from 24 s to 27 s (see makeBurstVideo). The fake transcriber's en lines are at 0.3–9.6 s. */
const BURST = { start: 24, end: 27 }
/** The fake Ollama ('ok') picks en lines 2–3 ("…brand new game." / "Wow, that was an amazing shot!"). */
const MOMENT = { start: 3.1, end: 9.6 }
const OK_REASON = '大家笑成一團的反應'

let burstDir: string
let burstVideo: string
let env: JobTestEnv
let ollama: FakeOllama
const queues: AnalysisQueue[] = []
const logs: string[] = []

beforeAll(async () => {
  burstDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gg-burst-'))
  burstVideo = makeBurstVideo(path.join(burstDir, 'burst.mkv'))
})

afterAll(async () => {
  if (burstDir) await fsp.rm(burstDir, { recursive: true, force: true })
})

beforeEach(async () => {
  env = await createJobTestEnv()
  ollama = await startFakeOllama({ scenario: 'ok' })
  logs.length = 0
})

afterEach(async () => {
  await Promise.all(queues.splice(0).map(q => q.stop()))
  await ollama.close()
  await env.cleanup()
})

function makeQueue(opts: { transcriber?: string, ollamaUrl?: string | null } = {}) {
  const url = opts.ollamaUrl === undefined ? ollama.url : opts.ollamaUrl
  const queue = new AnalysisQueue({
    config: { ...env.config, ollama: { url, model: DEFAULT_OLLAMA_MODEL } },
    repos: env.repos,
    tools: env.tools,
    transcriberCommand: fakeTranscriberCommand(opts.transcriber ?? 'ok'),
    log: message => logs.push(message),
    progressIntervalMs: 0,
  })
  queues.push(queue)
  return queue
}

/** A copy of the burst video inside the test's data folder (so a test may delete it). */
async function addVideo(opts: { language?: Language, copy?: boolean } = {}) {
  let filePath = burstVideo
  if (opts.copy) {
    filePath = path.join(env.dataDir, 'source', 'burst.mkv')
    await fsp.mkdir(path.dirname(filePath), { recursive: true })
    await fsp.copyFile(burstVideo, filePath)
  }
  return env.repos.videos.insert({
    title: 'burst', sourceKind: 'watch-folder', filePath, youtubeUrl: null, youtube: null, language: opts.language ?? 'en', audioTrack: 0, media: null,
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

/** Runs a second Analysis of an analysed video in `mode` on `queue`. */
async function rerun(queue: AnalysisQueue, videoId: string, mode: AnalysisMode) {
  queue.enqueue(videoId, mode)
  await runToEnd(queue)
  return env.repos.videos.get(videoId)!
}

const overlaps = (a: { start: number, end: number }, b: { start: number, end: number }) => a.start < b.end && b.start < a.end
const candidatesOf = (videoId: string) => env.repos.highlights.listByVideo(videoId).filter(h => h.status === 'candidate' && h.origin === 'analysis')
const chatRequests = () => ollama.requests.filter(r => r.path === '/api/chat' && Array.isArray(r.body?.messages) && r.body.messages.length > 0)
const unloadRequests = () => ollama.requests.filter(r => r.path === '/api/chat' && r.body?.keep_alive === 0 && r.body.messages.length === 0)

function expectValidCandidate(h: Highlight, durationSec: number) {
  expect(h).toMatchObject({ origin: 'analysis', status: 'candidate' })
  expect(h.end - h.start).toBeGreaterThanOrEqual(15 - 1e-6)
  expect(h.end - h.start).toBeLessThanOrEqual(60 + 1e-6)
  expect(h.start).toBeGreaterThanOrEqual(0)
  expect(h.end).toBeLessThanOrEqual(durationSec + 1e-6)
  expect(h.score).toBeGreaterThan(0)
  expect(h.score).toBeLessThanOrEqual(1)
}

describe('full Analysis with Signals', () => {
  it('runs all six steps; the LLM and loudness give a candidate with a Taiwan Traditional reason, signals.json, and the model is unloaded', async () => {
    const writes = recordAnalysisWrites()
    const video = await addVideo()
    await runToEnd(makeQueue())

    const done = env.repos.videos.get(video.id)!
    expect(done.analysis).toMatchObject({
      status: 'done', mode: 'full', version: 2, step: null, progress: 1, error: null,
      signals: [
        { kind: 'loudness', status: 'used', reason: null },
        { kind: 'transcript', status: 'used', reason: null },
      ],
    })
    const mine = writes.filter(w => w.id === video.id)
    expect([...new Set(mine.map(w => w.patch.step).filter(Boolean))])
      .toEqual(['probe', 'extract-audio', 'transcribe', 'prepare-preview', 'signals', 'candidates'])
    const progress = mine.map(w => w.patch.progress).filter((p): p is number => typeof p === 'number')
    expect([...progress].sort((a, b) => a - b)).toEqual(progress)
    // Inside the signals step (77 %–98 %): after the loudness and per chunk read.
    expect(progress.some(p => p > 0.77 && p < 0.98)).toBe(true)

    // 45 s → at most ceil(0.0125 × 10) = 1 candidate: the transcript moment outweighs the loudness burst.
    const candidates = env.repos.highlights.listByVideo(video.id)
    expect(candidates).toHaveLength(1)
    expectValidCandidate(candidates[0]!, done.media!.durationSec)
    expect(candidates[0]!.reason).toBe(OK_REASON)
    expect(overlaps(candidates[0]!, MOMENT)).toBe(true)

    const files = analysisFiles(env, video.id)
    const signals = await readSignalsFile(files.signals)
    expect(signals?.loudness?.db).toHaveLength(Math.ceil(done.media!.durationSec))
    // lavfi's sine is -18 dBFS; outside the burst it is turned down by 34 dB.
    expect(Math.max(...signals!.loudness!.db.slice(BURST.start, BURST.end))).toBeGreaterThan(-25)
    expect(signals!.loudness!.db[5]).toBeLessThan(-50)
    expect(signals?.transcript?.model).toBe(DEFAULT_OLLAMA_MODEL)
    expect(signals?.transcript?.moments.map(m => m.reason)).toContain(OK_REASON)
    expect(fs.existsSync(files.audio)).toBe(false)

    // version → tags → one chunk → unload, with the transcript lines as "n|text"
    expect(ollama.requests.map(r => r.path)).toEqual(['/api/version', '/api/tags', '/api/chat', '/api/chat'])
    const [chat] = chatRequests()
    expect(chat!.body).toMatchObject({ model: DEFAULT_OLLAMA_MODEL, think: false, stream: true, keep_alive: '1m' })
    expect(JSON.stringify(chat!.body.messages)).toContain('3|Wow, that was an amazing shot!')
    expect(unloadRequests()).toHaveLength(1)
    expect(logs).toContainEqual(`[analysis ${video.id}] 找到 1 個候選精華片段（依據音量、逐字稿）`)
  })

  it('with GG_OLLAMA_URL=off: loudness alone finds the burst, the transcript Signal is missing with the reason', async () => {
    const video = await addVideo()
    await runToEnd(makeQueue({ ollamaUrl: null }))

    const done = env.repos.videos.get(video.id)!
    expect(done.analysis).toMatchObject({
      status: 'done', version: 2,
      signals: [
        { kind: 'loudness', status: 'used', reason: null },
        { kind: 'transcript', status: 'missing', reason: '已關閉 AI 讀逐字稿（GG_OLLAMA_URL=off）' },
      ],
    })
    const [candidate, ...rest] = env.repos.highlights.listByVideo(video.id)
    expect(rest).toEqual([])
    expectValidCandidate(candidate!, done.media!.durationSec)
    expect(overlaps(candidate!, BURST)).toBe(true)
    expect(candidate!.reason).toBe(LOUDNESS_REASON)
    expect(ollama.requests).toEqual([])
    expect((await readSignalsFile(analysisFiles(env, video.id).signals))?.transcript).toBeNull()
  })

  it('finishes with loudness only when Ollama lacks the model, telling the user to pull it', async () => {
    ollama.setScenario('model-missing')
    const video = await addVideo()
    await runToEnd(makeQueue())
    const done = env.repos.videos.get(video.id)!
    expect(done.analysis.status).toBe('done')
    expect(done.analysis.signals?.[1]).toEqual({
      kind: 'transcript', status: 'missing', reason: `Ollama 裡還沒有 ${DEFAULT_OLLAMA_MODEL} 模型，請執行 ollama pull ${DEFAULT_OLLAMA_MODEL}`,
    })
    expect(env.repos.highlights.listByVideo(video.id).map(h => h.reason)).toEqual([LOUDNESS_REASON])
  })

  it('cleans the ASR repetition loop (快 × 78) before cutting the Transcript; transcript.raw.json stays as written', async () => {
    const video = await addVideo({ language: 'zh' })
    await runToEnd(makeQueue({ transcriber: 'loop', ollamaUrl: null }))
    expect(env.repos.videos.get(video.id)!.analysis.status).toBe('done')

    const texts = env.repos.transcript.list(video.id).map(s => s.text)
    expect(texts.join('')).toContain('我們先過去那邊快快快快')
    expect(texts.join('')).toContain('好過來過來')
    expect(texts.some(t => /快{5,}/u.test(t))).toBe(false)
    expect(logs).toContainEqual(`[analysis ${video.id}] 逐字稿清理：縮短連續重複 1 處（刪掉 74 字）；1 段壓縮比偏高`)
    const raw = await fsp.readFile(analysisFiles(env, video.id).rawTranscript, 'utf8')
    expect(raw).toContain('快'.repeat(78))
  })

  it('a full re-run keeps the old Transcript until the new one is ready, then replaces it (edits included)', async () => {
    const video = await addVideo()
    await runToEnd(makeQueue())
    env.repos.transcript.updateText(video.id, 0, '大家好，這是我改過的字幕')
    const before = env.repos.transcript.list(video.id)
    await queues[0]!.stop()

    const failed = await rerun(makeQueue({ transcriber: 'fail' }), video.id, 'full')
    expect(failed.analysis).toMatchObject({ status: 'failed', mode: 'full', step: 'transcribe', version: 2 })
    expect(env.repos.transcript.list(video.id)).toEqual(before)

    const queue = makeQueue()
    queue.start()
    queue.enqueue(video.id) // a retry keeps the mode
    await queue.whenIdle()
    const done = env.repos.videos.get(video.id)!
    expect(done.analysis).toMatchObject({ status: 'done', mode: 'full' })
    expect(env.repos.transcript.list(video.id).every(s => !s.edited)).toBe(true)
  })
})

describe('highlights-only Analysis', () => {
  it('keeps the edited Transcript, the preview and the kept Highlights, reuses the loudness and replaces only open candidates', async () => {
    const video = await addVideo()
    await runToEnd(makeQueue())
    await queues[0]!.stop()
    const files = analysisFiles(env, video.id)
    const first = env.repos.videos.get(video.id)!
    expect(first.previewPath).toBe(files.preview)
    const previewMtime = fs.statSync(files.preview).mtimeMs
    const rawMtime = fs.statSync(files.rawTranscript).mtimeMs

    // The user selects the candidate, edits the Transcript, adds a manual Highlight and exports an old candidate.
    const [chosen] = env.repos.highlights.listByVideo(video.id)
    env.repos.highlights.update(chosen!.id, { status: 'selected' })
    env.repos.transcript.updateText(video.id, 1, '這波操作太扯了啊')
    const transcript = env.repos.transcript.list(video.id)
    const manual = env.repos.highlights.insert({ videoId: video.id, start: 40, end: 42, status: 'selected', origin: 'manual', score: null, reason: null })
    const exported = env.repos.highlights.insert({ videoId: video.id, start: 43, end: 45, status: 'candidate', origin: 'analysis', score: 0.3, reason: '舊的' })
    env.repos.clips.insert({ videoId: video.id, highlightId: exported.id, start: 43, end: 45, layout: 'original', burnSubtitles: true })
    const stale = env.repos.highlights.insert({ videoId: video.id, start: 30, end: 34, status: 'candidate', origin: 'analysis', score: 0.3, reason: '舊的' })
    ollama.requests.length = 0

    const writes = recordAnalysisWrites()
    // A transcriber that fails proves the Transcript is not recognised again.
    const done = await rerun(makeQueue({ transcriber: 'fail' }), video.id, 'highlights')
    expect(done.analysis).toMatchObject({ status: 'done', mode: 'highlights', version: 2, error: null })
    expect(done.analysis.signals?.map(s => s.status)).toEqual(['used', 'used'])
    const steps = [...new Set(writes.filter(w => w.id === video.id).map(w => w.patch.step).filter(Boolean))]
    expect(steps).toEqual(['extract-audio', 'signals', 'candidates'])
    expect(logs).toContainEqual(`[analysis ${video.id}] 沿用上次分析的音量資料，不重新擷取音訊`)

    expect(env.repos.transcript.list(video.id)).toEqual(transcript)
    expect(done.previewPath).toBe(files.preview)
    expect(fs.statSync(files.preview).mtimeMs).toBe(previewMtime)
    expect(fs.statSync(files.rawTranscript).mtimeMs).toBe(rawMtime)
    // The LLM read the edited text.
    expect(JSON.stringify(chatRequests()[0]!.body.messages)).toContain('2|這波操作太扯了啊')

    const all = env.repos.highlights.listByVideo(video.id)
    const ids = all.map(h => h.id)
    expect(ids).toEqual(expect.arrayContaining([chosen!.id, manual.id, exported.id]))
    expect(ids).not.toContain(stale.id)
    const kept = [env.repos.highlights.get(chosen!.id)!, manual, exported]
    const fresh = candidatesOf(video.id).filter(h => h.id !== exported.id)
    expect(fresh).toHaveLength(1)
    expectValidCandidate(fresh[0]!, done.media!.durationSec)
    expect(kept.some(k => overlaps(k, fresh[0]!))).toBe(false)
    // The transcript moment lies inside the selected Highlight, so the new one comes from the burst.
    expect(overlaps(fresh[0]!, BURST)).toBe(true)
    expect(fresh[0]!.reason).toBe(LOUDNESS_REASON)
  })

  it('without the source file: the loudness Signal is missing and the Transcript alone finds candidates', async () => {
    const video = await addVideo({ copy: true })
    await runToEnd(makeQueue())
    await queues[0]!.stop()
    const files = analysisFiles(env, video.id)
    await fsp.rm(files.signals)
    await fsp.rm(video.filePath!)
    env.repos.highlights.deleteByVideo(video.id)

    const done = await rerun(makeQueue(), video.id, 'highlights')
    expect(done.analysis).toMatchObject({
      status: 'done', mode: 'highlights',
      signals: [
        { kind: 'loudness', status: 'missing', reason: MISSING_SOURCE_MESSAGE },
        { kind: 'transcript', status: 'used', reason: null },
      ],
    })
    const candidates = candidatesOf(video.id)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.reason).toBe(OK_REASON)
    expect((await readSignalsFile(files.signals))?.loudness).toBeNull()
  })

  it('extracts the audio again when signals.json has no loudness (a milestone 1 video)', async () => {
    const video = await addVideo()
    await runToEnd(makeQueue({ ollamaUrl: null }))
    await queues[0]!.stop()
    await fsp.rm(analysisFiles(env, video.id).signals)
    env.repos.videos.updateAnalysis(video.id, { version: 1, signals: null })
    env.repos.highlights.deleteByVideo(video.id)

    const done = await rerun(makeQueue({ ollamaUrl: null }), video.id, 'highlights')
    expect(done.analysis).toMatchObject({ status: 'done', version: 2 })
    expect(done.analysis.signals?.[0]).toEqual({ kind: 'loudness', status: 'used', reason: null })
    expect(candidatesOf(video.id).map(h => overlaps(h, BURST))).toEqual([true])
    expect(logs.some(l => l.includes('沿用上次分析的音量資料'))).toBe(false)
  })
})

describe('signalTracks: an LLM chunk that could not be read', () => {
  // 30 minutes at -30 dBFS with a shout (+9 dB) at 1000–1011 s, inside chunk 2 (540–1140 s), which failed twice
  const durationSec = 1800
  const envelope = { db: Array.from({ length: durationSec }, (_, i) => (i >= 1000 && i < 1012 ? -21 : -30)) }
  const moments = [{ start: 100, end: 130, score: 6 / 9, reason: '大笑' }, { start: 1500, end: 1530, score: 6 / 9, reason: '尖叫' }]
  const outcome = (transcript: SignalsOutcome['transcript']): SignalsOutcome => ({ envelope, transcript, states: [] })
  const used = { kind: 'transcript', status: 'used', reason: '1 個區段讀取失敗' } as const
  const candidatesOf = (o: SignalsOutcome) => buildCandidates({ durationSec, segments: [], tracks: signalTracks(o, durationSec), moments: o.transcript.moments, occupied: [] })

  it('leaves the unread seconds to the other Signals: a loudness peak there scores as if the AI Signal were missing', () => {
    const skipped = outcome({ state: used, moments, unread: [{ start: 599, end: 1139 }], model: DEFAULT_OLLAMA_MODEL })
    const missing = outcome({ state: { kind: 'transcript', status: 'missing', reason: 'x' }, moments: [], unread: [], model: DEFAULT_OLLAMA_MODEL })
    const [, transcript] = signalTracks(skipped, durationSec)
    expect(transcript!.covered![700]).toBe(0)
    expect(transcript!.covered![200]).toBe(1)

    const shout = (list: ReturnType<typeof buildCandidates>) => list.find(c => c.start <= 1000 && c.end >= 1011)
    const loudnessOnly = shout(candidatesOf(missing))
    expect(loudnessOnly).toBeDefined()
    expect(shout(candidatesOf(skipped))).toEqual(loudnessOnly)
    // read by the AI but found nothing there: the same shout counts a third as much (and is not picked)
    const readAll = outcome({ state: used, moments, unread: [], model: DEFAULT_OLLAMA_MODEL })
    expect(signalTracks(readAll, durationSec)[1]!.covered).toBeUndefined()
    expect(shout(candidatesOf(readAll))?.score ?? 0).toBeLessThan(loudnessOnly!.score)
  })
})

describe('cancel, shutdown and recover while the LLM reads', () => {
  it('cancel during a hanging Ollama request: 已取消, and the model is still unloaded', async () => {
    ollama.setScenario('hang')
    const video = await addVideo()
    const queue = makeQueue()
    queue.start()
    await waitFor(() => chatRequests().length > 0)
    expect(env.repos.videos.get(video.id)!.analysis.step).toBe('signals')

    await queue.cancel(video.id)
    const cancelled = env.repos.videos.get(video.id)!
    expect(cancelled.analysis).toMatchObject({ status: 'failed', mode: 'full', step: 'signals', error: CANCELLED_MESSAGE, signals: null, version: null })
    expect(unloadRequests()).toHaveLength(1)
    expect(fs.existsSync(analysisFiles(env, video.id).audio)).toBe(false)
    expect(env.repos.highlights.listByVideo(video.id)).toEqual([])
  })

  it('cancel during a full re-run of an analysed video: the Transcript, Highlights and 只重新找精華片段 stay available', async () => {
    const video = await addVideo()
    await runToEnd(makeQueue())
    await queues[0]!.stop()
    const transcript = env.repos.transcript.list(video.id)
    const highlights = env.repos.highlights.listByVideo(video.id)
    expect(highlights.length).toBeGreaterThan(0)

    ollama.setScenario('hang')
    const queue = makeQueue()
    queue.start()
    const chatsBefore = chatRequests().length
    queue.enqueue(video.id, 'full')
    expect(transcriptReady(env.repos.videos.get(video.id)!)).toBe(false) // queued: about to be replaced
    await waitFor(() => chatRequests().length > chatsBefore)
    await queue.cancel(video.id)

    const cancelled = env.repos.videos.get(video.id)!
    expect(cancelled.analysis).toMatchObject({ status: 'failed', mode: 'full', error: CANCELLED_MESSAGE, version: 2 })
    // the new Transcript came in complete before the AI step, and nothing else changed
    expect(env.repos.transcript.list(video.id).map(s => s.text)).toEqual(transcript.map(s => s.text))
    expect(env.repos.highlights.listByVideo(video.id)).toEqual(highlights)
    expect(transcriptReady(cancelled)).toBe(true)
    expect(() => requireTranscriptReady(cancelled, 'editTranscript')).not.toThrow()
    expect(() => requireTranscriptReady(cancelled, 'export')).not.toThrow()
    expect(() => checkReanalyze(cancelled, 'highlights', { activeClips: 0, sourceExists: true })).not.toThrow()

    env.repos.transcript.updateText(video.id, 0, '取消之後改的字')
    ollama.setScenario('ok')
    const rerun = makeQueue()
    rerun.enqueue(video.id, 'highlights')
    await runToEnd(rerun)
    expect(env.repos.videos.get(video.id)!.analysis).toMatchObject({ status: 'done', mode: 'highlights', version: 2 })
    expect(env.repos.transcript.list(video.id)[0]).toMatchObject({ text: '取消之後改的字', edited: true })
  })

  it('shutdown during a highlights-only run leaves it running; recover() re-runs it in the same mode, keeping the edits', async () => {
    const video = await addVideo()
    await runToEnd(makeQueue())
    await queues[0]!.stop()
    env.repos.transcript.updateText(video.id, 0, '改過的第一句')
    const transcript = env.repos.transcript.list(video.id)

    ollama.setScenario('hang')
    const hanging = makeQueue()
    hanging.start()
    const chatsBefore = chatRequests().length
    hanging.enqueue(video.id, 'highlights')
    await waitFor(() => chatRequests().length > chatsBefore)
    await hanging.stop()
    const stopped = env.repos.videos.get(video.id)!
    expect(stopped.analysis).toMatchObject({ status: 'running', mode: 'highlights', step: 'signals' })
    expect(unloadRequests()).toHaveLength(2)

    ollama.setScenario('ok')
    const queue = makeQueue({ transcriber: 'fail' })
    expect(await queue.recover()).toEqual([video.id])
    // interrupted while the LLM read: the model it may have left in GPU memory is unloaded first
    expect(unloadRequests()).toHaveLength(3)
    expect(logs).toContain('[analysis] 已卸載上次中斷時留在顯示卡的 Ollama 模型')
    expect(env.repos.videos.get(video.id)!.analysis).toMatchObject({ status: 'queued', mode: 'highlights' })
    expect(env.repos.transcript.list(video.id)).toEqual(transcript)
    await runToEnd(queue)
    expect(env.repos.videos.get(video.id)!.analysis).toMatchObject({ status: 'done', mode: 'highlights', error: null })
    expect(env.repos.transcript.list(video.id)).toEqual(transcript)
  })

  it('recover() unloads the model only for a run interrupted in the signals step, and never with Ollama off', async () => {
    const atTranscribe = await addVideo()
    env.repos.videos.updateAnalysis(atTranscribe.id, { status: 'running', step: 'transcribe' })
    expect(await makeQueue().recover()).toEqual([atTranscribe.id])
    expect(ollama.requests).toEqual([])

    const atSignals = await addVideo({ copy: true })
    env.repos.videos.updateAnalysis(atSignals.id, { status: 'running', step: 'signals' })
    expect(await makeQueue({ ollamaUrl: null }).recover()).toEqual([atSignals.id])
    expect(ollama.requests).toEqual([])
  })

  it('enqueue stores the mode; without one the video keeps its mode (retry)', async () => {
    const a = await addVideo()
    const queue = makeQueue()
    env.repos.videos.updateAnalysis(a.id, { status: 'failed', error: 'x', mode: 'highlights' })
    queue.enqueue(a.id)
    expect(env.repos.videos.get(a.id)!.analysis).toMatchObject({ status: 'queued', mode: 'highlights' })
    // already queued: neither status nor mode change
    queue.enqueue(a.id, 'full')
    expect(env.repos.videos.get(a.id)!.analysis.mode).toBe('highlights')
    env.repos.videos.updateAnalysis(a.id, { status: 'done' })
    queue.enqueue(a.id, 'full')
    expect(env.repos.videos.get(a.id)!.analysis).toMatchObject({ status: 'queued', mode: 'full' })
  })
})
