// Steps of an Analysis per mode, their progress weights, labels and work files (design.md「分析」).
import path from 'node:path'
import type { AnalysisMode, AnalysisStep, Language, SourceKind } from '../../../shared/types/domain'
import { videoWorkDir } from '../config'
import type { StepProgress } from './progress'
import type { JobDeps } from './types'

export type StepWeights = ReadonlyArray<readonly [AnalysisStep, number]>

/** Step weights of the overall progress per mode (design.md). Each list sums to 1. */
export const ANALYSIS_STEPS: Readonly<Record<AnalysisMode, StepWeights>> = {
  full: [
    ['probe', 0.02],
    ['extract-audio', 0.05],
    ['transcribe', 0.6],
    ['prepare-preview', 0.1],
    ['signals', 0.21],
    ['candidates', 0.02],
  ],
  highlights: [
    ['extract-audio', 0.1],
    ['signals', 0.85],
    ['candidates', 0.05],
  ],
}

/**
 * A YouTube video's 'full' run (design.md「YouTube」→「下載」): download first. Two tables, chosen at the
 * start of the run: `download` when the video file has to be downloaded, `present` when the file from
 * an earlier download is still on disk (the step then only reads the metadata and the chat replay).
 */
export const YOUTUBE_FULL_STEPS: Readonly<{ download: StepWeights, present: StepWeights }> = {
  download: [
    ['download', 0.2],
    ['probe', 0.01],
    ['extract-audio', 0.04],
    ['transcribe', 0.48],
    ['prepare-preview', 0.07],
    ['signals', 0.18],
    ['candidates', 0.02],
  ],
  present: [
    ['download', 0.02],
    ['probe', 0.02],
    ['extract-audio', 0.05],
    ['transcribe', 0.58],
    ['prepare-preview', 0.1],
    ['signals', 0.21],
    ['candidates', 0.02],
  ],
}

/** The step table of one run. `fileOnDisk`: the video's filePath is set and is a file (only matters for YouTube 'full'). */
export function analysisSteps(mode: AnalysisMode, sourceKind: SourceKind, fileOnDisk: boolean): StepWeights {
  if (mode === 'full' && sourceKind === 'youtube') return fileOnDisk ? YOUTUBE_FULL_STEPS.present : YOUTUBE_FULL_STEPS.download
  return ANALYSIS_STEPS[mode]
}

/** Progress inside the signals step: loudness first, then the LLM reading the Transcript (by chunks read). */
export const SIGNALS_STEP_SHARES = { loudness: 0.1, transcript: 0.9 } as const

/**
 * A YouTube video's 'highlights' run reads the metadata again (and maybe the chat replay) at the start
 * of the signals step: YouTube data 10 %, loudness 10 %, the LLM 80 %.
 */
export const YOUTUBE_HIGHLIGHTS_SIGNALS_STEP_SHARES = { youtube: 0.1, loudness: 0.1, transcript: 0.8 } as const

/** Progress inside the download step: metadata 3 %, video file 85 %, chat replay 12 %. */
export const DOWNLOAD_STEP_SHARES = { metadata: 0.03, video: 0.85, chat: 0.12 } as const

/** Context of failure messages ("<label>失敗：…"); the same names as the UI's step labels. */
export const STEP_LABELS: Record<AnalysisStep, string> = {
  'download': '下載影片',
  'probe': '讀取影片資訊',
  'extract-audio': '擷取音訊',
  'transcribe': '語音辨識',
  'prepare-preview': '準備預覽',
  'signals': '分析訊號',
  'candidates': '找出精華片段',
}

export function analysisFiles(deps: Pick<JobDeps, 'config'>, videoId: string) {
  const dir = videoWorkDir(deps.config, videoId)
  return {
    dir,
    audio: path.join(dir, 'audio.wav'),
    rawTranscript: path.join(dir, 'transcript.raw.json'),
    preview: path.join(dir, 'preview.mp4'),
    signals: path.join(dir, 'signals.json'),
  }
}

export type AnalysisFiles = ReturnType<typeof analysisFiles>

/** File-name prefixes an interrupted run can leave in the work folder (audio, temp files of atomic writes). */
export const LEFTOVER_PREFIXES = ['audio.', 'preview.tmp-', 'signals.tmp-']

/** What every step of one run needs. */
export interface AnalysisRun {
  deps: JobDeps
  videoId: string
  sourceKind: SourceKind
  language: Language
  /** The video file; the download step sets it once a YouTube download finishes. */
  filePath: string | null
  audioTrack: number
  files: AnalysisFiles
  signal: AbortSignal
  progress: StepProgress<AnalysisStep>
  /** deps.log with the "[analysis <id>]" prefix. */
  log: (message: string) => void
}
