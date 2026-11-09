// Milestone 2 through the UI: candidate Highlights from loudness and the (fake) local LLM → 選用 →
// export → 重新分析 (只重新找精華片段) keeps the user's work → the model missing in Ollama → the
// settings row → the old-video banner of a milestone-1 Analysis → a failed full re-run keeps the work usable.
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, type Locator, type Page, test, type TestInfo } from '@playwright/test'
import { LOUDNESS_REASON } from '../../server/lib/highlights/types'
import type { Settings, SourceVideo } from '../../shared/types/domain'
import {
  chooseAndStart, EXPORT_TIMEOUT, FIXTURES_DIR, setOllamaScenario, shot, videoIdOf, waitForAnalysisDone, waitForAnalysisFinished,
} from './helpers'

const TITLE = 'highlights-zh'
/**
 * The fake's two reasons, which it sends in Simplified Chinese on purpose ('大家笑成一团的反应',
 * '「这波操作太扯了」！后面还有'): the app shows them in Taiwan Traditional, unquoted, first sentence only.
 */
const AI_REASON = /^(大家笑成一團的反應|這波操作太扯了)$/
const SIMPLIFIED = /笑成一团|这波操作/
const EDITED_TEXT = 'E2E 改過的逐字稿'
const MODEL_MISSING_REASON = 'Ollama 裡還沒有 qwen3.5:9b 模型，請執行 ollama pull qwen3.5:9b'

let watchFoldersBefore: string[] | null = null

// Leave the shared app as the other specs expect it, also when this test fails half-way.
test.afterEach(async ({ request }) => {
  await setOllamaScenario(request, 'ok')
  const videos = (await (await request.get('/api/videos')).json()) as SourceVideo[]
  for (const v of videos.filter(v => v.title === TITLE)) await request.delete(`/api/videos/${encodeURIComponent(v.id)}`)
  if (watchFoldersBefore) await request.put('/api/settings', { data: { watchFolders: watchFoldersBefore } })
})

/** "m:ss.s – m:ss.s" (the range button of a Highlight) → seconds. */
function parseRange(text: string): { start: number, end: number } {
  const seconds = (t: string) => t.split(':').reduce((acc, part) => acc * 60 + Number(part), 0)
  const [start, end] = text.split('–').map(t => seconds(t.trim()))
  if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`not a range: ${text}`)
  return { start, end }
}

async function rangeOf(item: Locator): Promise<string> {
  const text = (await item.getByTitle('跳到起點').textContent())?.trim() ?? ''
  expect(text).toMatch(/^\d+:\d\d\.\d – \d+:\d\d\.\d$/)
  return text
}

/**
 * 重新分析 → 只重新找精華片段 (preselected and 建議, because a Transcript segment was edited) →
 * waits until the run is done and the page offers 重新分析 again.
 */
async function reanalyzeHighlightsOnly(page: Page, videoId: string, screenshot?: { testInfo: TestInfo, name: string }): Promise<SourceVideo> {
  await page.getByRole('button', { name: '重新分析', exact: true }).click()
  const modal = page.getByRole('dialog', { name: '重新分析' })
  await expect(modal).toBeVisible()
  await expect(modal.getByRole('radio', { name: /只重新找精華片段/ })).toBeChecked()
  await expect(modal.locator('label').filter({ hasText: '只重新找精華片段' })).toContainText('建議')
  await expect(modal).toContainText('你改過 1 段逐字稿，會照常保留')
  await expect(modal).toContainText('會保留：選用／捨棄／手動新增的精華片段、已輸出的剪輯')
  if (screenshot) await shot(page, screenshot.testInfo, screenshot.name)
  await modal.getByRole('button', { name: '開始重新分析' }).click()
  // the dialog closes once the server queued the run
  await expect(modal).toBeHidden()
  const video = await waitForAnalysisFinished(page.request, videoId)
  expect(video.analysis).toMatchObject({ status: 'done', mode: 'highlights', version: 2, error: null })
  await expect(page.getByRole('button', { name: '重新分析', exact: true })).toBeVisible()
  return video
}

/** Makes the stored Analysis look like a 'full' re-run that failed after an earlier one had finished. */
function markAsFailedFullRerun(videoId: string, error: string): void {
  const db = new DatabaseSync(path.join(process.env.GG_E2E_DATA_DIR!, 'gg-highlight.db'))
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const result = db.prepare(`UPDATE videos SET analysis_status = 'failed', analysis_mode = 'full', analysis_error = ? WHERE id = ? AND analysis_version = 2`).run(error, videoId)
    expect(result.changes).toBe(1)
  }
  finally {
    db.close()
  }
}

/** Makes the stored Analysis look like a milestone-1 one (what the schema-2 migration leaves for those videos). */
function markAsMilestone1(videoId: string): void {
  const db = new DatabaseSync(path.join(process.env.GG_E2E_DATA_DIR!, 'gg-highlight.db'))
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const result = db.prepare(`UPDATE videos SET analysis_version = 1, analysis_mode = 'full', analysis_signals_json = NULL WHERE id = ?`).run(videoId)
    expect(result.changes).toBe(1)
  }
  finally {
    db.close()
  }
}

test('candidate highlights: pick and export, re-analyse keeping edits, missing model, settings, old-video banner', async ({ page, request }, testInfo) => {
  // one analysis, one export and five highlights-only runs
  test.setTimeout(10 * 60_000)

  // ---- the fixtures folder as a Watch Folder (workflow.spec.ts adds it through the settings page) ----
  const settings = (await (await request.get('/api/settings')).json()) as Settings
  watchFoldersBefore = settings.watchFolders
  if (!settings.watchFolders.includes(FIXTURES_DIR)) {
    const res = await request.put('/api/settings', { data: { watchFolders: [...settings.watchFolders, FIXTURES_DIR] } })
    expect(res.ok(), await res.text()).toBe(true)
  }

  // ---- add highlights-zh.mkv from the Watch Folder and wait for the analysis ----
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '影片庫', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: '加入影片' }).first().click()
  const dialog = page.getByRole('dialog', { name: '加入影片' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /highlights-zh\.mkv/ }).click()
  await expect(dialog.getByText('highlights-zh.mkv', { exact: true })).toBeVisible()
  await chooseAndStart(dialog, page, { language: '中文（含中英夾雜）' })
  const row = await waitForAnalysisDone(page, TITLE)
  await row.getByRole('link', { name: TITLE, exact: true }).click()
  await expect(page.getByRole('heading', { name: TITLE, level: 1 })).toBeVisible()
  const videoId = videoIdOf(page)

  // ---- 候選: the AI-read speech (a 1-minute video gets ceil(1/60 h × 10) = 1 candidate) ----
  const highlights = page.locator('section').filter({ has: page.getByRole('heading', { name: '精華片段', exact: true }) })
  const items = highlights.getByRole('listitem')
  const summary = highlights.getByTestId('signal-summary')
  await expect(summary).toContainText('這次的候選依據：音量、逐字稿（AI）')
  await expect(summary).not.toContainText('沒有用到')
  await highlights.getByRole('tab', { name: /候選/ }).click()
  await expect(items).toHaveCount(1)
  const candidate = items.first()
  await expect(candidate.getByText('候選', { exact: true })).toBeVisible()
  await expect(candidate.getByText('自動', { exact: true })).toBeVisible()
  await expect(candidate).toContainText(/精華分數 \d{1,3}/)
  await expect(candidate.getByText(AI_REASON)).toBeVisible()
  await expect(candidate).not.toContainText(SIMPLIFIED)
  const pickedRange = await rangeOf(candidate)
  await shot(page, testInfo, 'm2-video-candidates')

  // ---- 選用 ----
  await candidate.getByRole('button', { name: '選用', exact: true }).click()
  await expect(items).toHaveCount(0)
  await highlights.getByRole('tab', { name: /選用/ }).click()
  const picked = items.filter({ hasText: pickedRange })
  await expect(picked).toHaveCount(1)
  await expect(picked.getByText('選用', { exact: true })).toBeVisible()
  await expect(picked.getByText(AI_REASON)).toBeVisible()

  // ---- change the first Transcript segment (the subtitles and the re-analysis use it) ----
  const transcript = page.locator('section').filter({ has: page.getByRole('heading', { name: '逐字稿' }) })
  await transcript.getByTitle('點一下修改文字').first().click()
  const editor = transcript.getByRole('textbox', { name: '修改這段逐字稿' })
  await expect(editor).toBeFocused()
  await editor.fill(EDITED_TEXT)
  await editor.press('Enter')
  await expect(editor).toBeHidden()
  await expect(transcript.getByText(EDITED_TEXT, { exact: true })).toBeVisible()
  await expect(transcript).toContainText('已修改 1 段')

  // ---- export 模糊背景 with burned-in subtitles, then download ----
  await picked.getByRole('button', { name: '輸出' }).click()
  const exportDialog = page.getByRole('dialog', { name: '輸出剪輯' })
  await expect(exportDialog).toBeVisible()
  await expect(exportDialog).toContainText(pickedRange)
  await expect(exportDialog.getByRole('radio', { name: /模糊背景/ })).toBeChecked()
  await expect(exportDialog.getByRole('switch', { name: '燒錄字幕' })).toBeChecked()
  await exportDialog.getByRole('button', { name: '開始輸出' }).click()
  await expect(exportDialog).toBeHidden()

  const clips = page.locator('section').filter({ has: page.getByRole('heading', { name: /^剪輯/ }) })
  const clip = clips.getByRole('listitem').filter({ hasText: '模糊背景' })
  await expect(clip.getByText('完成', { exact: true })).toBeVisible({ timeout: EXPORT_TIMEOUT })
  await expect(clip).toContainText('已燒錄字幕')
  await expect(picked).toContainText('已輸出 1 次')

  const videoRes = await page.request.get((await clip.getByRole('link', { name: '下載影片' }).getAttribute('href'))!)
  expect(videoRes.status()).toBe(200)
  expect(videoRes.headers()['content-type']).toBe('video/mp4')
  const disposition = videoRes.headers()['content-disposition'] ?? ''
  expect(disposition).toMatch(/^attachment;/)
  expect(decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1] ?? '')).toMatch(/^highlights-zh_.*_模糊背景\.mp4$/)
  const mp4 = await videoRes.body()
  expect(mp4.length).toBeGreaterThan(10_000)
  expect(mp4.subarray(4, 8).toString('latin1')).toBe('ftyp')
  const srtRes = await page.request.get((await clip.getByRole('link', { name: '下載字幕' }).getAttribute('href'))!)
  expect(srtRes.status()).toBe(200)
  expect(await srtRes.text()).toContain(EDITED_TEXT)

  // ---- 重新分析 → 只重新找精華片段 ----
  await reanalyzeHighlightsOnly(page, videoId, { testInfo, name: 'm2-reanalyze-modal' })
  await expect(page.getByText('找到 1 個候選精華片段，可以到「候選」分頁挑選。').first()).toBeVisible()
  // from the server: the edited segment and the picked, exported Highlight are kept
  await page.reload()
  await expect(transcript.getByText(EDITED_TEXT, { exact: true })).toBeVisible()
  await expect(transcript).toContainText('已修改 1 段')
  await expect(summary).toContainText('這次的候選依據：音量、逐字稿（AI）')
  await expect(picked).toHaveCount(1)
  await expect(picked.getByText('選用', { exact: true })).toBeVisible()
  await expect(picked).toContainText('已輸出 1 次')
  // the new candidate stays clear of the kept Highlight (usually the loud burst at 40–46 s; the tiny
  // model's text varies, so an AI moment right after the kept range may win instead)
  await highlights.getByRole('tab', { name: /候選/ }).click()
  await expect(items).toHaveCount(1)
  const kept = parseRange(pickedRange)
  const fresh = parseRange(await rangeOf(items.first()))
  expect(fresh.start >= kept.end || fresh.end <= kept.start).toBe(true)

  // ---- the model is not in Ollama: the transcript Signal is missing, loudness still finds candidates ----
  await setOllamaScenario(request, 'model-missing')
  await reanalyzeHighlightsOnly(page, videoId)
  await expect(summary).toContainText('這次的候選依據：音量')
  await expect(summary).not.toContainText('音量、逐字稿')
  await expect(summary).toContainText(`逐字稿（AI）沒有用到：${MODEL_MISSING_REASON}`)
  await highlights.getByRole('tab', { name: /候選/ }).click()
  await expect(items).toHaveCount(1)
  await expect(items.first()).toContainText(LOUDNESS_REASON)
  await expect(items.first()).toContainText(/精華分數 \d{1,3}/)
  // loudness alone: the burst at 40–46 s
  const burst = parseRange(await rangeOf(items.first()))
  expect(burst.start >= kept.end || burst.end <= kept.start).toBe(true)
  expect(burst.start).toBeLessThanOrEqual(40)
  expect(burst.end).toBeGreaterThanOrEqual(46)
  await shot(page, testInfo, 'm2-model-missing')
  await highlights.getByRole('tab', { name: /選用/ }).click()
  await expect(picked).toHaveCount(1)

  // ---- 設定: the Ollama row says what to do, and turns ready after 重新檢查 ----
  await page.getByRole('navigation', { name: '主要導覽' }).getByRole('link', { name: '設定' }).click()
  await expect(page.getByRole('heading', { name: '設定', level: 1 })).toBeVisible()
  const ollamaRow = page.locator('dl > div').filter({ has: page.getByText('AI 讀逐字稿', { exact: true }) })
  await expect(ollamaRow).toContainText('還沒有下載模型')
  await expect(ollamaRow.getByText('ollama pull qwen3.5:9b', { exact: true })).toBeVisible()
  await shot(page, testInfo, 'm2-settings-model-missing')
  await setOllamaScenario(request, 'ok')
  await ollamaRow.getByRole('button', { name: '重新檢查' }).click()
  await expect(ollamaRow).toContainText('已就緒（Ollama 0.40.15・qwen3.5:9b）')
  await expect(ollamaRow).not.toContainText('ollama pull')
  await shot(page, testInfo, 'm2-settings')

  // ---- an Analysis done before milestone 2: the old-video banner → 找精華片段 ----
  markAsMilestone1(videoId)
  await page.goto(`/videos/${encodeURIComponent(videoId)}`)
  const bannerTitle = page.getByText('這支影片分析時還沒有自動找精華', { exact: true })
  await expect(bannerTitle).toBeVisible()
  await expect(page.getByRole('button', { name: '重新分析全部' })).toBeVisible()
  await expect(summary).toHaveCount(0)
  await shot(page, testInfo, 'm2-old-video-banner')
  // keeps the Transcript, so it starts right away (no dialog)
  const queued = page.waitForResponse(res => res.request().method() === 'POST' && res.url().endsWith(`/api/videos/${videoId}/reanalyze`))
  await page.getByRole('button', { name: '找精華片段', exact: true }).click()
  expect((await queued).status()).toBe(200)
  await expect(page.getByRole('dialog', { name: '重新分析' })).toHaveCount(0)
  const upgraded = await waitForAnalysisFinished(request, videoId)
  expect(upgraded.analysis).toMatchObject({ status: 'done', mode: 'highlights', version: 2 })
  await expect(bannerTitle).toBeHidden()
  await expect(summary).toContainText('這次的候選依據：音量、逐字稿（AI）')
  await expect(transcript.getByText(EDITED_TEXT, { exact: true })).toBeVisible()

  // ---- a full re-run that failed after the earlier ones finished: the work stays usable ----
  markAsFailedFullRerun(videoId, '語音辨識失敗：CUDA out of memory')
  await page.reload()
  const failedAlert = page.getByTestId('analysis-failed')
  await expect(failedAlert).toContainText('重新分析失敗')
  await expect(failedAlert).toContainText('語音辨識失敗：CUDA out of memory')
  await expect(failedAlert).toContainText('逐字稿、精華片段與剪輯照常可以看、改、輸出。')
  await expect(failedAlert.getByRole('button', { name: '重試' })).toBeVisible()
  await expect(transcript.getByText(EDITED_TEXT, { exact: true })).toBeVisible()
  await highlights.getByRole('tab', { name: /選用/ }).click()
  await expect(picked).toContainText('已輸出 1 次')
  await expect(clip.getByRole('link', { name: '下載影片' })).toBeVisible()
  await shot(page, testInfo, 'm2-failed-full-rerun')
  // both re-analysis choices are offered; with an edited segment 只重新找精華片段 is preselected
  await failedAlert.getByRole('button', { name: '重新分析…' }).click()
  const failedModal = page.getByRole('dialog', { name: '重新分析' })
  await expect(failedModal.getByRole('radio', { name: /只重新找精華片段/ })).toBeChecked()
  await expect(failedModal.getByRole('radio', { name: /重新辨識語音並找精華/ })).toBeEnabled()
  await failedModal.getByRole('button', { name: '取消' }).click()
  await expect(failedModal).toBeHidden()
  const recovered = await reanalyzeHighlightsOnly(page, videoId)
  expect(recovered.analysis).toMatchObject({ status: 'done', mode: 'highlights' })
  await expect(failedAlert).toHaveCount(0)
})
