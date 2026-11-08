import { describe, expect, it } from 'vitest'
import type { AnalysisState, SourceVideo } from '../../shared/types/domain'
import {
  analysisStatusLabels,
  analysisStepLabel,
  analysisStepLabels,
  analysisStepState,
  analysisStepsFor,
  audioTrackLabel,
  highlightStatusLabels,
  isAnalysisActive,
  isClipActive,
  languageLabels,
  layoutLabels,
  LAYOUTS,
  sourceKindLabels,
  videoEncoderLabels,
} from './labels'

function analysis(partial: Partial<AnalysisState>): AnalysisState {
  return { status: 'running', step: null, progress: 0, error: null, startedAt: null, finishedAt: null, ...partial }
}

describe('labels', () => {
  it('names every analysis step', () => {
    expect(analysisStepLabels).toEqual({
      'download': '下載影片',
      'probe': '讀取影片資訊',
      'extract-audio': '擷取音訊',
      'transcribe': '語音辨識',
      'prepare-preview': '準備預覽',
      'signals': '分析訊號',
      'candidates': '找出精華片段',
    })
    expect(analysisStepLabel(null)).toBe('')
    expect(analysisStepLabel('transcribe')).toBe('語音辨識')
  })

  it('names statuses, layouts, languages and sources', () => {
    expect(analysisStatusLabels).toEqual({ queued: '排隊中', running: '分析中', done: '完成', failed: '失敗' })
    expect(highlightStatusLabels).toEqual({ candidate: '候選', selected: '選用', dismissed: '捨棄' })
    expect(layoutLabels).toEqual({ 'blurred-background': '模糊背景', 'center-crop': '置中裁切', 'original': '原比例' })
    expect(languageLabels).toEqual({ zh: '中文（含中英夾雜）', en: 'English' })
    expect(sourceKindLabels['watch-folder']).toBe('影片資料夾')
    expect(sourceKindLabels.upload).toBe('上傳')
    expect(videoEncoderLabels.h264_nvenc).toBe('NVIDIA 硬體編碼 NVENC')
    expect(videoEncoderLabels.libx264).toBe('CPU 編碼（較慢）')
    expect(LAYOUTS[0]).toBe('blurred-background')
  })
})

describe('audioTrackLabel', () => {
  it('is 1-based and lists codec, channels and title/language', () => {
    expect(audioTrackLabel({ index: 0, codec: 'aac', channels: 2, language: null, title: null })).toBe('音軌 1：aac・2 聲道')
    expect(audioTrackLabel({ index: 1, codec: 'aac', channels: 1, language: 'und', title: 'Mic' })).toBe('音軌 2：aac・1 聲道・Mic')
    expect(audioTrackLabel({ index: 2, codec: 'opus', channels: 2, language: 'jpn', title: 'Game' })).toBe('音軌 3：opus・2 聲道・Game / jpn')
    expect(audioTrackLabel({ index: 0, codec: '', channels: 6, language: 'eng', title: ' ' })).toBe('音軌 1：未知編碼・6 聲道・eng')
  })
})

describe('analysis steps', () => {
  it('lists milestone 1 steps, plus download for YouTube and unknown current steps', () => {
    expect(analysisStepsFor({ sourceKind: 'upload', analysis: analysis({ step: 'probe' }) })).toEqual(['probe', 'extract-audio', 'transcribe', 'prepare-preview'])
    expect(analysisStepsFor({ sourceKind: 'youtube', analysis: analysis({ step: null }) })[0]).toBe('download')
    expect(analysisStepsFor({ sourceKind: 'watch-folder', analysis: analysis({ step: 'signals' }) })).toEqual(['probe', 'extract-audio', 'transcribe', 'prepare-preview', 'signals'])
  })

  it('derives step state from the current step', () => {
    expect(analysisStepState('probe', 'transcribe', 'running')).toBe('done')
    expect(analysisStepState('transcribe', 'transcribe', 'running')).toBe('current')
    expect(analysisStepState('prepare-preview', 'transcribe', 'running')).toBe('pending')
    expect(analysisStepState('probe', null, 'queued')).toBe('pending')
    expect(analysisStepState('transcribe', 'transcribe', 'failed')).toBe('pending')
    expect(analysisStepState('prepare-preview', null, 'done')).toBe('done')
  })

  it('knows which work is still active', () => {
    const v = (status: AnalysisState['status']) => ({ analysis: analysis({ status }) }) as Pick<SourceVideo, 'analysis'>
    expect(isAnalysisActive(v('queued'))).toBe(true)
    expect(isAnalysisActive(v('running'))).toBe(true)
    expect(isAnalysisActive(v('done'))).toBe(false)
    expect(isAnalysisActive(v('failed'))).toBe(false)
    expect(isClipActive({ status: 'running' })).toBe(true)
    expect(isClipActive({ status: 'done' })).toBe(false)
  })
})
