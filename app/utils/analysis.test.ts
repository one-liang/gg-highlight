import { describe, expect, it } from 'vitest'
import { ANALYSIS_VERSION, type AnalysisState, CANCELLED_MESSAGE, type Highlight, type SignalState } from '../../shared/types/domain'
import {
  analysisDoneNotice,
  analysisFailedTitle,
  analysisProgressText,
  canReanalyze,
  countCandidates,
  countEditedSegments,
  defaultReanalyzeMode,
  failedRunFootnote,
  isFailedRerun,
  isTranscriptReady,
  missingFileNextStep,
  needsHighlightsUpgrade,
  REFILL_TRANSCRIPT_HINT,
  reanalyzeStartedNotice,
  summarizeSignals,
  transcriptSignalFixable,
} from './analysis'

function v(partial: Partial<AnalysisState>): { analysis: AnalysisState } {
  return {
    analysis: {
      status: 'done',
      mode: 'full',
      version: ANALYSIS_VERSION,
      signals: null,
      step: null,
      progress: 1,
      error: null,
      startedAt: null,
      finishedAt: null,
      ...partial,
    },
  }
}

describe('transcript readiness', () => {
  it('is ready when done, or for any highlights-only run', () => {
    expect(isTranscriptReady(v({ status: 'done' }))).toBe(true)
    expect(isTranscriptReady(v({ status: 'done', mode: 'highlights' }))).toBe(true)
    for (const status of ['queued', 'running', 'failed'] as const) {
      expect(isTranscriptReady(v({ status, mode: 'highlights', version: null })), status).toBe(true)
      expect(isTranscriptReady(v({ status, mode: 'full', version: null })), status).toBe(false)
    }
  })

  it('stays ready when a full re-run failed or was cancelled after an earlier Analysis finished', () => {
    for (const version of [1, ANALYSIS_VERSION]) {
      expect(isTranscriptReady(v({ status: 'failed', mode: 'full', version, error: '語音辨識失敗' }))).toBe(true)
      expect(isTranscriptReady(v({ status: 'failed', mode: 'full', version, error: CANCELLED_MESSAGE }))).toBe(true)
      // queued or running: the Transcript is about to be replaced
      expect(isTranscriptReady(v({ status: 'queued', mode: 'full', version }))).toBe(false)
      expect(isTranscriptReady(v({ status: 'running', mode: 'full', version }))).toBe(false)
    }
    // the first Analysis failed: there is no Transcript
    expect(isTranscriptReady(v({ status: 'failed', mode: 'full', version: null }))).toBe(false)
    expect(isFailedRerun(v({ status: 'failed', mode: 'full', version: ANALYSIS_VERSION }))).toBe(true)
    expect(isFailedRerun(v({ status: 'failed', mode: 'full', version: null }))).toBe(false)
    expect(isFailedRerun(v({ status: 'failed', mode: 'highlights', version: ANALYSIS_VERSION }))).toBe(false)
    expect(isFailedRerun(v({ status: 'done' }))).toBe(false)
  })
})

describe('re-analysis', () => {
  it('is offered when done or after a failed highlights-only run, never while queued / running', () => {
    expect(canReanalyze(v({ status: 'done' }))).toBe(true)
    expect(canReanalyze(v({ status: 'done', mode: 'highlights' }))).toBe(true)
    expect(canReanalyze(v({ status: 'failed', mode: 'highlights', version: null }))).toBe(true)
    // a failed first Analysis is retried instead
    expect(canReanalyze(v({ status: 'failed', mode: 'full', version: null }))).toBe(false)
    for (const mode of ['full', 'highlights'] as const) {
      expect(canReanalyze(v({ status: 'queued', mode }))).toBe(false)
      expect(canReanalyze(v({ status: 'running', mode }))).toBe(false)
    }
  })

  it('is offered (both modes) after a failed or cancelled full re-run of a video analysed before', () => {
    expect(canReanalyze(v({ status: 'failed', mode: 'full', version: ANALYSIS_VERSION }))).toBe(true)
    expect(canReanalyze(v({ status: 'failed', mode: 'full', version: 1, error: CANCELLED_MESSAGE }))).toBe(true)
  })

  const fine = { ...v({}), fileMissing: false }
  const loudness: SignalState = { kind: 'loudness', status: 'used', reason: null }
  const withTranscript = (status: SignalState['status'], reason: string | null) =>
    ({ ...v({ signals: [loudness, { kind: 'transcript', status, reason }] }), fileMissing: false })

  it('preselects highlights when any segment was edited, full otherwise', () => {
    expect(countEditedSegments([{ edited: false }, { edited: true }, { edited: true }])).toBe(2)
    expect(countEditedSegments([])).toBe(0)
    expect(defaultReanalyzeMode(fine, 2)).toBe('highlights')
    expect(defaultReanalyzeMode(fine, 0)).toBe('full')
    // unknown: never overwrite edits by default
    expect(defaultReanalyzeMode(fine, null)).toBe('highlights')
  })

  it('preselects highlights when the source file is missing (full cannot run)', () => {
    expect(defaultReanalyzeMode({ ...fine, fileMissing: true }, 0)).toBe('highlights')
  })

  it('preselects highlights when the AI Signal was missing for a fixable reason (re-transcribing does not help)', () => {
    expect(defaultReanalyzeMode(withTranscript('missing', '連不到 Ollama（http://127.0.0.1:11434），請確認 Ollama 已啟動'), 0)).toBe('highlights')
    expect(defaultReanalyzeMode(withTranscript('missing', 'Ollama 裡還沒有 qwen3.5:9b 模型，請執行 ollama pull qwen3.5:9b'), 0)).toBe('highlights')
    expect(defaultReanalyzeMode(withTranscript('used', null), 0)).toBe('full')
    expect(defaultReanalyzeMode(withTranscript('used', '2 個區段讀取失敗'), 0)).toBe('full')
    // turned off on purpose, or nobody spoke: another highlights-only run would not change anything
    expect(defaultReanalyzeMode(withTranscript('missing', '已關閉 AI 讀逐字稿（GG_OLLAMA_URL=off）'), 0)).toBe('full')
    expect(defaultReanalyzeMode(withTranscript('missing', '逐字稿沒有內容'), 0)).toBe('full')
    expect(transcriptSignalFixable(null)).toBe(false)
    expect(transcriptSignalFixable([loudness])).toBe(false)
  })

  it('shows the old-video banner for a done milestone-1 analysis only', () => {
    expect(needsHighlightsUpgrade(v({ version: 1 }))).toBe(true)
    // a done analysis without a version predates versions: treat it as 1
    expect(needsHighlightsUpgrade(v({ version: null }))).toBe(true)
    expect(needsHighlightsUpgrade(v({ version: ANALYSIS_VERSION }))).toBe(false)
    expect(needsHighlightsUpgrade(v({ version: ANALYSIS_VERSION + 1 }))).toBe(false)
    expect(needsHighlightsUpgrade(v({ status: 'failed', version: 1, mode: 'highlights' }))).toBe(false)
    expect(needsHighlightsUpgrade(v({ status: 'running', version: 1, mode: 'highlights' }))).toBe(false)
  })

  it('confirms which run was queued', () => {
    expect(reanalyzeStartedNotice('highlights').title).toBe('已開始找精華片段')
    expect(reanalyzeStartedNotice('full').title).toBe('已開始重新分析')
    expect(reanalyzeStartedNotice('full').description).toContain('完成前看不到逐字稿、精華片段與剪輯')
  })
})

describe('summarizeSignals', () => {
  const loudness: SignalState = { kind: 'loudness', status: 'used', reason: null }
  const transcript: SignalState = { kind: 'transcript', status: 'used', reason: null }

  it('is null before any run found candidates', () => {
    expect(summarizeSignals(null)).toBeNull()
    expect(summarizeSignals(undefined)).toBeNull()
  })

  it('lists the used Signals in display order', () => {
    expect(summarizeSignals([transcript, loudness])).toEqual({ used: '音量、逐字稿（AI）', notes: [] })
  })

  it('notes a missing Signal with its reason, and how to fill in a missing AI Signal', () => {
    const missing: SignalState = { kind: 'transcript', status: 'missing', reason: '連不到 Ollama（http://127.0.0.1:11434），請確認 Ollama 已啟動' }
    expect(summarizeSignals([loudness, missing])).toEqual({
      used: '音量',
      notes: [{ kind: 'transcript', missing: true, text: '逐字稿（AI）沒有用到：連不到 Ollama（http://127.0.0.1:11434），請確認 Ollama 已啟動；處理好之後按「重新分析」→「只重新找精華片段」' }],
    })
    expect(REFILL_TRANSCRIPT_HINT).toBe('；處理好之後按「重新分析」→「只重新找精華片段」')
    const noReason: SignalState = { kind: 'transcript', status: 'missing', reason: '  ' }
    expect(summarizeSignals([loudness, noReason])!.notes[0]!.text).toBe(`逐字稿（AI）沒有用到${REFILL_TRANSCRIPT_HINT}`)
    // no next step where another run would not help, or for the loudness
    const off: SignalState = { kind: 'transcript', status: 'missing', reason: '已關閉 AI 讀逐字稿（GG_OLLAMA_URL=off）' }
    expect(summarizeSignals([loudness, off])!.notes[0]!.text).toBe('逐字稿（AI）沒有用到：已關閉 AI 讀逐字稿（GG_OLLAMA_URL=off）')
    const noLoudness: SignalState = { kind: 'loudness', status: 'missing', reason: '找不到原始影片檔' }
    expect(summarizeSignals([noLoudness, transcript])!.notes[0]!.text).toBe('音量沒有用到：找不到原始影片檔')
  })

  it('notes a caveat of a used Signal', () => {
    const partial: SignalState = { kind: 'transcript', status: 'used', reason: '2 個區段讀取失敗' }
    expect(summarizeSignals([loudness, partial])).toEqual({
      used: '音量、逐字稿（AI）',
      notes: [{ kind: 'transcript', missing: false, text: '逐字稿（AI）：2 個區段讀取失敗' }],
    })
  })

  it('says so when nothing was used', () => {
    expect(summarizeSignals([])).toEqual({ used: '', notes: [] })
  })
})

describe('completion notice', () => {
  function h(origin: Highlight['origin'], status: Highlight['status']): Pick<Highlight, 'origin' | 'status'> {
    return { origin, status }
  }

  it('counts only candidates the analysis made', () => {
    expect(countCandidates([
      h('analysis', 'candidate'),
      h('analysis', 'candidate'),
      h('analysis', 'selected'),
      h('analysis', 'dismissed'),
      h('manual', 'candidate'),
      h('manual', 'selected'),
    ])).toBe(2)
    expect(countCandidates([])).toBe(0)
  })

  it('says how many candidates were found', () => {
    expect(analysisDoneNotice('full', 3)).toEqual({ title: '分析完成', description: '找到 3 個候選精華片段，可以到「候選」分頁挑選。' })
    expect(analysisDoneNotice('highlights', 1)).toEqual({ title: '找精華片段完成', description: '找到 1 個候選精華片段，可以到「候選」分頁挑選。' })
    expect(analysisDoneNotice('full', 0).description).toBe('這次沒有找到候選精華片段，可以自己標出想剪的段落。')
  })

  it('still congratulates when the count could not be read', () => {
    expect(analysisDoneNotice('full', null)).toEqual({ title: '分析完成', description: '可以開始修改逐字稿、挑選精華片段了。' })
    expect(analysisDoneNotice('highlights', null).title).toBe('找精華片段完成')
    expect(analysisDoneNotice(undefined, null).title).toBe('分析完成')
  })

  it('names the failed run', () => {
    const a = (partial: Partial<AnalysisState>) => v({ status: 'failed', error: '語音辨識失敗', ...partial }).analysis
    expect(analysisFailedTitle(a({ mode: 'highlights' }))).toBe('找精華片段失敗')
    expect(analysisFailedTitle(a({ mode: 'full', version: null }))).toBe('分析失敗')
    expect(analysisFailedTitle(a({ mode: 'full', version: ANALYSIS_VERSION }))).toBe('重新分析失敗')
    expect(analysisFailedTitle(a({ mode: 'full', version: 1, error: CANCELLED_MESSAGE }))).toBe('已取消重新分析')
    expect(analysisFailedTitle(a({ mode: 'highlights', error: CANCELLED_MESSAGE }))).toBe('已取消找精華片段')
    expect(analysisFailedTitle(undefined)).toBe('分析失敗')
  })

  it('says the work is intact, and what 重試 does after a failed full re-run', () => {
    expect(failedRunFootnote({ ...v({ status: 'failed', mode: 'highlights' }), fileMissing: false })).toEqual(['逐字稿、精華片段與剪輯不受影響，可以照常使用。'])
    const lines = failedRunFootnote({ ...v({ status: 'failed', mode: 'full', version: ANALYSIS_VERSION }), fileMissing: false })
    expect(lines[0]).toBe('逐字稿、精華片段與剪輯照常可以看、改、輸出。')
    expect(lines[1]).toContain('「重試」會再重新辨識語音一次，之後改過的逐字稿會被覆蓋')
    expect(lines[1]).toContain('「只重新找精華片段」')
  })

  it('does not promise preview or export when the source file is missing', () => {
    expect(failedRunFootnote({ ...v({ status: 'failed', mode: 'highlights' }), fileMissing: true })).toEqual(['逐字稿與精華片段不受影響，可以照常查看與修改。'])
    const lines = failedRunFootnote({ ...v({ status: 'failed', mode: 'full', version: ANALYSIS_VERSION, error: CANCELLED_MESSAGE }), fileMissing: true })
    expect(lines[0]).toBe('逐字稿與精華片段照常可以看、改；原始影片檔放回原位置之前無法預覽或輸出剪輯。')
    expect(lines[1]).toContain('「重試」會再重新辨識語音一次，之後改過的逐字稿會被覆蓋')
    for (const line of [...lines, ...failedRunFootnote({ ...v({ status: 'failed', mode: 'highlights' }), fileMissing: true })]) {
      expect(line).not.toContain('輸出。')
      expect(line).not.toContain('照常使用')
    }
  })

  it('tells what to do once the missing source file is back', () => {
    const reload = '把檔案放回原位置後重新整理這一頁，就能再預覽與輸出剪輯。'
    // the workspace is shown: reloading is enough (重試 would transcribe again over the edits)
    expect(missingFileNextStep(v({ status: 'failed', mode: 'full', version: ANALYSIS_VERSION }))).toBe(reload)
    expect(missingFileNextStep(v({ status: 'failed', mode: 'highlights' }))).toBe(reload)
    expect(missingFileNextStep(v({ status: 'done' }))).toBe(reload)
    expect(missingFileNextStep(v({ status: 'running', mode: 'highlights' }))).toBe(reload)
    // a failed first Analysis has no workspace: 重試
    expect(missingFileNextStep(v({ status: 'failed', mode: 'full', version: null }))).toBe('把檔案放回原位置後，按下方的「重試」重新分析。')
    expect(missingFileNextStep(v({ status: 'queued', mode: 'full', version: null }))).toBe('把檔案放回原位置後重新整理這一頁即可恢復。')
  })
})

describe('analysisProgressText', () => {
  it('describes a queued run by mode', () => {
    expect(analysisProgressText(v({ status: 'queued', mode: 'full' })).title).toBe('排隊等待分析')
    expect(analysisProgressText(v({ status: 'queued', mode: 'highlights' })).title).toBe('排隊等待找精華片段')
    expect(analysisProgressText(v({ status: 'queued' })).hint).toContain('一次只分析一支影片')
  })

  it('names the current step and gives a hint for the slow ones', () => {
    expect(analysisProgressText(v({ status: 'running', step: 'transcribe' }))).toMatchObject({
      title: '正在語音辨識',
      hint: '語音辨識最花時間，長影片可能需要數分鐘到數十分鐘。',
    })
    expect(analysisProgressText(v({ status: 'running', step: 'signals', mode: 'highlights' }))).toMatchObject({
      title: '正在分析音量與逐字稿',
      hint: '本機 AI 正在讀逐字稿，長影片可能要幾分鐘。',
    })
    expect(analysisProgressText(v({ status: 'running', step: 'candidates', mode: 'highlights' })).hint).toContain('「候選」分頁')
    expect(analysisProgressText(v({ status: 'running', step: 'probe' })).hint).toContain('完成後就能看逐字稿')
    expect(analysisProgressText(v({ status: 'running', step: null })).title).toBe('分析中')
    expect(analysisProgressText(v({ status: 'running', step: null, mode: 'highlights' })).title).toBe('正在找精華片段')
  })

  it('says the workspace stays usable during a highlights-only run', () => {
    expect(analysisProgressText(v({ status: 'running', mode: 'highlights' })).footer).toContain('照常可以看、改、輸出')
    expect(analysisProgressText(v({ status: 'running', mode: 'full' })).footer).toBe('分析在背景進行，可以關掉這個頁面，稍後再回來查看。')
  })
})
