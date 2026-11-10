// User-facing labels (zh-TW) for domain enums.
import type {
  AnalysisStatus,
  AnalysisStep,
  AudioTrack,
  ClipStatus,
  HighlightOrigin,
  HighlightStatus,
  Language,
  Layout,
  OllamaInfo,
  OllamaStatus,
  SignalKind,
  SourceKind,
  SourceVideo,
  SystemInfo,
} from '../../shared/types/domain'

/** Nuxt UI semantic colors used for badges / progress bars. */
export type UiColor = 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'

export const analysisStepLabels: Record<AnalysisStep, string> = {
  'download': '下載影片',
  'probe': '讀取影片資訊',
  'extract-audio': '擷取音訊',
  'transcribe': '語音辨識',
  'prepare-preview': '準備預覽',
  'signals': '分析音量與逐字稿',
  'candidates': '找出精華片段',
}

export const analysisStatusLabels: Record<AnalysisStatus, string> = {
  queued: '排隊中',
  running: '分析中',
  done: '完成',
  failed: '失敗',
}

export const analysisStatusColors: Record<AnalysisStatus, UiColor> = {
  queued: 'neutral',
  running: 'primary',
  done: 'success',
  failed: 'error',
}

export const highlightStatusLabels: Record<HighlightStatus, string> = {
  candidate: '候選',
  selected: '選用',
  dismissed: '捨棄',
}

export const highlightStatusColors: Record<HighlightStatus, UiColor> = {
  candidate: 'warning',
  selected: 'primary',
  dismissed: 'neutral',
}

export const highlightOriginLabels: Record<HighlightOrigin, string> = {
  manual: '手動',
  analysis: '自動',
}

export const layoutLabels: Record<Layout, string> = {
  'blurred-background': '模糊背景',
  'center-crop': '置中裁切',
  'original': '原比例',
}

export const layoutDescriptions: Record<Layout, string> = {
  'blurred-background': '直式 1080×1920，完整畫面置中，上下用放大模糊的同一畫面補滿。',
  'center-crop': '直式 1080×1920，從畫面中央裁出直式，左右兩側會被裁掉。',
  'original': '維持原本的比例與解析度（最高 1080p），適合一般橫式影片。',
}

/** Layout order shown in the export dialog; the first one is the default. */
export const LAYOUTS: Layout[] = ['blurred-background', 'center-crop', 'original']

export const languageLabels: Record<Language, string> = {
  zh: '中文（含中英夾雜）',
  en: 'English',
}

export const sourceKindLabels: Record<SourceKind, string> = {
  'watch-folder': '影片資料夾',
  'upload': '上傳',
  'youtube': 'YouTube',
}

export const clipStatusLabels: Record<ClipStatus, string> = {
  queued: '排隊中',
  running: '輸出中',
  done: '完成',
  failed: '失敗',
}

export const clipStatusColors: Record<ClipStatus, UiColor> = {
  queued: 'neutral',
  running: 'primary',
  done: 'success',
  failed: 'error',
}

/** Names of the Signals as the user reads them (「這次的候選依據」). */
export const signalLabels: Record<SignalKind, string> = {
  loudness: '音量',
  transcript: '逐字稿（AI）',
  chat: '聊天室',
  heatmap: '重播熱度',
}

/** Display order of the Signals. */
export const SIGNAL_ORDER: SignalKind[] = ['loudness', 'transcript', 'chat', 'heatmap']

export const ollamaStatusLabels: Record<OllamaStatus, string> = {
  'ready': '已就緒',
  'disabled': '已關閉',
  'unreachable': '連不到 Ollama',
  'outdated': 'Ollama 版本太舊',
  'model-missing': '還沒有下載模型',
}

export const ollamaStatusColors: Record<OllamaStatus, UiColor> = {
  'ready': 'success',
  'disabled': 'neutral',
  'unreachable': 'warning',
  'outdated': 'warning',
  'model-missing': 'warning',
}

/** Same as MIN_OLLAMA_VERSION in server/lib/llm/types.ts (labels.test.ts checks they match). */
export const MIN_OLLAMA_VERSION = '0.31.2'

/** Same as DEFAULT_OLLAMA_MODEL in server/lib/llm/types.ts; only this model's download size is known. */
export const DEFAULT_OLLAMA_MODEL = 'qwen3.5:9b'

export interface OllamaFixHint {
  text: string
  /** Command to run in 命令提示字元, if one fixes it. */
  command: string | null
}

const VOLUME_ONLY = '在那之前自動找精華只看音量。'

/** What the user can do so the transcript Signal works; null when Ollama is ready. */
export function ollamaFixHint(info: Pick<OllamaInfo, 'status' | 'model' | 'version'>): OllamaFixHint | null {
  switch (info.status) {
    case 'ready':
      return null
    case 'disabled':
      return { text: '環境變數 GG_OLLAMA_URL 設成 off，不用 AI 讀逐字稿，自動找精華只看音量。', command: null }
    case 'unreachable':
      return { text: `請啟動 Ollama（裝好後會常駐在右下角通知區）；還沒安裝的話，重新執行專案資料夾裡的 setup.bat。${VOLUME_ONLY}`, command: null }
    case 'outdated':
      return { text: `目前是 ${info.version ?? '舊版'}，需要 ${MIN_OLLAMA_VERSION} 以上。請在命令提示字元執行下面的指令更新 Ollama；${VOLUME_ONLY}`, command: 'winget upgrade --id Ollama.Ollama' }
    case 'model-missing': {
      const size = info.model === DEFAULT_OLLAMA_MODEL ? '（約 6.6 GB）' : ''
      return { text: `請在命令提示字元執行下面的指令下載模型${size}；${VOLUME_ONLY}`, command: `ollama pull ${info.model}` }
    }
  }
}

export const videoEncoderLabels: Record<SystemInfo['videoEncoder'], string> = {
  h264_nvenc: 'NVIDIA 硬體編碼 NVENC',
  libx264: 'CPU 編碼（較慢）',
}

/** The Signals a video's Analysis computes, as one phrase: YouTube videos add the chat and the heatmap. */
export function signalNamesFor(sourceKind: SourceKind | null | undefined): string {
  return sourceKind === 'youtube' ? '音量、逐字稿、聊天室與重播熱度' : '音量與逐字稿'
}

/** Step label; the signals step names the Signals of the video's source (analysisStepLabels has the local one). */
export function analysisStepLabel(step: AnalysisStep | null | undefined, sourceKind?: SourceKind | null): string {
  if (!step) return ''
  if (step === 'signals') return `分析${signalNamesFor(sourceKind)}`
  return analysisStepLabels[step]
}

/** "音軌 1：aac・2 聲道・Mic" (1-based for people; value stays 0-based). */
export function audioTrackLabel(track: AudioTrack): string {
  const parts = [track.codec || '未知編碼', `${track.channels} 聲道`]
  const language = track.language && track.language !== 'und' ? track.language : null
  const extra = [track.title, language].filter((v): v is string => !!v && v.trim() !== '')
  if (extra.length) parts.push(extra.join(' / '))
  return `音軌 ${track.index + 1}：${parts.join('・')}`
}

/** Analysis steps run in this order. */
export const ANALYSIS_STEP_ORDER: AnalysisStep[] = [
  'download',
  'probe',
  'extract-audio',
  'transcribe',
  'prepare-preview',
  'signals',
  'candidates',
]

/** Steps of a 'full' run (design.md「分析」); YouTube adds download in front (milestone 3). */
const FULL_STEPS: AnalysisStep[] = ['probe', 'extract-audio', 'transcribe', 'prepare-preview', 'signals', 'candidates']

/** Steps of a 'highlights' run; extract-audio is skipped (shown as done) when the loudness is cached. */
const HIGHLIGHTS_STEPS: AnalysisStep[] = ['extract-audio', 'signals', 'candidates']

/** Steps to show in the progress card for a video, by mode; includes the current step if it is an unexpected one. */
export function analysisStepsFor(video: Pick<SourceVideo, 'sourceKind' | 'analysis'>): AnalysisStep[] {
  const highlightsOnly = video.analysis.mode === 'highlights'
  const steps = new Set<AnalysisStep>(highlightsOnly ? HIGHLIGHTS_STEPS : FULL_STEPS)
  if (video.sourceKind === 'youtube' && !highlightsOnly) steps.add('download')
  if (video.analysis.step) steps.add(video.analysis.step)
  return ANALYSIS_STEP_ORDER.filter(s => steps.has(s))
}

export type StepState = 'done' | 'current' | 'pending'

export function analysisStepState(step: AnalysisStep, current: AnalysisStep | null, status: AnalysisStatus): StepState {
  if (status === 'done') return 'done'
  if (!current) return 'pending'
  const a = ANALYSIS_STEP_ORDER.indexOf(step)
  const b = ANALYSIS_STEP_ORDER.indexOf(current)
  if (a < b) return 'done'
  if (a === b) return status === 'running' ? 'current' : 'pending'
  return 'pending'
}

/** Same text the server stores as the analysis error when the source file is gone. */
export const MISSING_FILE_LABEL = '找不到原始影片檔'

/** A YouTube video's downloaded file was deleted (a 'full' run downloads it again). */
export const MISSING_DOWNLOAD_LABEL = '下載的影片檔不見了'

/** What the missing-file line and alert say, by source. */
export function missingFileLabel(video: Pick<SourceVideo, 'sourceKind'>): string {
  return video.sourceKind === 'youtube' ? MISSING_DOWNLOAD_LABEL : MISSING_FILE_LABEL
}

/** Library row: the separate missing-file line, unless the failed analysis already says exactly that. */
export function showsMissingFileLine(video: Pick<SourceVideo, 'fileMissing' | 'analysis'>): boolean {
  if (!video.fileMissing) return false
  if (video.analysis.status !== 'failed') return true
  const error = video.analysis.error ?? ''
  return !(error.startsWith(MISSING_FILE_LABEL) || error.startsWith(MISSING_DOWNLOAD_LABEL))
}

export function isAnalysisActive(video: Pick<SourceVideo, 'analysis'>): boolean {
  return video.analysis.status === 'queued' || video.analysis.status === 'running'
}

export function isClipActive(clip: { status: ClipStatus }): boolean {
  return clip.status === 'queued' || clip.status === 'running'
}
