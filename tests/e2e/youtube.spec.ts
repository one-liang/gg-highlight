// Milestone 3 through the UI, with the fake yt-dlp playwright.config.ts sets up (the video id in the
// link picks its scenario; a download copies the 60 s highlights-zh.mkv fixture): YouTube tab → link
// → 讀取影片資訊 → preview → 下載並開始分析 → the chat and heatmap Signals are used → 在 YouTube 開啟
// → the same link again is a duplicate → removing the video deletes its downloads. Also the link and
// probe errors, and removing a video while its download is still running.
import fs from 'node:fs'
import path from 'node:path'
import { expect, type Locator, type Page, test } from '@playwright/test'
import type { SourceVideo } from '../../shared/types/domain'
import { DOWNLOAD_HINT } from '../../app/utils/analysis'
import { YOUTUBE_RIGHTS_NOTICE } from '../../app/utils/youtube'
import { YTDLP_ERROR_MESSAGES } from '../../server/lib/youtube/errors'
import { FAKE_YTDLP_IDS } from '../../server/lib/youtube/test-helpers/fake-yt-dlp.mjs'
import { deleteFromLibrary, libraryRow, setOllamaScenario, shot, videoIdOf, waitForAnalysisDone, waitForAnalysisFinished } from './helpers'

const ids = FAKE_YTDLP_IDS
/** The fake's title for a live stream replay. */
const titleOf = (id: string) => `測試直播重播 ${id}`
const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`

const downloadsDir = () => path.join(process.env.GG_E2E_DATA_DIR!, 'downloads')
/** Files of this Source Video in data/downloads (named `<videoId>.*`, see design.md「從影片庫移除」). */
function downloadsOf(videoId: string): string[] {
  const dir = downloadsDir()
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.startsWith(`${videoId}.`)).sort() : []
}

// Leave the shared app as the other specs expect it, also when a test fails half-way.
test.afterEach(async ({ request }) => {
  await setOllamaScenario(request, 'ok')
  const videos = (await (await request.get('/api/videos')).json()) as SourceVideo[]
  for (const v of videos.filter(v => v.sourceKind === 'youtube')) await request.delete(`/api/videos/${encodeURIComponent(v.id)}`)
})

/** 加入影片 → YouTube tab; returns the dialog. */
async function openYoutubeTab(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: '加入影片' }).first().click()
  const dialog = page.getByRole('dialog', { name: '加入影片' })
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('youtube-tab').click()
  await expect(dialog.getByTestId('youtube-url-input')).toBeVisible()
  return dialog
}

/** Types the link and presses 讀取影片資訊. */
async function probe(dialog: Locator, url: string): Promise<void> {
  await dialog.getByTestId('youtube-url-input').fill(url)
  await expect(dialog.getByTestId('youtube-probe-button')).toBeEnabled()
  await dialog.getByRole('button', { name: '讀取影片資訊' }).click()
}

test('YouTube link: probe, download and analyse with chat and heatmap, duplicate, remove', async ({ page }, testInfo) => {
  const id = ids.vodChat
  const title = titleOf(id)

  // ---- 加入影片 → YouTube → a youtu.be link with a share parameter ----
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '影片庫', level: 1 })).toBeVisible()
  const dialog = await openYoutubeTab(page)
  await probe(dialog, `https://youtu.be/${id}?si=x`)

  // ---- the preview: a live stream replay with a chat replay and a heatmap, and the rights notice ----
  const preview = dialog.getByTestId('youtube-preview')
  await expect(preview).toBeVisible()
  await expect(preview).toContainText(title)
  await expect(preview).toContainText('測試頻道')
  await expect(dialog.getByText('長度', { exact: true })).toBeVisible()
  await expect(dialog.getByTestId('youtube-kind')).toHaveText('直播重播')
  await expect(dialog.getByTestId('youtube-chat')).toHaveText('有')
  await expect(dialog.getByTestId('youtube-heatmap')).toHaveText('有')
  await expect(dialog.getByTestId('youtube-rights-notice')).toContainText(YOUTUBE_RIGHTS_NOTICE)
  await expect(dialog.getByTestId('youtube-duplicate')).toHaveCount(0)
  // one audio track after the download: nothing to choose
  await expect(dialog.getByRole('combobox')).toHaveCount(0)
  // the video's language (zh-TW) preselects 中文
  const chinese = dialog.getByRole('radio', { name: '中文（含中英夾雜）' })
  await expect(chinese).toBeChecked()
  await chinese.check()
  await shot(page, testInfo, 'm3-youtube-preview')

  // ---- 下載並開始分析 ----
  const added = page.waitForResponse(res => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/videos')
  await dialog.getByTestId('youtube-submit').click()
  const addRes = await added
  expect(addRes.status()).toBe(200)
  const video = (await addRes.json()) as SourceVideo
  expect(video).toMatchObject({ title, sourceKind: 'youtube', youtubeUrl: watchUrl(id), filePath: null, media: null, language: 'zh', audioTrack: 0 })
  await expect(dialog).toBeHidden()

  // the library row shows the YouTube length and channel before the download
  const row = libraryRow(page, title)
  await expect(row).toBeVisible()
  await expect(row.getByText('YouTube', { exact: true })).toBeVisible()
  await expect(row).toContainText('測試頻道')
  await expect(row).toContainText('1:00')

  // ---- the video page while the Analysis runs: a YouTube 'full' run starts with 下載影片 (the fake
  // download takes about a second, so the list of steps is what can be seen reliably here; the
  // slow-download test below sees the step while it runs) ----
  await row.getByRole('link', { name: title, exact: true }).click()
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible()
  expect(videoIdOf(page)).toBe(video.id)
  const progress = page.getByTestId('analysis-progress')
  await expect(progress).toContainText('下載影片')
  await expect(progress).toContainText('分析音量、逐字稿、聊天室與重播熱度')
  const finished = await waitForAnalysisFinished(page.request, video.id)
  expect(finished.analysis).toMatchObject({ status: 'done', mode: 'full', error: null })
  expect(finished.filePath).toBe(path.join(downloadsDir(), `${video.id}.mkv`))
  expect(downloadsOf(video.id)).toEqual([`${video.id}.live_chat.json`, `${video.id}.mkv`])

  // ---- 這次的候選依據: loudness, the transcript, the chat and the heatmap ----
  const highlights = page.locator('section').filter({ has: page.getByRole('heading', { name: '精華片段', exact: true }) })
  const summary = highlights.getByTestId('signal-summary')
  await expect(summary).toContainText('這次的候選依據：音量、逐字稿（AI）、聊天室、重播熱度')
  await expect(summary).toContainText(/聊天室：平均每分鐘 [\d.]+ 則/)
  await expect(summary).not.toContainText('沒有用到')
  const signals = Object.fromEntries((finished.analysis.signals ?? []).map(s => [s.kind, s.status]))
  expect(signals).toEqual({ loudness: 'used', transcript: 'used', chat: 'used', heatmap: 'used' })

  // ---- at least one candidate ----
  await highlights.getByRole('tab', { name: /候選/ }).click()
  const items = highlights.getByRole('listitem')
  await expect(items.first()).toBeVisible()
  expect(await items.count()).toBeGreaterThanOrEqual(1)
  await expect(items.first().getByText('候選', { exact: true })).toBeVisible()
  await expect(items.first()).toContainText(/精華分數 \d{1,3}/)

  // ---- 在 YouTube 開啟 and the channel ----
  const link = page.getByTestId('youtube-link')
  await expect(link).toHaveText('在 YouTube 開啟')
  await expect(link).toHaveAttribute('href', watchUrl(id))
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(page.getByTestId('youtube-channel')).toContainText('測試頻道')
  await shot(page, testInfo, 'm3-youtube-video')

  // ---- the same link again: 這支影片已在影片庫, with a link to the video ----
  await page.getByRole('link', { name: '影片庫' }).first().click()
  await expect(page.getByRole('heading', { name: '影片庫', level: 1 })).toBeVisible()
  await waitForAnalysisDone(page, title)
  const again = await openYoutubeTab(page)
  await probe(again, watchUrl(id))
  const duplicate = again.getByTestId('youtube-duplicate')
  await expect(duplicate).toContainText('這支影片已在影片庫')
  await expect(again.getByTestId('youtube-submit')).toBeDisabled()
  await duplicate.getByRole('link', { name: '前往影片頁' }).click()
  await expect(again).toBeHidden()
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible()
  expect(videoIdOf(page)).toBe(video.id)

  // ---- remove it: the downloaded video and chat replay go with it ----
  await page.getByRole('link', { name: '影片庫' }).first().click()
  await deleteFromLibrary(page, title)
  expect(downloadsOf(video.id)).toEqual([])
})

test('YouTube link errors: playlist, not YouTube, private video, live stream', async ({ page }, testInfo) => {
  await page.goto('/')
  const dialog = await openYoutubeTab(page)
  const input = dialog.getByTestId('youtube-url-input')
  const button = dialog.getByTestId('youtube-probe-button')
  const probeError = dialog.getByTestId('youtube-probe-error')

  // nothing typed yet: no message, nothing to read
  await expect(button).toBeDisabled()

  // checked as it is typed, with the parser the server uses
  await input.fill('https://www.youtube.com/playlist?list=PL1234567890abcdef')
  await expect(dialog.getByText('不支援播放清單或頻道，請貼單一影片的連結')).toBeVisible()
  await expect(button).toBeDisabled()
  await input.fill('https://www.youtube.com/@some-channel')
  await expect(dialog.getByText('不支援播放清單或頻道，請貼單一影片的連結')).toBeVisible()
  await expect(button).toBeDisabled()
  await input.fill('https://example.com/watch?v=ggVodChat01')
  await expect(dialog.getByText('這不是 YouTube 影片連結')).toBeVisible()
  await expect(button).toBeDisabled()
  await shot(page, testInfo, 'm3-youtube-playlist')

  // errors from yt-dlp, in Chinese (422 from POST /api/youtube/probe)
  await probe(dialog, watchUrl(ids.private))
  await expect(probeError).toContainText(YTDLP_ERROR_MESSAGES.private!)
  await expect(probeError).toContainText('這是私人影片，無法下載')
  await expect(dialog.getByTestId('youtube-preview')).toHaveCount(0)
  await shot(page, testInfo, 'm3-youtube-private')

  await probe(dialog, `https://www.youtube.com/live/${ids.liveNow}`)
  await expect(probeError).toContainText('還在直播中或還沒開始的直播不能加入，結束後再來')
  await expect(probeError).not.toContainText('私人影片')
  await expect(dialog.getByTestId('youtube-preview')).toHaveCount(0)

  // nothing was added
  const videos = (await (await page.request.get('/api/videos')).json()) as SourceVideo[]
  expect(videos.filter(v => v.sourceKind === 'youtube')).toEqual([])
})

test('YouTube download in progress: 下載影片 is shown, and removing the video stops it and deletes the partial download', async ({ page }) => {
  // the fake takes 50 × GG_FAKE_YTDLP_SLOW_MS (1 s, playwright.config.ts) for this id's video download
  const id = ids.slowDownload
  const title = titleOf(id)

  await page.goto('/')
  const dialog = await openYoutubeTab(page)
  await probe(dialog, watchUrl(id))
  await expect(dialog.getByTestId('youtube-preview')).toContainText(title)
  await dialog.getByTestId('youtube-submit').click()
  await expect(dialog).toBeHidden()

  // the library row: the running step is 下載影片
  const row = libraryRow(page, title)
  await expect(row.getByText('下載影片', { exact: true })).toBeVisible({ timeout: 30_000 })

  // the video page: 正在下載影片 and the download hint
  await row.getByRole('link', { name: title, exact: true }).click()
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible()
  const videoId = videoIdOf(page)
  await expect(page.getByText('正在下載影片', { exact: true })).toBeVisible()
  await expect(page.getByText(DOWNLOAD_HINT, { exact: true })).toBeVisible()
  // the partial download is in data/downloads
  await expect.poll(() => downloadsOf(videoId).length).toBeGreaterThan(0)

  // remove it while yt-dlp is still downloading
  await page.getByRole('link', { name: '影片庫' }).first().click()
  await deleteFromLibrary(page, title)
  expect(downloadsOf(videoId)).toEqual([])
  // nothing comes back once the (killed) download would have written more
  await page.waitForTimeout(1500)
  expect(downloadsOf(videoId)).toEqual([])
  expect((await page.request.get(`/api/videos/${encodeURIComponent(videoId)}`)).status()).toBe(404)
})
