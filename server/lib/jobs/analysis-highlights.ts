// The Signals and candidates steps of an Analysis (design.md「訊號」「候選精華片段」), shared by both modes.
import fs from 'node:fs/promises'
import { ANALYSIS_VERSION } from '../../../shared/types/domain'
import type { MediaInfo, SignalState } from '../../../shared/types/domain'
import { buildCandidates } from '../highlights'
import { readTranscriptWithLlm } from '../llm'
import type { TranscriptSignalResult } from '../llm'
import { extractAudio } from '../media'
import { loudnessTrack, momentsTrack, readLoudnessEnvelope, readSignalsFile, writeSignalsFile } from '../signals'
import type { LoudnessEnvelope, NamedTrack } from '../signals'
import { SIGNALS_STEP_SHARES } from './analysis-steps'
import type { AnalysisRun } from './analysis-steps'
import { MISSING_SOURCE_MESSAGE, readableError } from './errors'
import { isFile } from './files'
import { throwIfAborted } from './worker'

/** Where this run's loudness comes from. */
export type LoudnessInput =
  | { kind: 'cached', envelope: LoudnessEnvelope }
  | { kind: 'wav', path: string }
  | { kind: 'missing', reason: string }

export interface SignalsOutcome {
  envelope: LoudnessEnvelope | null
  transcript: TranscriptSignalResult
  /** Shown as「這次的候選依據」. */
  states: SignalState[]
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
    run.log(`${MISSING_SOURCE_MESSAGE}，這次不用音量找精華`)
    return { kind: 'missing', reason: MISSING_SOURCE_MESSAGE }
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

async function loudnessSignal(run: AnalysisRun, input: LoudnessInput): Promise<{ envelope: LoudnessEnvelope | null, state: SignalState }> {
  if (input.kind === 'cached') return { envelope: input.envelope, state: signalState('loudness', 'used') }
  if (input.kind === 'missing') return { envelope: null, state: signalState('loudness', 'missing', input.reason) }
  try {
    const envelope = await readLoudnessEnvelope(input.path, {
      signal: run.signal,
      onProgress: fraction => run.progress.update(SIGNALS_STEP_SHARES.loudness * fraction),
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
function transcriptSignal(run: AnalysisRun): Promise<TranscriptSignalResult> {
  const { deps } = run
  const lines = deps.repos.transcript.list(run.videoId).map(({ start, end, text }) => ({ start, end, text }))
  const base = SIGNALS_STEP_SHARES.loudness
  return readTranscriptWithLlm(deps.config.ollama, lines, {
    signal: run.signal,
    onProgress: fraction => run.progress.update(base + SIGNALS_STEP_SHARES.transcript * fraction),
    log: run.log,
    language: run.language,
    fetch: deps.fetch,
  })
}

/** signals.json is only a cache (loudness reuse in 'highlights' runs): a failed write is logged, not fatal. */
async function saveSignals(run: AnalysisRun, envelope: LoudnessEnvelope | null, transcript: TranscriptSignalResult): Promise<void> {
  try {
    await writeSignalsFile(run.files.signals, {
      version: 1,
      loudness: envelope,
      transcript: transcript.state.status === 'used' ? { model: transcript.model, moments: transcript.moments } : null,
    })
  }
  catch (err) {
    run.log(`無法寫入 signals.json：${(err as Error).message}`)
  }
}

/** The signals step: loudness (10 %), then the LLM over the Transcript (90 %); writes signals.json. */
export async function computeSignals(run: AnalysisRun, input: LoudnessInput): Promise<SignalsOutcome> {
  run.progress.step('signals')
  const loudness = await loudnessSignal(run, input)
  throwIfAborted(run.signal)
  run.progress.update(SIGNALS_STEP_SHARES.loudness)
  const transcript = await transcriptSignal(run)
  throwIfAborted(run.signal)
  await saveSignals(run, loudness.envelope, transcript)
  return { envelope: loudness.envelope, transcript, states: [loudness.state, transcript.state] }
}

/** Per-second tracks of the Signals used this run; a missing Signal is left out (no penalty). */
export function signalTracks(outcome: SignalsOutcome, durationSec: number): NamedTrack[] {
  const tracks: NamedTrack[] = []
  if (outcome.envelope) tracks.push({ kind: 'loudness', values: loudnessTrack(outcome.envelope, durationSec) })
  if (outcome.transcript.state.status === 'used') {
    tracks.push({ kind: 'transcript', values: momentsTrack(outcome.transcript.moments, durationSec) })
  }
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
