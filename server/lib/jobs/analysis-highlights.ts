// The Signals and candidates steps of an Analysis (design.md「訊號」「候選精華片段」), shared by both modes.
import fs from 'node:fs/promises'
import { ANALYSIS_VERSION } from '../../../shared/types/domain'
import type { MediaInfo, SignalState } from '../../../shared/types/domain'
import { buildCandidates } from '../highlights'
import { readTranscriptWithLlm } from '../llm'
import type { TranscriptSignalResult } from '../llm'
import { extractAudio } from '../media'
import { coverageMask, loudnessTrack, momentsTrack, readLoudnessEnvelope, readSignalsFile, writeSignalsFile } from '../signals'
import type { LoudnessEnvelope, NamedTrack, SignalsFile } from '../signals'
import { SIGNALS_STEP_SHARES, YOUTUBE_HIGHLIGHTS_SIGNALS_STEP_SHARES } from './analysis-steps'
import type { AnalysisRun } from './analysis-steps'
import { refreshYoutubeData, youtubeSignals } from './analysis-youtube'
import type { YoutubeRunData, YoutubeSignals, YoutubeSource } from './analysis-youtube'
import { MISSING_DOWNLOAD_MESSAGE, MISSING_SOURCE_MESSAGE, readableError } from './errors'
import { isFile } from './files'
import { throwIfAborted } from './worker'

/** Where this run's loudness comes from. */
export type LoudnessInput =
  | { kind: 'cached', envelope: LoudnessEnvelope }
  | { kind: 'wav', path: string }
  | { kind: 'missing', reason: string }

/** Where a YouTube video's chat / heatmap data comes from in the signals step. */
export type YoutubeSignalsInput =
  /** 'full': read by the download step. */
  | { kind: 'downloaded', data: YoutubeRunData }
  /** 'highlights': read again at the start of the signals step (never downloads the video file). */
  | { kind: 'refresh', source: YoutubeSource }

export interface SignalsOutcome {
  envelope: LoudnessEnvelope | null
  transcript: TranscriptSignalResult
  /** Shown as「這次的候選依據」: loudness, transcript, and for YouTube videos chat and heatmap. */
  states: SignalState[]
  /** YouTube videos: per-second chat density when the chat Signal is used. */
  chat?: Float32Array | null
  /** YouTube videos: per-second replay heatmap (with its coverage) when the heatmap Signal is used. */
  heatmap?: YoutubeSignals['heatmap']
}

/** Progress shares inside the signals step (youtube: the 'highlights' refresh of a YouTube video, else 0). */
interface SignalsShares {
  youtube: number
  loudness: number
  transcript: number
}

function rethrowIfAborted(run: AnalysisRun, err: unknown): void {
  if (run.signal.aborted) throw err
}

/**
 * 'highlights' mode, extract-audio step: reuse the loudness in signals.json when there is one,
 * else extract audio.wav from the source. A missing source file or a failed extraction only makes
 * the loudness Signal 'missing'; the run goes on with the Transcript.
 */
export async function loudnessForHighlights(run: AnalysisRun, media: MediaInfo): Promise<LoudnessInput> {
  const cached = await readSignalsFile(run.files.signals)
  if (cached?.loudness) {
    run.log('沿用上次分析的音量資料，不重新擷取音訊')
    return { kind: 'cached', envelope: cached.loudness }
  }
  const filePath = run.filePath
  if (!filePath || !(await isFile(filePath))) {
    // 'highlights' never downloads a YouTube video's file again.
    const reason = run.sourceKind === 'youtube' ? MISSING_DOWNLOAD_MESSAGE : MISSING_SOURCE_MESSAGE
    run.log(`${reason}，這次不用音量找精華`)
    return { kind: 'missing', reason }
  }
  try {
    await fs.mkdir(run.files.dir, { recursive: true })
    await extractAudio(run.deps.tools, { filePath, audioTrack: run.audioTrack, durationSec: media.durationSec }, run.files.audio, {
      signal: run.signal,
      onProgress: fraction => run.progress.update(fraction),
    })
    return { kind: 'wav', path: run.files.audio }
  }
  catch (err) {
    rethrowIfAborted(run, err)
    const reason = readableError(err, '擷取音訊')
    run.log(`${reason}，這次不用音量找精華`)
    return { kind: 'missing', reason }
  }
}

function signalState(kind: SignalState['kind'], status: SignalState['status'], reason: string | null = null): SignalState {
  return { kind, status, reason }
}

async function loudnessSignal(run: AnalysisRun, input: LoudnessInput, shares: SignalsShares): Promise<{ envelope: LoudnessEnvelope | null, state: SignalState }> {
  if (input.kind === 'cached') return { envelope: input.envelope, state: signalState('loudness', 'used') }
  if (input.kind === 'missing') return { envelope: null, state: signalState('loudness', 'missing', input.reason) }
  try {
    const envelope = await readLoudnessEnvelope(input.path, {
      signal: run.signal,
      onProgress: fraction => run.progress.update(shares.youtube + shares.loudness * fraction),
    })
    return { envelope, state: signalState('loudness', 'used') }
  }
  catch (err) {
    rethrowIfAborted(run, err)
    const reason = readableError(err, '讀取音量')
    run.log(`${reason}，這次不用音量找精華`)
    return { envelope: null, state: signalState('loudness', 'missing', reason) }
  }
}

/** The LLM reads the current Transcript text (with the user's edits). Rejects only on cancel / shutdown. */
function transcriptSignal(run: AnalysisRun, shares: SignalsShares): Promise<TranscriptSignalResult> {
  const { deps } = run
  const lines = deps.repos.transcript.list(run.videoId).map(({ start, end, text }) => ({ start, end, text }))
  const base = shares.youtube + shares.loudness
  return readTranscriptWithLlm(deps.config.ollama, lines, {
    signal: run.signal,
    onProgress: fraction => run.progress.update(base + shares.transcript * fraction),
    log: run.log,
    language: run.language,
    fetch: deps.fetch,
  })
}

/**
 * signals.json is only a cache (loudness reuse in 'highlights' runs, the last YouTube heatmap when it
 * cannot be read again): a failed write is logged, not fatal.
 */
async function saveSignals(run: AnalysisRun, envelope: LoudnessEnvelope | null, transcript: TranscriptSignalResult, heatmap: SignalsFile['heatmap']): Promise<void> {
  try {
    await writeSignalsFile(run.files.signals, {
      version: 2,
      loudness: envelope,
      transcript: transcript.state.status === 'used' ? { model: transcript.model, moments: transcript.moments } : null,
      heatmap,
    })
  }
  catch (err) {
    run.log(`無法寫入 signals.json：${(err as Error).message}`)
  }
}

/**
 * The signals step: loudness (10 %), for YouTube videos chat density and the replay heatmap, then the
 * LLM over the Transcript (90 %); writes signals.json. A YouTube video's 'highlights' run first reads
 * the metadata again (10 %, the LLM then 80 %). `durationSec`: length of the tracks (the probed length).
 */
export async function computeSignals(run: AnalysisRun, input: LoudnessInput, durationSec: number, youtube: YoutubeSignalsInput | null = null): Promise<SignalsOutcome> {
  run.progress.step('signals')
  const shares: SignalsShares = youtube?.kind === 'refresh' ? YOUTUBE_HIGHLIGHTS_SIGNALS_STEP_SHARES : { youtube: 0, ...SIGNALS_STEP_SHARES }
  let data: YoutubeRunData | null = null
  if (youtube?.kind === 'refresh') data = await refreshYoutubeData(run, youtube.source, fraction => run.progress.update(shares.youtube * fraction))
  else if (youtube) data = youtube.data
  throwIfAborted(run.signal)

  const loudness = await loudnessSignal(run, input, shares)
  throwIfAborted(run.signal)
  run.progress.update(shares.youtube + shares.loudness)
  let extra: YoutubeSignals | null = null
  if (data) {
    const previous = (await readSignalsFile(run.files.signals))?.heatmap ?? null
    extra = await youtubeSignals(run, data, durationSec, previous)
  }
  const transcript = await transcriptSignal(run, shares)
  throwIfAborted(run.signal)
  await saveSignals(run, loudness.envelope, transcript, extra?.heatmapFile ?? null)
  return {
    envelope: loudness.envelope,
    transcript,
    states: [loudness.state, transcript.state, ...(extra?.states ?? [])],
    chat: extra?.chat ?? null,
    heatmap: extra?.heatmap ?? null,
  }
}

/**
 * Per-second tracks of the Signals used this run; a missing Signal is left out (no penalty), and so
 * are the stretches of the Transcript the LLM could not read (a skipped chunk is not "nothing found").
 */
export function signalTracks(outcome: SignalsOutcome, durationSec: number): NamedTrack[] {
  const tracks: NamedTrack[] = []
  if (outcome.envelope) tracks.push({ kind: 'loudness', values: loudnessTrack(outcome.envelope, durationSec) })
  const { transcript } = outcome
  if (transcript.state.status === 'used') {
    const track: NamedTrack = { kind: 'transcript', values: momentsTrack(transcript.moments, durationSec) }
    if (transcript.unread.length > 0) track.covered = coverageMask(transcript.unread, durationSec)
    tracks.push(track)
  }
  if (outcome.chat) tracks.push({ kind: 'chat', values: outcome.chat })
  // The heatmap has no value past its last bucket (covered 0): those seconds leave it out of the weighting.
  if (outcome.heatmap) tracks.push({ kind: 'heatmap', values: outcome.heatmap.values, covered: outcome.heatmap.covered })
  return tracks
}

/**
 * The candidates step: records the Signals, builds candidates around the Highlights the user keeps,
 * and replaces the old candidates in one transaction. Returns how many were stored.
 */
export function storeCandidates(run: AnalysisRun, outcome: SignalsOutcome, durationSec: number): number {
  const { repos } = run.deps
  run.progress.step('candidates')
  repos.videos.updateAnalysis(run.videoId, { signals: outcome.states })
  const segments = repos.transcript.list(run.videoId)
    .map(({ start, end }) => ({ start, end }))
    .sort((a, b) => a.start - b.start)
  const occupied = repos.highlights.listKept(run.videoId).map(({ start, end }) => ({ start, end }))
  const drafts = buildCandidates({
    durationSec,
    segments,
    tracks: signalTracks(outcome, durationSec),
    moments: outcome.transcript.moments,
    occupied,
  })
  throwIfAborted(run.signal)
  const stored = repos.highlights.replaceAnalysisCandidates(run.videoId, drafts)
  run.log(`找到 ${stored.length} 個候選精華片段（${describeSignals(outcome.states)}）`)
  return stored.length
}

/** "音量、逐字稿" style summary of the Signals used, for the log. */
function describeSignals(states: SignalState[]): string {
  const names: Record<SignalState['kind'], string> = { loudness: '音量', transcript: '逐字稿', chat: '聊天室', heatmap: '重播熱度' }
  const used = states.filter(s => s.status === 'used').map(s => names[s.kind])
  return used.length > 0 ? `依據${used.join('、')}` : '沒有可用的訊號'
}

/** Final write of a successful run. */
export function finishAnalysis(run: AnalysisRun): void {
  run.deps.repos.videos.updateAnalysis(run.videoId, { status: 'done', step: null, progress: 1, error: null, version: ANALYSIS_VERSION })
}
