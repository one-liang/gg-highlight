// Analysis helpers for the video page: modes, re-analysis, Signals and the messages around them.
import {
  ANALYSIS_VERSION,
  type AnalysisMode,
  type AnalysisState,
  CANCELLED_MESSAGE,
  type Highlight,
  type SignalKind,
  type SignalState,
  type SourceVideo,
  TRANSCRIPT_SIGNAL_DISABLED_REASON,
  TRANSCRIPT_SIGNAL_EMPTY_REASON,
  type TranscriptSegment,
} from '../../shared/types/domain'
import { analysisStepLabel, SIGNAL_ORDER, signalLabels } from './labels'

type WithAnalysis = Pick<SourceVideo, 'analysis'>

/**
 * The Transcript, Highlights and Clips can be used (mirrors the server's transcriptReady): the
 * Analysis is done; or the current / last run only finds highlights (it keeps the Transcript, so it
 * may be queued, running or failed); or a 'full' re-run failed or was cancelled after an earlier
 * Analysis finished (version is set), which leaves a complete Transcript, the Highlights and Clips.
 */
export function isTranscriptReady(video: WithAnalysis): boolean {
  const { status, mode, version } = video.analysis
  return status === 'done' || mode === 'highlights' || (status === 'failed' && version !== null)
}

/**
 * 「重新分析」 is offered for a done Analysis, a failed highlights-only run, and a failed 'full'
 * re-run of a video analysed before (design.md「重新分析」). A failed first Analysis is retried instead.
 */
export function canReanalyze(video: WithAnalysis): boolean {
  const { status, mode, version } = video.analysis
  return status === 'done' || (status === 'failed' && (mode === 'highlights' || version !== null))
}

/** A 'full' re-run failed or was cancelled, but an earlier Analysis had finished: the workspace stays. */
export function isFailedRerun(video: WithAnalysis): boolean {
  const { status, mode, version } = video.analysis
  return status === 'failed' && mode === 'full' && version !== null
}

/** Done by an older pipeline (milestone 1 had no candidates): show 「這支影片分析時還沒有自動找精華」. */
export function needsHighlightsUpgrade(video: WithAnalysis): boolean {
  return video.analysis.status === 'done' && (video.analysis.version ?? 1) < ANALYSIS_VERSION
}

export function countEditedSegments(segments: readonly Pick<TranscriptSegment, 'edited'>[]): number {
  return segments.reduce((n, s) => n + (s.edited ? 1 : 0), 0)
}

/**
 * The last run's transcript Signal was missing for a reason the user can fix (Ollama not running,
 * outdated, no model, every chunk failed): once fixed, 只重新找精華片段 fills it in.
 */
export function transcriptSignalFixable(signals: readonly SignalState[] | null | undefined): boolean {
  const transcript = signals?.find(s => s.kind === 'transcript')
  if (transcript?.status !== 'missing') return false
  const reason = transcript.reason?.trim()
  return reason !== TRANSCRIPT_SIGNAL_DISABLED_REASON && reason !== TRANSCRIPT_SIGNAL_EMPTY_REASON
}

/**
 * Preselected re-analysis mode (design.md「重新分析」): keep the Transcript when the user changed any
 * segment (unknown = the Transcript could not be read: keep it, so no edit is lost by default), when
 * the source file is missing (it cannot be transcribed again), or when the AI Signal was missing last
 * time for a fixable reason (re-transcribing would not help); otherwise transcribe again.
 */
export function defaultReanalyzeMode(
  video: Pick<SourceVideo, 'analysis' | 'fileMissing'>,
  editedSegments: number | null,
): AnalysisMode {
  if (editedSegments === null || editedSegments > 0) return 'highlights'
  if (video.fileMissing || transcriptSignalFixable(video.analysis.signals)) return 'highlights'
  return 'full'
}

/** Shown in the re-analysis dialog when 'full' cannot be chosen (the API answers 422). */
export const FULL_NEEDS_SOURCE_MESSAGE = '找不到原始影片檔，無法重新辨識語音'

export interface SignalNote {
  kind: SignalKind
  /** true = the Signal was missing this time; false = used, with a caveat. */
  missing: boolean
  text: string
}

export interface SignalSummary {
  /** "音量、逐字稿（AI）"; '' when no Signal was used. */
  used: string
  notes: SignalNote[]
}

function signalRank(kind: SignalKind): number {
  const i = SIGNAL_ORDER.indexOf(kind)
  return i < 0 ? SIGNAL_ORDER.length : i
}

/** What to do once the cause of a missing transcript Signal is fixed. */
export const REFILL_TRANSCRIPT_HINT = '；處理好之後按「重新分析」→「只重新找精華片段」'

/**
 * 「這次的候選依據」: the used Signals and a note per missing one (with its reason, and the next step
 * when it can be fixed) or caveat; null before any run.
 */
export function summarizeSignals(signals: readonly SignalState[] | null | undefined): SignalSummary | null {
  if (!signals) return null
  const sorted = signals.slice().sort((a, b) => signalRank(a.kind) - signalRank(b.kind))
  const used = sorted.filter(s => s.status === 'used').map(s => signalLabels[s.kind] ?? s.kind)
  const notes: SignalNote[] = []
  for (const s of sorted) {
    const label = signalLabels[s.kind] ?? s.kind
    const reason = s.reason?.trim()
    if (s.status === 'missing') {
      const next = s.kind === 'transcript' && transcriptSignalFixable([s]) ? REFILL_TRANSCRIPT_HINT : ''
      notes.push({ kind: s.kind, missing: true, text: `${label}沒有用到${reason ? `：${reason}` : ''}${next}` })
    }
    else if (reason) notes.push({ kind: s.kind, missing: false, text: `${label}：${reason}` })
  }
  return { used: used.join('、'), notes }
}

/** Candidates the analysis found (what the completion notice counts). */
export function countCandidates(highlights: readonly Pick<Highlight, 'origin' | 'status'>[]): number {
  return highlights.reduce((n, h) => n + (h.origin === 'analysis' && h.status === 'candidate' ? 1 : 0), 0)
}

export interface NoticeText {
  title: string
  description?: string
}

/** Toast when the Analysis being watched finishes; `candidates` is null when the count could not be read. */
export function analysisDoneNotice(mode: AnalysisMode | undefined, candidates: number | null): NoticeText {
  const title = mode === 'highlights' ? '找精華片段完成' : '分析完成'
  if (candidates === null) {
    return { title, description: mode === 'highlights' ? '新的候選精華片段在「候選」分頁。' : '可以開始修改逐字稿、挑選精華片段了。' }
  }
  if (candidates === 0) return { title, description: '這次沒有找到候選精華片段，可以自己標出想剪的段落。' }
  return { title, description: `找到 ${candidates} 個候選精華片段，可以到「候選」分頁挑選。` }
}

/** Title of the failed-run toast and alert: which run failed, or was cancelled. */
export function analysisFailedTitle(analysis: Pick<AnalysisState, 'mode' | 'version' | 'error'> | undefined): string {
  const cancelled = analysis?.error === CANCELLED_MESSAGE
  if (analysis?.mode === 'highlights') return cancelled ? '已取消找精華片段' : '找精華片段失敗'
  if (analysis?.version !== null && analysis?.version !== undefined) return cancelled ? '已取消重新分析' : '重新分析失敗'
  return cancelled ? '已取消分析' : '分析失敗'
}

/**
 * Lines under the error of a failed run whose workspace stays usable (isTranscriptReady): a failed
 * highlights-only run, or a failed / cancelled 'full' re-run (whose 重試 transcribes again).
 */
export function failedRunFootnote(video: WithAnalysis): string[] {
  if (!isFailedRerun(video)) return ['逐字稿、精華片段與剪輯不受影響，可以照常使用。']
  return [
    '逐字稿、精華片段與剪輯照常可以看、改、輸出。',
    '「重試」會再重新辨識語音一次，之後改過的逐字稿會被覆蓋；只想更新候選精華片段，請按「重新分析」→「只重新找精華片段」。',
  ]
}

/** Toast after 「重新分析」/「找精華片段」 queued a run. */
export function reanalyzeStartedNotice(mode: AnalysisMode): NoticeText {
  return mode === 'highlights'
    ? { title: '已開始找精華片段', description: '逐字稿、精華片段與剪輯照常可以使用，完成後會通知你。' }
    : { title: '已開始重新分析', description: '會重新辨識語音，完成前看不到逐字稿、精華片段與剪輯。' }
}

export interface ProgressText {
  title: string
  hint: string
  footer: string
}

/** Texts of the progress card, by mode and step. */
export function analysisProgressText(video: WithAnalysis): ProgressText {
  const { status, step, mode } = video.analysis
  const highlightsOnly = mode === 'highlights'
  const footer = highlightsOnly
    ? '逐字稿、精華片段與剪輯照常可以看、改、輸出；也可以關掉這個頁面，稍後再回來查看。'
    : '分析在背景進行，可以關掉這個頁面，稍後再回來查看。'
  if (status === 'queued') {
    return {
      title: highlightsOnly ? '排隊等待找精華片段' : '排隊等待分析',
      hint: '一次只分析一支影片，前面的影片完成後就會自動開始。',
      footer,
    }
  }
  const label = analysisStepLabel(step)
  const title = label ? `正在${label}` : highlightsOnly ? '正在找精華片段' : '分析中'
  let hint: string
  if (step === 'transcribe') hint = '語音辨識最花時間，長影片可能需要數分鐘到數十分鐘。'
  else if (step === 'signals') hint = '本機 AI 正在讀逐字稿，長影片可能要幾分鐘。'
  else if (highlightsOnly) hint = '完成後新的候選精華片段會出現在「候選」分頁。'
  else hint = '完成後就能看逐字稿、挑選精華片段並輸出剪輯。'
  return { title, hint, footer }
}
