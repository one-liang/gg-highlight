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
  'signals': '分析訊號',
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

export const videoEncoderLabels: Record<SystemInfo['videoEncoder'], string> = {
  h264_nvenc: 'NVIDIA 硬體編碼 NVENC',
  libx264: 'CPU 編碼（較慢）',
}

export function analysisStepLabel(step: AnalysisStep | null | undefined): string {
  return step ? analysisStepLabels[step] : ''
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

const MILESTONE_1_STEPS: AnalysisStep[] = ['probe', 'extract-audio', 'transcribe', 'prepare-preview']

/** Steps to show in the progress card for a video; includes the current step if it is a later-milestone one. */
export function analysisStepsFor(video: Pick<SourceVideo, 'sourceKind' | 'analysis'>): AnalysisStep[] {
  const steps = new Set<AnalysisStep>(MILESTONE_1_STEPS)
  if (video.sourceKind === 'youtube') steps.add('download')
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

/** Library row: the separate missing-file line, unless the failed analysis already says exactly that. */
export function showsMissingFileLine(video: Pick<SourceVideo, 'fileMissing' | 'analysis'>): boolean {
  if (!video.fileMissing) return false
  return !(video.analysis.status === 'failed' && video.analysis.error?.startsWith(MISSING_FILE_LABEL))
}

export function isAnalysisActive(video: Pick<SourceVideo, 'analysis'>): boolean {
  return video.analysis.status === 'queued' || video.analysis.status === 'running'
}

export function isClipActive(clip: { status: ClipStatus }): boolean {
  return clip.status === 'queued' || clip.status === 'running'
}
