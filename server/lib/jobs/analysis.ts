// Analysis: probe → extract-audio → transcribe → prepare-preview, one video at a time.
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AnalysisStep, MediaInfo } from '../../../shared/types/domain'
import { videoWorkDir } from '../config'
import type { VideoRecord } from '../db'
import { detectVideoEncoder, extractAudio, preparePreview, probeMedia } from '../media'
import { buildTranscriptSegments } from '../subtitles'
import { runTranscriber } from '../transcription'
import { CANCELLED_MESSAGE, MISSING_SOURCE_MESSAGE, readableError } from './errors'
import { isFile, removeLeftovers, removeQuietly } from './files'
import { createStepProgress } from './progress'
import { type JobDeps, type JobDepsInput, type JobQueue, resolveDeps } from './types'
import { abortKind, SerialWorker, throwIfAborted } from './worker'

type Milestone1Step = Extract<AnalysisStep, 'probe' | 'extract-audio' | 'transcribe' | 'prepare-preview'>

/** Step weights of the overall progress (design.md). */
export const ANALYSIS_STEPS: ReadonlyArray<readonly [Milestone1Step, number]> = [
  ['probe', 0.02],
  ['extract-audio', 0.08],
  ['transcribe', 0.75],
  ['prepare-preview', 0.15],
]

const STEP_LABELS: Record<Milestone1Step, string> = {
  'probe': '讀取影片資訊',
  'extract-audio': '擷取音訊',
  'transcribe': '語音辨識',
  'prepare-preview': '準備預覽',
}

export function analysisFiles(deps: Pick<JobDeps, 'config'>, videoId: string) {
  const dir = videoWorkDir(deps.config, videoId)
  return {
    dir,
    audio: path.join(dir, 'audio.wav'),
    rawTranscript: path.join(dir, 'transcript.raw.json'),
    preview: path.join(dir, 'preview.mp4'),
  }
}

/** Fails with a readable message when the chosen Analysis audio track does not exist. */
export function checkAudioTrack(media: MediaInfo, audioTrack: number): void {
  const count = media.audioTracks.length
  if (count === 0) throw new Error('這支影片沒有音訊，無法辨識語音')
  if (!Number.isInteger(audioTrack) || audioTrack < 0 || audioTrack >= count) {
    throw new Error(`找不到第 ${audioTrack + 1} 條音軌（這支影片只有 ${count} 條音軌）`)
  }
}

/** Runs one Analysis and records the result on the video. Never throws for job failures. */
export async function runAnalysis(deps: JobDeps, videoId: string, signal: AbortSignal): Promise<void> {
  const { repos, config, tools } = deps
  const video = repos.videos.get(videoId)
  if (!video || video.analysis.status !== 'queued') return
  const files = analysisFiles(deps, videoId)

  // Every run starts from scratch (retry, or restart after the app was closed mid-way).
  repos.videos.updateAnalysis(videoId, { status: 'running', step: 'probe', progress: 0, error: null })
  repos.transcript.replace(videoId, [])
  repos.videos.update(videoId, { previewPath: null })
  const progress = createStepProgress(
    ANALYSIS_STEPS,
    (step, overall) => repos.videos.updateAnalysis(videoId, { step, progress: overall }),
    deps.now,
    deps.progressIntervalMs ?? 250,
  )
  const onProgress = (fraction: number) => progress.update(fraction)

  try {
    const filePath = video.filePath
    if (!filePath || !(await isFile(filePath))) throw new Error(MISSING_SOURCE_MESSAGE)
    const media = await probeMedia(tools, filePath)
    throwIfAborted(signal)
    repos.videos.update(videoId, { media })
    checkAudioTrack(media, video.audioTrack)

    progress.step('extract-audio')
    await fs.mkdir(files.dir, { recursive: true })
    await extractAudio(tools, { filePath, audioTrack: video.audioTrack, durationSec: media.durationSec }, files.audio, { signal, onProgress })

    progress.step('transcribe')
    const raw = await runTranscriber(deps.transcriberCommand, {
      audioPath: files.audio,
      language: video.language,
      outPath: files.rawTranscript,
      model: config.asrModels[video.language],
      device: config.asrDevice,
    }, {
      signal,
      onProgress,
      onLog: message => deps.log(`[analysis ${videoId}] ${message}`),
    })
    throwIfAborted(signal)
    repos.transcript.replace(videoId, buildTranscriptSegments(raw, video.language))

    progress.step('prepare-preview')
    const encoder = await detectVideoEncoder(tools, config.videoEncoderOverride)
    const { previewPath } = await preparePreview(tools, { filePath, media }, files.preview, { signal, encoder, onProgress })
    // A playable original needs no preview; drop one left from an earlier run.
    if (!previewPath) await removeQuietly(files.preview)
    throwIfAborted(signal)
    repos.videos.update(videoId, { previewPath })
    repos.videos.updateAnalysis(videoId, { status: 'done', step: null, progress: 1, error: null })
  }
  catch (err) {
    const kind = abortKind(signal)
    // Server shutting down: leave it 'running' so recover() restarts it on the next start.
    if (kind === 'shutdown') return
    const message = kind === 'cancel' ? CANCELLED_MESSAGE : readableError(err, STEP_LABELS[progress.current])
    if (kind !== 'cancel') deps.log(`[analysis ${videoId}] 失敗：${message}`)
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

  /** Queues the video (again) unless it is already queued or running, then kicks. */
  enqueue(videoId: string): void {
    const video = this.deps.repos.videos.get(videoId)
    if (video && video.analysis.status !== 'queued' && video.analysis.status !== 'running') {
      this.deps.repos.videos.updateAnalysis(videoId, { status: 'queued' })
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
    for (const video of repos.videos.listByAnalysisStatus('running')) {
      if (video.id === this.runningVideoId) continue
      repos.transcript.replace(video.id, [])
      repos.videos.update(video.id, { previewPath: null })
      repos.videos.updateAnalysis(video.id, { status: 'queued' })
      this.priority.push(video.id)
      ids.push(video.id)
    }
    // Leftovers of the interrupted runs (call before start(), so no new run is writing yet).
    for (const id of ids) await removeLeftovers(analysisFiles(this.deps, id).dir, ['audio.', 'preview.tmp-'])
    return ids
  }

  whenIdle(): Promise<void> {
    return this.worker.whenIdle()
  }
}
