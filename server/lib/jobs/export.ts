// Export: one Clip at a time — SRT always, ASS when burning subtitles, then the mp4.
import path from 'node:path'
import { clipsDir } from '../config'
import type { ClipRecord } from '../db'
import { detectVideoEncoder, encoderFallbackMessage, exportClip, outputSizeFor, probeMedia } from '../media'
import { buildAss, buildSrt, cuesForRange } from '../subtitles'
import { CANCELLED_MESSAGE, MISSING_SOURCE_MESSAGE, readableError } from './errors'
import { isFile, removeLeftovers, removeQuietly, writeTextAtomic } from './files'
import { createThrottledProgress } from './progress'
import { type JobDeps, type JobDepsInput, type JobQueue, resolveDeps } from './types'
import { abortKind, SerialWorker, throwIfAborted } from './worker'

/**
 * An Export of a YouTube video whose downloaded file is gone (MISSING_SOURCE_MESSAGE is about a local
 * original); worded like the 422 of POST /api/highlights/:id/clips.
 */
const EXPORT_MISSING_DOWNLOAD_MESSAGE = '找不到下載的影片檔'

export function clipFiles(deps: Pick<JobDeps, 'config'>, clip: Pick<ClipRecord, 'id' | 'videoId'>) {
  const dir = clipsDir(deps.config, clip.videoId)
  const names = { mp4: `${clip.id}.mp4`, srt: `${clip.id}.srt`, ass: `${clip.id}.ass` }
  return {
    dir,
    names,
    mp4: path.join(dir, names.mp4),
    srt: path.join(dir, names.srt),
    ass: path.join(dir, names.ass),
  }
}

/** Runs one Export and records the result on the clip. Never throws for job failures. */
export async function runExport(deps: JobDeps, clipId: string, signal: AbortSignal): Promise<void> {
  const { repos, config, tools } = deps
  const clip = repos.clips.get(clipId)
  if (!clip || clip.status !== 'queued') return
  const files = clipFiles(deps, clip)

  repos.clips.update(clipId, { status: 'running', progress: 0, error: null, fileName: null, srtFileName: null })
  const progress = createThrottledProgress(
    value => repos.clips.update(clipId, { progress: value }),
    deps.now,
    deps.progressIntervalMs ?? 250,
  )

  try {
    const video = repos.videos.get(clip.videoId)
    if (!video) throw new Error('找不到這支影片')
    const input = video.filePath
    if (!input || !(await isFile(input))) {
      throw new Error(video.sourceKind === 'youtube' ? EXPORT_MISSING_DOWNLOAD_MESSAGE : MISSING_SOURCE_MESSAGE)
    }
    const media = video.media ?? await probeMedia(tools, input)
    throwIfAborted(signal)

    const cues = cuesForRange(repos.transcript.list(video.id), clip.start, clip.end)
    await writeTextAtomic(files.srt, buildSrt(cues))
    let assPath: string | null = null
    if (clip.burnSubtitles) {
      const size = outputSizeFor(clip.layout, media)
      await writeTextAtomic(files.ass, buildAss(cues, { ...size, layout: clip.layout }))
      assPath = files.ass
    }

    const encoder = await detectVideoEncoder(tools, config.videoEncoderOverride)
    await exportClip(tools, {
      input,
      media,
      start: clip.start,
      end: clip.end,
      layout: clip.layout,
      assPath,
      fontsDir: config.fontsDir,
      output: files.mp4,
      encoder,
    }, {
      signal,
      onProgress: value => progress.report(value),
      onEncoderFallback: err => deps.log(`[export ${clipId}] ${encoderFallbackMessage(err)}`),
    })
    throwIfAborted(signal)

    repos.clips.update(clipId, {
      status: 'done',
      progress: 1,
      error: null,
      fileName: files.names.mp4,
      srtFileName: files.names.srt,
      finishedAt: new Date().toISOString(),
    })
  }
  catch (err) {
    await Promise.all([files.mp4, files.srt, files.ass].map(removeQuietly))
    const kind = abortKind(signal)
    if (kind === 'shutdown') return
    const message = kind === 'cancel' ? CANCELLED_MESSAGE : readableError(err, '輸出剪輯')
    if (kind !== 'cancel') deps.log(`[export ${clipId}] 失敗：${message}`)
    repos.clips.update(clipId, { status: 'failed', error: message })
  }
}

export class ExportQueue implements JobQueue {
  readonly deps: JobDeps
  private readonly worker: SerialWorker<ClipRecord>

  constructor(input: JobDepsInput) {
    this.deps = resolveDeps(input)
    this.worker = new SerialWorker<ClipRecord>({
      name: 'export',
      next: () => this.deps.repos.clips.nextQueued(),
      ownerOf: clip => clip.videoId,
      run: (clip, signal) => runExport(this.deps, clip.id, signal),
      log: this.deps.log,
    })
  }

  /** Id of the clip being exported right now. */
  get runningClipId(): string | null {
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

  /** New clips are inserted as 'queued'; this only wakes the worker. */
  enqueue(_clipId?: string): void {
    this.kick()
  }

  async cancel(videoId: string): Promise<void> {
    const { clips } = this.deps.repos
    for (const clip of clips.listByVideo(videoId)) {
      if (clip.status === 'queued') clips.update(clip.id, { status: 'failed', error: CANCELLED_MESSAGE })
    }
    await this.worker.cancel(videoId)
  }

  async recover(): Promise<string[]> {
    const { clips } = this.deps.repos
    const recovered: ClipRecord[] = []
    for (const clip of clips.listByStatus('running')) {
      if (clip.id === this.runningClipId) continue
      clips.update(clip.id, { status: 'queued', progress: 0, error: null })
      recovered.push(clip)
    }
    for (const clip of recovered) {
      await removeLeftovers(clipFiles(this.deps, clip).dir, [`${clip.id}.tmp-`, `${clip.id}.srt.tmp-`, `${clip.id}.ass.tmp-`])
    }
    return recovered.map(c => c.id)
  }

  whenIdle(): Promise<void> {
    return this.worker.whenIdle()
  }
}
