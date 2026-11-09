import { describe, expect, it } from 'vitest'
import type { AnalysisState, SourceVideo } from '../../shared/types/domain'
import * as llm from '../../server/lib/llm/types'
import {
  analysisStatusLabels,
  analysisStepLabel,
  analysisStepLabels,
  analysisStepState,
  analysisStepsFor,
  audioTrackLabel,
  DEFAULT_OLLAMA_MODEL,
  highlightStatusLabels,
  isAnalysisActive,
  isClipActive,
  languageLabels,
  layoutLabels,
  LAYOUTS,
  MIN_OLLAMA_VERSION,
  MISSING_FILE_LABEL,
  ollamaFixHint,
  ollamaStatusColors,
  ollamaStatusLabels,
  showsMissingFileLine,
  SIGNAL_ORDER,
  signalLabels,
  sourceKindLabels,
  videoEncoderLabels,
} from './labels'

function analysis(partial: Partial<AnalysisState>): AnalysisState {
  return {
    status: 'running',
    mode: 'full',
    version: null,
    signals: null,
    step: null,
    progress: 0,
    error: null,
    startedAt: null,
    finishedAt: null,
    ...partial,
  }
}

describe('labels', () => {
  it('names every analysis step', () => {
    expect(analysisStepLabels).toEqual({
      'download': '下載影片',
      'probe': '讀取影片資訊',
      'extract-audio': '擷取音訊',
      'transcribe': '語音辨識',
      'prepare-preview': '準備預覽',
      'signals': '分析音量與逐字稿',
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
  it('lists the steps of a full run, plus download for YouTube', () => {
    const full = ['probe', 'extract-audio', 'transcribe', 'prepare-preview', 'signals', 'candidates']
    expect(analysisStepsFor({ sourceKind: 'upload', analysis: analysis({ step: 'probe' }) })).toEqual(full)
    expect(analysisStepsFor({ sourceKind: 'watch-folder', analysis: analysis({ step: 'signals' }) })).toEqual(full)
    expect(analysisStepsFor({ sourceKind: 'youtube', analysis: analysis({ step: null }) })).toEqual(['download', ...full])
  })

  it('lists only extract-audio, signals and candidates for a highlights-only run', () => {
    const highlights = ['extract-audio', 'signals', 'candidates']
    expect(analysisStepsFor({ sourceKind: 'upload', analysis: analysis({ mode: 'highlights', step: null, status: 'queued' }) })).toEqual(highlights)
    expect(analysisStepsFor({ sourceKind: 'youtube', analysis: analysis({ mode: 'highlights', step: 'signals' }) })).toEqual(highlights)
    // an unexpected current step is still shown, in run order
    expect(analysisStepsFor({ sourceKind: 'upload', analysis: analysis({ mode: 'highlights', step: 'probe' }) })).toEqual(['probe', ...highlights])
  })

  it('shows a skipped extract-audio as done once signals runs', () => {
    expect(analysisStepState('extract-audio', 'signals', 'running')).toBe('done')
    expect(analysisStepState('signals', 'signals', 'running')).toBe('current')
    expect(analysisStepState('candidates', 'signals', 'running')).toBe('pending')
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

  it('shows the missing-file line once, not again under the same analysis error', () => {
    const v = (fileMissing: boolean, partial: Partial<AnalysisState>) => ({ fileMissing, analysis: analysis(partial) })
    expect(showsMissingFileLine(v(false, { status: 'done' }))).toBe(false)
    expect(showsMissingFileLine(v(true, { status: 'done' }))).toBe(true)
    expect(showsMissingFileLine(v(true, { status: 'failed', error: MISSING_FILE_LABEL }))).toBe(false)
    expect(showsMissingFileLine(v(true, { status: 'failed', error: '語音辨識失敗' }))).toBe(true)
  })
})

describe('signal labels', () => {
  it('names every Signal in display order', () => {
    expect(signalLabels).toEqual({ loudness: '音量', transcript: '逐字稿（AI）', chat: '聊天室', heatmap: '重播熱度' })
    expect(SIGNAL_ORDER).toEqual(['loudness', 'transcript', 'chat', 'heatmap'])
  })
})

describe('Ollama status', () => {
  const info = (status: Parameters<typeof ollamaFixHint>[0]['status'], extra: { model?: string, version?: string | null } = {}) =>
    ({ status, model: extra.model ?? 'qwen3.5:9b', version: extra.version ?? null })

  it('uses the same minimum version and default model as the server', () => {
    expect(MIN_OLLAMA_VERSION).toBe(llm.MIN_OLLAMA_VERSION)
    expect(DEFAULT_OLLAMA_MODEL).toBe(llm.DEFAULT_OLLAMA_MODEL)
  })

  it('labels and colours every status', () => {
    expect(ollamaStatusLabels).toEqual({
      'ready': '已就緒',
      'disabled': '已關閉',
      'unreachable': '連不到 Ollama',
      'outdated': 'Ollama 版本太舊',
      'model-missing': '還沒有下載模型',
    })
    expect(ollamaStatusColors.ready).toBe('success')
    expect(ollamaStatusColors.disabled).toBe('neutral')
    expect(ollamaStatusColors.unreachable).toBe('warning')
  })

  it('has no hint when ready', () => {
    expect(ollamaFixHint(info('ready', { version: '0.31.2' }))).toBeNull()
  })

  it('tells how to fix each problem', () => {
    const unreachable = ollamaFixHint(info('unreachable'))!
    expect(unreachable.text).toContain('請啟動 Ollama')
    expect(unreachable.text).toContain('setup.bat')
    expect(unreachable.command).toBeNull()

    const missing = ollamaFixHint(info('model-missing', { version: '0.31.2' }))!
    expect(missing.command).toBe('ollama pull qwen3.5:9b')
    expect(missing.text).toContain('約 6.6 GB')

    const outdated = ollamaFixHint(info('outdated', { version: '0.30.0' }))!
    expect(outdated.text).toContain('目前是 0.30.0，需要 0.31.2 以上')
    expect(outdated.text).toContain('更新 Ollama')
    expect(outdated.command).toBe('winget upgrade --id Ollama.Ollama')

    const disabled = ollamaFixHint(info('disabled'))!
    expect(disabled.text).toContain('GG_OLLAMA_URL')
    expect(disabled.text).toContain('只看音量')
    expect(disabled.command).toBeNull()
  })

  it('pulls a custom model without claiming the default size', () => {
    const hint = ollamaFixHint(info('model-missing', { model: 'qwen3.5:4b' }))!
    expect(hint.command).toBe('ollama pull qwen3.5:4b')
    expect(hint.text).not.toContain('GB')
  })

  it('says every warning falls back to loudness only', () => {
    for (const status of ['unreachable', 'outdated', 'model-missing'] as const) {
      expect(ollamaFixHint(info(status))!.text).toContain('自動找精華只看音量')
    }
  })
})
