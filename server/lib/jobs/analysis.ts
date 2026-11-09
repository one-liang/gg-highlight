// Analysis, one video at a time. 'full': probe → extract-audio → transcribe → prepare-preview →
// signals → candidates. 'highlights': extract-audio (skipped when the loudness is cached) → signals →
// candidates, keeping the Transcript (and the user's edits) and the preview (design.md「分析」).
import fs from 'node:fs/promises'
import type { AnalysisMode, AnalysisStep, MediaInfo } from '../../../shared/types/domain'
import type { VideoRecord } from '../db'
import { unloadModel } from '../llm'
import { detectVideoEncoder, encoderFallbackMessage, extractAudio, preparePreview, probeMedia } from '../media'
import { buildTranscriptSegments, cleanRawTranscript, formatCleanupReport } from '../subtitles'
import { runTranscriber } from '../transcription'
import { computeSignals, finishAnalysis, loudnessForHighlights, storeCandidates } from './analysis-highlights'
import type { LoudnessInput } from './analysis-highlights'
import { ANALYSIS_STEPS, analysisFiles, LEFTOVER_PREFIXES, STEP_LABELS } from './analysis-steps'
import type { AnalysisRun } from './analysis-steps'
import { CANCELLED_MESSAGE, MISSING_SOURCE_MESSAGE, readableError } from './errors'
import { isFile, removeLeftovers, removeQuietly } from './files'
import { createStepProgress } from './progress'
import { type JobDeps, type JobDepsInput, type JobQueue, resolveDeps } from './types'
import { abortKind, SerialWorker, throwIfAborted } from './worker'

export { ANALYSIS_STEPS, analysisFiles, SIGNALS_STEP_SHARES } from './analysis-steps'

/** recover() waits at most this long for Ollama to unload a model left by an interrupted run. */
const RECOVER_UNLOAD_TIMEOUT_MS = 3000

/** Fails with a readable message when the chosen Analysis audio track does not exist. */
export function checkAudioTrack(media: MediaInfo, audioTrack: number): void {
  const count = media.audioTracks.length
  if (count === 0) throw new Error('這支影片沒有音訊，無法辨識語音')
  if (!Number.isInteger(audioTrack) || audioTrack < 0 || audioTrack >= count) {
    throw new Error(`找不到第 ${audioTrack + 1} 條音軌（這支影片只有 ${count} 條音軌）`)
  }
}

/**
 * 'full' mode up to the preview: probe, extract audio.wav, transcribe (the new Transcript replaces
 * the old one only once this succeeds), prepare the preview. audio.wav stays for the loudness.
 */
async function runTranscriptSteps(run: AnalysisRun): Promise<{ media: MediaInfo, loudness: LoudnessInput }> {
  const { deps, videoId, files, signal, progress } = run
  const { repos, config, tools } = deps
  const onProgress = (fraction: number) => progress.update(fraction)

  const filePath = run.filePath
  if (!filePath || !(await isFile(filePath))) throw new Error(MISSING_SOURCE_MESSAGE)
  const media = await probeMedia(tools, filePath)
  throwIfAborted(signal)
  repos.videos.update(videoId, { media })
  checkAudioTrack(media, run.audioTrack)

  progress.step('extract-audio')
  await fs.mkdir(files.dir, { recursive: true })
  await extractAudio(tools, { filePath, audioTrack: run.audioTrack, durationSec: media.durationSec }, files.audio, { signal, onProgress })

  progress.step('transcribe')
  const raw = await runTranscriber(deps.transcriberCommand, {
    audioPath: files.audio,
    language: run.language,
    outPath: files.rawTranscript,
    model: config.asrModels[run.language],
    device: config.asrDevice,
  }, { signal, onProgress, onLog: run.log })
  throwIfAborted(signal)
  // transcript.raw.json stays as the transcriber wrote it; the cleaned copy becomes the Transcript.
  const { raw: cleaned, report } = cleanRawTranscript(raw)
  const cleanup = formatCleanupReport(report)
  if (cleanup) run.log(cleanup)
  repos.transcript.replace(videoId, buildTranscriptSegments(cleaned, run.language))

  progress.step('prepare-preview')
  const encoder = await detectVideoEncoder(tools, config.videoEncoderOverride)
  const { previewPath } = await preparePreview(tools, { filePath, media }, files.preview, {
    signal,
    encoder,
    onProgress,
    onEncoderFallback: err => run.log(encoderFallbackMessage(err)),
  })
  // A playable original needs no preview; drop one left from an earlier run.
  if (!previewPath) await removeQuietly(files.preview)
  throwIfAborted(signal)
  repos.videos.update(videoId, { previewPath })
  return { media, loudness: { kind: 'wav', path: files.audio } }
}

/** 'highlights' mode: the stored media info (probed again only if it is missing) and the loudness source. */
async function prepareHighlightsRun(run: AnalysisRun, video: VideoRecord): Promise<{ media: MediaInfo, loudness: LoudnessInput }> {
  let media = video.media
  if (!media) {
    if (!run.filePath || !(await isFile(run.filePath))) throw new Error(MISSING_SOURCE_MESSAGE)
    media = await probeMedia(run.deps.tools, run.filePath)
    run.deps.repos.videos.update(run.videoId, { media })
  }
  return { media, loudness: await loudnessForHighlights(run, media) }
}

/** Runs one Analysis (in the mode stored on the video) and records the result. Never throws for job failures. */
export async function runAnalysis(deps: JobDeps, videoId: string, signal: AbortSignal): Promise<void> {
  const { repos } = deps
  const video = repos.videos.get(videoId)
  if (!video || video.analysis.status !== 'queued') return
  const mode: AnalysisMode = video.analysis.mode
  const steps = ANALYSIS_STEPS[mode]
  const files = analysisFiles(deps, videoId)

  // A 'full' re-run keeps the old Transcript until the transcribe step has a new one.
  repos.videos.updateAnalysis(videoId, { status: 'running', step: steps[0]![0], progress: 0, error: null })
  const progress = createStepProgress<AnalysisStep>(
    steps,
    (step, overall) => repos.videos.updateAnalysis(videoId, { step, progress: overall }),
    deps.now,
    deps.progressIntervalMs ?? 250,
  )
  const run: AnalysisRun = {
    deps,
    videoId,
    language: video.language,
    filePath: video.filePath,
    audioTrack: video.audioTrack,
    files,
    signal,
    progress,
    log: message => deps.log(`[analysis ${videoId}] ${message}`),
  }

  try {
    const { media, loudness } = mode === 'full' ? await runTranscriptSteps(run) : await prepareHighlightsRun(run, video)
    throwIfAborted(signal)
    const outcome = await computeSignals(run, loudness)
    storeCandidates(run, outcome, media.durationSec)
    finishAnalysis(run)
  }
  catch (err) {
    const kind = abortKind(signal)
    // Server shutting down: leave it 'running' so recover() restarts it on the next start.
    if (kind === 'shutdown') return
    const message = kind === 'cancel' ? CANCELLED_MESSAGE : readableError(err, STEP_LABELS[progress.current])
    if (kind !== 'cancel') run.log(`失敗：${message}`)
    repos.videos.updateAnalysis(videoId, { status: 'failed', error: message })
  }
  finally {
    await removeQuietly(files.audio)
  }
}

export class AnalysisQueue implements JobQueue {
  readonly deps: JobDeps
  private readonly worker: SerialWorker<VideoRecord>
  /** Videos re-queued by recover(): they keep their place at the front of the queue. */
  private readonly priority: string[] = []

  constructor(input: JobDepsInput) {
    this.deps = resolveDeps(input)
    this.worker = new SerialWorker<VideoRecord>({
      name: 'analysis',
      next: () => this.next(),
      ownerOf: video => video.id,
      run: (video, signal) => runAnalysis(this.deps, video.id, signal),
      log: this.deps.log,
    })
  }

  private next(): VideoRecord | null {
    const { videos } = this.deps.repos
    while (this.priority.length > 0) {
      const video = videos.get(this.priority[0]!)
      if (video?.analysis.status === 'queued') return video
      this.priority.shift()
    }
    return videos.nextQueued()
  }

  /** Id of the video being analysed right now. */
  get runningVideoId(): string | null {
    return this.worker.currentJob?.id ?? null
  }

  start(): void {
    this.worker.start()
  }

  stop(): Promise<void> {
    return this.worker.stop()
  }

  kick(): void {
    this.worker.kick()
  }

  /**
   * Queues the video (again) unless it is already queued or running, then kicks. `mode` is stored
   * for this and later runs (retry, recover); without it the video keeps its current mode.
   */
  enqueue(videoId: string, mode?: AnalysisMode): void {
    const video = this.deps.repos.videos.get(videoId)
    if (video && video.analysis.status !== 'queued' && video.analysis.status !== 'running') {
      this.deps.repos.videos.updateAnalysis(videoId, { status: 'queued', ...(mode ? { mode } : {}) })
    }
    this.kick()
  }

  async cancel(videoId: string): Promise<void> {
    const video = this.deps.repos.videos.get(videoId)
    if (video?.analysis.status === 'queued') {
      this.deps.repos.videos.updateAnalysis(videoId, { status: 'failed', error: CANCELLED_MESSAGE })
    }
    const at = this.priority.indexOf(videoId)
    if (at >= 0) this.priority.splice(at, 1)
    await this.worker.cancel(videoId)
  }

  async recover(): Promise<string[]> {
    const { repos } = this.deps
    const ids: string[] = []
    let llmInterrupted = false
    for (const video of repos.videos.listByAnalysisStatus('running')) {
      if (video.id === this.runningVideoId) continue
      if (video.analysis.step === 'signals') llmInterrupted = true
      // Same mode again. The Transcript and preview stay: a 'full' run replaces them at its own
      // steps, a 'highlights' run never touches them.
      repos.videos.updateAnalysis(video.id, { status: 'queued' })
      this.priority.push(video.id)
      ids.push(video.id)
    }
    // Leftovers of the interrupted runs (call before start(), so no new run is writing yet).
    for (const id of ids) await removeLeftovers(analysisFiles(this.deps, id).dir, LEFTOVER_PREFIXES)
    // The app died while the local LLM was reading (e.g. the window was closed): its model may still
    // hold the GPU memory the re-run's speech recognition needs. Best effort, skipped when Ollama is off.
    if (llmInterrupted && await unloadModel(this.deps.config.ollama, { fetch: this.deps.fetch, timeoutMs: RECOVER_UNLOAD_TIMEOUT_MS })) {
      this.deps.log('[analysis] 已卸載上次中斷時留在顯示卡的 Ollama 模型')
    }
    return ids
  }

  whenIdle(): Promise<void> {
    return this.worker.whenIdle()
  }
}
