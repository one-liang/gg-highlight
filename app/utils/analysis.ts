// Analysis helpers for the video page: modes, re-analysis, Signals and the messages around them.
import {
  ANALYSIS_VERSION,
  type AnalysisMode,
  type AnalysisState,
  CANCELLED_MESSAGE,
  type Highlight,
  type SignalKind,
  type SignalState,
  type SourceKind,
  type SourceVideo,
  TRANSCRIPT_SIGNAL_DISABLED_REASON,
  TRANSCRIPT_SIGNAL_EMPTY_REASON,
  type TranscriptSegment,
} from '../../shared/types/domain'
import { analysisStepLabel, MISSING_DOWNLOAD_LABEL, MISSING_FILE_LABEL, SIGNAL_ORDER, signalLabels, signalNamesFor } from './labels'

type WithAnalysis = Pick<SourceVideo, 'analysis'>
/** sourceKind is optional: without it the local-file texts apply. */
type WithSource = { sourceKind?: SourceKind }

function isYoutube(video: WithSource): boolean {
  return video.sourceKind === 'youtube'
}

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

/** Body of the 「這支影片分析時還沒有自動找精華」 banner, naming the video's Signals. */
export function highlightsUpgradeDescription(video: WithSource): string {
  const signals = isYoutube(video) ? '音量、逐字稿（本機 AI）、聊天室與重播熱度' : '音量與逐字稿（本機 AI）'
  return `現在可以依${signals}自動找出候選精華片段。「找精華片段」會保留逐字稿與你的修改；「重新分析全部」會重新辨識語音，順便套用新版的逐字稿清理。`
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
 * the source file is missing (a local file cannot be transcribed again; a YouTube video would have to
 * be downloaded again, so 'full' stays available but is not preselected), or when the AI Signal was
 * missing last time for a fixable reason (re-transcribing would not help); otherwise transcribe again.
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

/** Shown under 'full' for a YouTube video whose downloaded file is gone: the download step fetches it again. */
export const FULL_REDOWNLOAD_MESSAGE = '會重新從 YouTube 下載影片'

/**
 * 'full' can run: the source file is there, or it is a YouTube video (the download step downloads a
 * missing file again). Mirrors the server's reanalyze / retry check.
 */
export function canRunFull(video: Pick<SourceVideo, 'fileMissing'> & WithSource): boolean {
  return !video.fileMissing || isYoutube(video)
}

export interface ReanalyzeOption {
  value: AnalysisMode
  title: string
  description: string
  disabled: boolean
  /** Line under the description: why it is disabled (warning) or what else it does (info). */
  note: { text: string, tone: 'warning' | 'info' } | null
}

/** The two choices of the re-analysis dialog, for this video. */
export function reanalyzeOptions(video: Pick<SourceVideo, 'fileMissing'> & WithSource): ReanalyzeOption[] {
  const fullOk = canRunFull(video)
  let fullNote: ReanalyzeOption['note'] = null
  if (!fullOk) fullNote = { text: FULL_NEEDS_SOURCE_MESSAGE, tone: 'warning' }
  else if (video.fileMissing) fullNote = { text: FULL_REDOWNLOAD_MESSAGE, tone: 'info' }
  return [
    {
      value: 'highlights',
      title: '只重新找精華片段',
      description: `保留逐字稿與你的修改，只重新計算${signalNamesFor(video.sourceKind)}訊號、產生新的候選，通常幾分鐘內完成。執行期間逐字稿、精華片段與剪輯照常可以使用。`,
      disabled: false,
      note: null,
    },
    {
      value: 'full',
      title: '重新辨識語音並找精華',
      description: '逐字稿重新產生，你的修改會被覆蓋。要套用新版的逐字稿清理（例如重複出現的字）時用這個。完成前看不到逐字稿、精華片段與剪輯。',
      disabled: !fullOk,
      note: fullNote,
    },
  ]
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
 * highlights-only run, or a failed / cancelled 'full' re-run (whose 重試 transcribes again). Without
 * the source file nothing can be previewed or exported, so they do not promise that.
 */
export function failedRunFootnote(video: Pick<SourceVideo, 'analysis' | 'fileMissing'> & WithSource): string[] {
  if (!isFailedRerun(video)) {
    return [video.fileMissing ? '逐字稿與精華片段不受影響，可以照常查看與修改。' : '逐字稿、精華片段與剪輯不受影響，可以照常使用。']
  }
  const redownload = video.fileMissing && isYoutube(video)
  let first = '逐字稿、精華片段與剪輯照常可以看、改、輸出。'
  if (redownload) first = '逐字稿與精華片段照常可以看、改；重新下載影片檔之前無法預覽或輸出剪輯。'
  else if (video.fileMissing) first = '逐字稿與精華片段照常可以看、改；原始影片檔放回原位置之前無法預覽或輸出剪輯。'
  const retry = redownload ? '「重試」會重新從 YouTube 下載影片、再重新辨識語音一次' : '「重試」會再重新辨識語音一次'
  return [
    first,
    `${retry}，之後改過的逐字稿會被覆蓋；只想更新候選精華片段，請按「重新分析」→「只重新找精華片段」。`,
  ]
}

/** Next step of the missing-file alert of a YouTube video: download it again with a 'full' run. */
export const REDOWNLOAD_NEXT_STEP = '按「重新分析」→「重新辨識語音並找精華」會重新從 YouTube 下載（逐字稿的修改會被覆蓋）。'

/**
 * Last line of the 「找不到原始影片檔」 alert: what to do once the file is back. Only a failed first
 * Analysis needs 「重試」; with the workspace shown (a failed re-run too) reloading the page is
 * enough, and 重試 would transcribe again over the user's edits. A YouTube video's file is not put
 * back by the user: a 'full' run downloads it again.
 */
export function missingFileNextStep(video: WithAnalysis & WithSource): string {
  const { status, mode } = video.analysis
  if (isYoutube(video)) {
    if (mode === 'full' && (status === 'queued' || status === 'running')) return '這次分析會重新從 YouTube 下載影片。'
    if (!isTranscriptReady(video) && status === 'failed') return '按下方的「重試」會重新從 YouTube 下載影片。'
    return REDOWNLOAD_NEXT_STEP
  }
  if (isTranscriptReady(video)) return '把檔案放回原位置後重新整理這一頁，就能再預覽與輸出剪輯。'
  if (status === 'failed') return '把檔案放回原位置後，按下方的「重試」重新分析。'
  return '把檔案放回原位置後重新整理這一頁即可恢復。'
}

export interface MissingFileText {
  title: string
  description: string
  /** Show where the file was: only a local file can be put back there. */
  showPath: boolean
  nextStep: string
}

/** The video page's missing-file alert (design.md「重新分析」 and「YouTube」→「其他」). */
export function missingFileText(video: WithAnalysis & WithSource): MissingFileText {
  const ready = isTranscriptReady(video)
  if (isYoutube(video)) {
    return {
      title: MISSING_DOWNLOAD_LABEL,
      description: ready
        ? '下載的影片檔可能被刪除了，因此無法預覽，也無法輸出剪輯。逐字稿與精華片段仍然可以查看與修改。'
        : '下載的影片檔可能被刪除了，因此無法預覽或輸出剪輯。',
      showPath: false,
      nextStep: missingFileNextStep(video),
    }
  }
  return {
    title: MISSING_FILE_LABEL,
    description: ready
      ? '原本的檔案可能被移動、改名或刪除，因此無法預覽，也無法輸出剪輯。逐字稿與精華片段仍然可以查看與修改。'
      : '原本的檔案可能被移動、改名或刪除，因此無法分析、預覽或輸出剪輯。',
    showPath: true,
    nextStep: missingFileNextStep(video),
  }
}

/** Player placeholder and the export button's tooltip while the file is missing. */
export function cannotPreviewText(video: WithSource): string {
  return isYoutube(video) ? `${MISSING_DOWNLOAD_LABEL}，無法預覽` : `${MISSING_FILE_LABEL}，無法預覽`
}

export function cannotExportText(video: WithSource): string {
  return isYoutube(video) ? `${MISSING_DOWNLOAD_LABEL}，無法輸出` : `${MISSING_FILE_LABEL}，無法輸出`
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

/** Progress hint of the download step (design.md「YouTube」→「下載」). */
export const DOWNLOAD_HINT = '正在從 YouTube 下載影片（最高 1080p）'

/** Texts of the progress card, by mode, step and source. */
export function analysisProgressText(video: WithAnalysis & WithSource): ProgressText {
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
  const label = analysisStepLabel(step, video.sourceKind)
  const title = label ? `正在${label}` : highlightsOnly ? '正在找精華片段' : '分析中'
  let hint: string
  if (step === 'download') hint = DOWNLOAD_HINT
  else if (step === 'transcribe') hint = '語音辨識最花時間，長影片可能需要數分鐘到數十分鐘。'
  else if (step === 'signals') hint = '本機 AI 正在讀逐字稿，長影片可能要幾分鐘。'
  else if (highlightsOnly) hint = '完成後新的候選精華片段會出現在「候選」分頁。'
  else hint = '完成後就能看逐字稿、挑選精華片段並輸出剪輯。'
  return { title, hint, footer }
}
