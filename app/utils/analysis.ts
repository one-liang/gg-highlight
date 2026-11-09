// Analysis helpers for the video page: modes, re-analysis, Signals and the messages around them.
import {
  ANALYSIS_VERSION,
  type AnalysisMode,
  type Highlight,
  type SignalKind,
  type SignalState,
  type SourceVideo,
  type TranscriptSegment,
} from '../../shared/types/domain'
import { analysisStepLabel, SIGNAL_ORDER, signalLabels } from './labels'

type WithAnalysis = Pick<SourceVideo, 'analysis'>

/**
 * The Transcript, Highlights and Clips can be used: the Analysis is done, or the current / last
 * run only finds highlights (it keeps the Transcript, so it may be queued, running or failed).
 */
export function isTranscriptReady(video: WithAnalysis): boolean {
  return video.analysis.status === 'done' || video.analysis.mode === 'highlights'
}

/** 「重新分析」 is offered for a done Analysis, or a failed highlights-only run (design.md「重新分析」). */
export function canReanalyze(video: WithAnalysis): boolean {
  const { status, mode } = video.analysis
  return status === 'done' || (status === 'failed' && mode === 'highlights')
}

/** Done by an older pipeline (milestone 1 had no candidates): show 「這支影片分析時還沒有自動找精華」. */
export function needsHighlightsUpgrade(video: WithAnalysis): boolean {
  return video.analysis.status === 'done' && (video.analysis.version ?? 1) < ANALYSIS_VERSION
}

export function countEditedSegments(segments: readonly Pick<TranscriptSegment, 'edited'>[]): number {
  return segments.reduce((n, s) => n + (s.edited ? 1 : 0), 0)
}

/**
 * Preselected re-analysis mode: keep the Transcript when the user changed any segment, otherwise
 * transcribe again. Unknown (the Transcript could not be read) keeps it, so no edit is lost by default.
 */
export function defaultReanalyzeMode(editedSegments: number | null): AnalysisMode {
  return editedSegments === null || editedSegments > 0 ? 'highlights' : 'full'
}

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

/** 「這次的候選依據」: the used Signals and a note per missing one (with its reason) or caveat; null before any run. */
export function summarizeSignals(signals: readonly SignalState[] | null | undefined): SignalSummary | null {
  if (!signals) return null
  const sorted = signals.slice().sort((a, b) => signalRank(a.kind) - signalRank(b.kind))
  const used = sorted.filter(s => s.status === 'used').map(s => signalLabels[s.kind] ?? s.kind)
  const notes: SignalNote[] = []
  for (const s of sorted) {
    const label = signalLabels[s.kind] ?? s.kind
    const reason = s.reason?.trim()
    if (s.status === 'missing') notes.push({ kind: s.kind, missing: true, text: `${label}沒有用到${reason ? `：${reason}` : ''}` })
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

export function analysisFailedTitle(mode: AnalysisMode | undefined): string {
  return mode === 'highlights' ? '找精華片段失敗' : '分析失敗'
}

/** Toast after 「重新分析」/「找精華片段」 queued a run. */
export function reanalyzeStartedNotice(mode: AnalysisMode): NoticeText {
  return mode === 'highlights'
    ? { title: '已開始找精華片段', description: '逐字稿、精華片段與剪輯照常可以使用，完成後會通知你。' }
    : { title: '已開始重新分析', description: '會重新辨識語音，完成前不能修改逐字稿或輸出剪輯。' }
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
