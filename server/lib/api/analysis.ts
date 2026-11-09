// API rules that depend on the video's Analysis (design.md「重新分析」).
import type { AnalysisMode, AnalysisState } from '../../../shared/types/domain'
import { conflict, unprocessable } from './errors'

type WithAnalysis = { analysis: Pick<AnalysisState, 'status' | 'mode'> }

/**
 * True when the Transcript can be used and changed: the Analysis is done, or the current / last run
 * only looks for highlights (it never touches the Transcript, even while queued, running or failed).
 * A 'full' run that is queued, running or failed has no usable Transcript yet.
 */
export function transcriptReady(video: WithAnalysis): boolean {
  return video.analysis.status === 'done' || video.analysis.mode === 'highlights'
}

export const REANALYZE_BUSY_MESSAGE = '這支影片正在排隊或分析中，請等分析結束再重新分析'
export const REANALYZE_NO_TRANSCRIPT_MESSAGE = '這支影片還沒有逐字稿，只能選「重新辨識語音並找精華」'
export const REANALYZE_CLIPS_BUSY_MESSAGE = '這支影片還有剪輯在排隊或輸出中，請等輸出完成再重新辨識語音'
export const REANALYZE_MISSING_SOURCE_MESSAGE = '找不到原始影片檔，無法重新辨識語音'

export interface ReanalyzeContext {
  /** Clips of this video that are queued or running (an Export reads the Transcript). */
  activeClips: number
  /** The source file is on disk ('full' transcribes it again). */
  sourceExists: boolean
}

/** Throws the 409 / 422 of design.md「重新分析」 when the video cannot be analysed again in `mode` now. */
export function checkReanalyze(video: WithAnalysis, mode: AnalysisMode, ctx: ReanalyzeContext): void {
  const { status } = video.analysis
  if (status === 'queued' || status === 'running') throw conflict(REANALYZE_BUSY_MESSAGE)
  if (mode === 'highlights') {
    if (!transcriptReady(video)) throw conflict(REANALYZE_NO_TRANSCRIPT_MESSAGE)
    return
  }
  if (ctx.activeClips > 0) throw conflict(REANALYZE_CLIPS_BUSY_MESSAGE)
  if (!ctx.sourceExists) throw unprocessable(REANALYZE_MISSING_SOURCE_MESSAGE)
}

/** 409 messages of the routes that need the Transcript (transcriptReady). */
export const NOT_READY_MESSAGES = {
  export: '影片分析完成後才能輸出剪輯',
  editTranscript: '影片分析完成後才能修改逐字稿',
  addHighlight: '影片分析完成後才能新增精華片段',
  editHighlight: '影片分析完成後才能調整精華片段',
} as const

/** 409 unless transcriptReady(video). */
export function requireTranscriptReady(video: WithAnalysis, action: keyof typeof NOT_READY_MESSAGES): void {
  if (!transcriptReady(video)) throw conflict(NOT_READY_MESSAGES[action])
}
