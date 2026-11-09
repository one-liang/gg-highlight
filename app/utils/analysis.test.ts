import { describe, expect, it } from 'vitest'
import { ANALYSIS_VERSION, type AnalysisState, type Highlight, type SignalState } from '../../shared/types/domain'
import {
  analysisDoneNotice,
  analysisFailedTitle,
  analysisProgressText,
  canReanalyze,
  countCandidates,
  countEditedSegments,
  defaultReanalyzeMode,
  isTranscriptReady,
  needsHighlightsUpgrade,
  reanalyzeStartedNotice,
  summarizeSignals,
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
      expect(isTranscriptReady(v({ status, mode: 'highlights' })), status).toBe(true)
      expect(isTranscriptReady(v({ status, mode: 'full' })), status).toBe(false)
    }
  })
})

describe('re-analysis', () => {
  it('is offered when done or after a failed highlights-only run, never while queued / running', () => {
    expect(canReanalyze(v({ status: 'done' }))).toBe(true)
    expect(canReanalyze(v({ status: 'done', mode: 'highlights' }))).toBe(true)
    expect(canReanalyze(v({ status: 'failed', mode: 'highlights' }))).toBe(true)
    // a failed full run is retried instead
    expect(canReanalyze(v({ status: 'failed', mode: 'full' }))).toBe(false)
    for (const mode of ['full', 'highlights'] as const) {
      expect(canReanalyze(v({ status: 'queued', mode }))).toBe(false)
      expect(canReanalyze(v({ status: 'running', mode }))).toBe(false)
    }
  })

  it('preselects highlights when any segment was edited, full otherwise', () => {
    expect(countEditedSegments([{ edited: false }, { edited: true }, { edited: true }])).toBe(2)
    expect(countEditedSegments([])).toBe(0)
    expect(defaultReanalyzeMode(2)).toBe('highlights')
    expect(defaultReanalyzeMode(0)).toBe('full')
    // unknown: never overwrite edits by default
    expect(defaultReanalyzeMode(null)).toBe('highlights')
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
    expect(reanalyzeStartedNotice('full').description).toContain('完成前不能修改逐字稿')
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

  it('notes a missing Signal with its reason', () => {
    const missing: SignalState = { kind: 'transcript', status: 'missing', reason: '連不到 Ollama（http://127.0.0.1:11434），請確認 Ollama 已啟動' }
    expect(summarizeSignals([loudness, missing])).toEqual({
      used: '音量',
      notes: [{ kind: 'transcript', missing: true, text: '逐字稿（AI）沒有用到：連不到 Ollama（http://127.0.0.1:11434），請確認 Ollama 已啟動' }],
    })
    const noReason: SignalState = { kind: 'transcript', status: 'missing', reason: '  ' }
    expect(summarizeSignals([loudness, noReason])!.notes[0]!.text).toBe('逐字稿（AI）沒有用到')
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
    expect(analysisFailedTitle('highlights')).toBe('找精華片段失敗')
    expect(analysisFailedTitle('full')).toBe('分析失敗')
    expect(analysisFailedTitle(undefined)).toBe('分析失敗')
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
