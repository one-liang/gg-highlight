// The whole milestone-1 flow through the UI: Watch Folder → add video → analysis → edit the
// transcript → manual Highlight → two exports → downloads → status changes → remove from the library.
import fs from 'node:fs'
import { expect, test } from '@playwright/test'
import {
  chooseAndStart, deleteFromLibrary, EXPORT_TIMEOUT, FIXTURES_DIR, libraryRow, SAMPLE_EN_MKV, shot, waitForAnalysisDone,
} from './helpers'

const TITLE = 'sample-en'
const EDITED_TEXT = 'E2E 修改過的字幕'

test('watch folder video: analyse, edit transcript, highlight, export, download, remove', async ({ page }, testInfo) => {
  // ---- 設定: add the fixtures folder as a Watch Folder ----
  await page.goto('/')
  await page.getByRole('navigation', { name: '主要導覽' }).getByRole('link', { name: '設定' }).click()
  await expect(page.getByRole('heading', { name: '設定', level: 1 })).toBeVisible()
  await page.getByRole('textbox', { name: '新增資料夾' }).fill(FIXTURES_DIR)
  await page.getByRole('button', { name: '加入', exact: true }).click()
  await expect(page.getByRole('button', { name: `移除 ${FIXTURES_DIR}` })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '新增資料夾' })).toHaveValue('')
  // system info finished loading (encoder badge, data folder)
  await expect(page.getByText('CPU 編碼（較慢）')).toBeVisible()
  // forced by GG_VIDEO_ENCODER, so it must not claim NVENC detection failed
  await expect(page.getByText('由環境變數 GG_VIDEO_ENCODER 指定。')).toBeVisible()
  await expect(page.getByText('沒有偵測到可用的 NVIDIA 硬體編碼器', { exact: false })).toHaveCount(0)
  await shot(page, testInfo, 'settings')

  // ---- 影片庫 → 加入影片 → pick sample-en.mkv ----
  await page.getByRole('navigation', { name: '主要導覽' }).getByRole('link', { name: '影片庫' }).click()
  await expect(page.getByRole('heading', { name: '影片庫', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: '加入影片' }).first().click()
  const dialog = page.getByRole('dialog', { name: '加入影片' })
  await expect(dialog).toBeVisible()
  const fileButton = dialog.getByRole('button', { name: /sample-en\.mkv/ })
  await expect(fileButton).toBeVisible()
  await shot(page, testInfo, 'add-video-folder-tab')

  await dialog.getByRole('tab', { name: '上傳檔案' }).click()
  await expect(dialog.getByText('把影片拖到這裡，或點一下選擇檔案')).toBeVisible()
  await shot(page, testInfo, 'add-video-upload-tab')
  await dialog.getByRole('tab', { name: '影片資料夾' }).click()

  await fileButton.click()
  await expect(dialog.getByText('sample-en.mkv', { exact: true })).toBeVisible()
  await chooseAndStart(dialog, page, { language: 'English', track: 2 })

  // ---- wait for the analysis ----
  const row = await waitForAnalysisDone(page, TITLE)
  await expect(row).toContainText('English')
  await shot(page, testInfo, 'library-done')

  // ---- video page ----
  await row.getByRole('link', { name: TITLE, exact: true }).click()
  await expect(page.getByRole('heading', { name: TITLE, level: 1 })).toBeVisible()
  await expect(page.getByText('分析用音軌 2')).toBeVisible()
  const transcript = page.locator('section').filter({ has: page.getByRole('heading', { name: '逐字稿' }) })
  const segmentTexts = transcript.getByTitle('點一下修改文字')
  await expect(segmentTexts.first()).toBeVisible()
  // track 2 is speech only; the tiny model recognises the greeting
  await expect(transcript).toContainText(/hello|welcome|stream/i)

  // edit the first segment
  const original = (await segmentTexts.first().textContent())?.trim()
  expect(original).toBeTruthy()
  await segmentTexts.first().click()
  const editor = transcript.getByRole('textbox', { name: '修改這段逐字稿' })
  await expect(editor).toBeFocused()
  await editor.fill(EDITED_TEXT)
  await editor.press('Enter')
  await expect(editor).toBeHidden()
  await expect(transcript.getByText(EDITED_TEXT, { exact: true })).toBeVisible()
  await expect(transcript.getByText('已修改', { exact: true })).toBeVisible()
  await expect(transcript).toContainText('已修改 1 段')

  // ---- manual highlight with typed start / end ----
  const creator = page.locator('section').filter({ has: page.getByRole('heading', { name: '新增精華片段' }) })
  await creator.getByRole('textbox', { name: '起點' }).fill('0:00.2')
  await creator.getByRole('textbox', { name: '終點' }).fill('0:09.5')
  await expect(creator).toContainText('9.3 秒')
  await creator.getByRole('button', { name: '新增精華片段' }).click()

  const highlights = page.locator('section').filter({ has: page.getByRole('heading', { name: '精華片段', exact: true }) })
  const item = highlights.getByRole('listitem').filter({ hasText: '0:00.2 – 0:09.5' })
  await expect(item).toBeVisible()
  await expect(item.getByText('選用', { exact: true })).toBeVisible()
  await expect(item.getByText('手動', { exact: true })).toBeVisible()
  // a manual Highlight was never a Candidate
  await expect(item.getByRole('button', { name: '改回候選' })).toHaveCount(0)
  // the creator is cleared for the next one
  await expect(creator.getByRole('textbox', { name: '起點' })).toHaveValue('')

  // ---- export: 模糊背景 + burned-in subtitles ----
  const clips = page.locator('section').filter({ has: page.getByRole('heading', { name: /^剪輯/ }) })
  await item.getByRole('button', { name: '輸出' }).click()
  const exportDialog = page.getByRole('dialog', { name: '輸出剪輯' })
  await expect(exportDialog).toBeVisible()
  await expect(exportDialog).toContainText('0:00.2 – 0:09.5')
  await expect(exportDialog.getByRole('radio', { name: /模糊背景/ })).toBeChecked()
  await expect(exportDialog.getByRole('switch', { name: '燒錄字幕' })).toBeChecked()
  await shot(page, testInfo, 'export-modal')
  // record every tooltip that opens from here on (one may open and close again within a frame)
  await page.evaluate(() => {
    const opened: string[] = []
    ;(window as unknown as { openedTooltips: string[] }).openedTooltips = opened
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue
          for (const el of [node, ...node.querySelectorAll('[role="tooltip"]')]) {
            if (el.getAttribute('role') === 'tooltip') opened.push(el.textContent?.trim() ?? '')
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
  await exportDialog.getByRole('button', { name: '開始輸出' }).click()
  await expect(exportDialog).toBeHidden()
  // the dialog gives focus back to 輸出, but a mouse user must not get its tooltip popping up over the list…
  const exportButton = item.getByRole('button', { name: '輸出' })
  await expect(exportButton).toBeFocused()
  await page.waitForTimeout(500)
  const openedTooltips = await page.evaluate(() => (window as unknown as { openedTooltips: string[] }).openedTooltips)
  expect(openedTooltips.filter(text => text === '用這段輸出一支剪輯')).toEqual([])
  // …while keyboard focus still shows it
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect(exportButton).toBeFocused()
  await expect(page.getByRole('tooltip')).toHaveText('用這段輸出一支剪輯')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tooltip')).toHaveCount(0)

  const blurredClip = clips.getByRole('listitem').filter({ hasText: '模糊背景' })
  await expect(blurredClip).toHaveCount(1)
  await expect(blurredClip.getByText('完成', { exact: true })).toBeVisible({ timeout: EXPORT_TIMEOUT })
  await expect(blurredClip).toContainText('已燒錄字幕')
  await expect(item).toContainText('已輸出 1 次')

  // downloads: 200, attachments, the srt has the edited text
  const videoHref = await blurredClip.getByRole('link', { name: '下載影片' }).getAttribute('href')
  const srtHref = await blurredClip.getByRole('link', { name: '下載字幕' }).getAttribute('href')
  expect(videoHref).toBeTruthy()
  expect(srtHref).toBeTruthy()
  const videoRes = await page.request.get(videoHref!)
  expect(videoRes.status()).toBe(200)
  expect(videoRes.headers()['content-type']).toBe('video/mp4')
  expect(videoRes.headers()['content-disposition']).toMatch(/^attachment;/)
  expect(decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(videoRes.headers()['content-disposition']!)![1]!)).toMatch(/^sample-en_.*_模糊背景\.mp4$/)
  const mp4 = await videoRes.body()
  expect(mp4.length).toBeGreaterThan(10_000)
  expect(mp4.subarray(4, 8).toString('latin1')).toBe('ftyp')

  const srtRes = await page.request.get(srtHref!)
  expect(srtRes.status()).toBe(200)
  expect(srtRes.headers()['content-disposition']).toMatch(/^attachment;/)
  expect(decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(srtRes.headers()['content-disposition']!)![1]!)).toMatch(/\.srt$/)
  const srt = await srtRes.text()
  expect(srt).toContain(EDITED_TEXT)
  expect(srt).not.toContain(original!)
  expect(srt).toMatch(/^1\r?\n00:00:00,000 --> /)

  // ---- export again: 原比例 without subtitles ----
  await item.getByRole('button', { name: '輸出' }).click()
  await expect(exportDialog).toBeVisible()
  await exportDialog.getByText('原比例', { exact: true }).click()
  await expect(exportDialog.getByRole('radio', { name: /原比例/ })).toBeChecked()
  await exportDialog.getByRole('switch', { name: '燒錄字幕' }).click()
  await expect(exportDialog.getByRole('switch', { name: '燒錄字幕' })).not.toBeChecked()
  await exportDialog.getByRole('button', { name: '開始輸出' }).click()
  await expect(exportDialog).toBeHidden()

  const originalClip = clips.getByRole('listitem').filter({ hasText: '原比例' })
  await expect(originalClip.getByText('完成', { exact: true })).toBeVisible({ timeout: EXPORT_TIMEOUT })
  await expect(originalClip).toContainText('未燒錄字幕')
  await expect(clips.getByRole('listitem')).toHaveCount(2)
  await expect(item).toContainText('已輸出 2 次')
  const originalHref = await originalClip.getByRole('link', { name: '下載影片' }).getAttribute('href')
  const originalRes = await page.request.get(originalHref!)
  expect(originalRes.status()).toBe(200)
  expect(originalRes.headers()['content-disposition']).toMatch(/^attachment;.*_%E5%8E%9F%E6%AF%94%E4%BE%8B\.mp4/)
  const originalSrt = await page.request.get((await originalClip.getByRole('link', { name: '下載字幕' }).getAttribute('href'))!)
  expect(originalSrt.status()).toBe(200)
  expect(await originalSrt.text()).toContain(EDITED_TEXT)

  await shot(page, testInfo, 'video-page')

  // ---- 捨棄 and back to 選用 ----
  await item.getByRole('button', { name: '捨棄', exact: true }).click()
  await expect(item.getByText('捨棄', { exact: true })).toBeVisible()
  await expect(highlights.getByRole('tab', { name: /捨棄/ })).toContainText('1')
  await item.getByRole('button', { name: '選用', exact: true }).click()
  await expect(item.getByText('選用', { exact: true })).toBeVisible()
  await expect(item.getByRole('button', { name: '捨棄', exact: true })).toBeVisible()

  // the status survives a reload
  await page.reload()
  await expect(page.getByRole('listitem').filter({ hasText: '0:00.2 – 0:09.5' }).getByText('選用', { exact: true })).toBeVisible()
  await expect(page.getByText(EDITED_TEXT, { exact: true })).toBeVisible()

  // ---- remove from the library; the Watch Folder file stays ----
  await page.getByRole('link', { name: '影片庫' }).first().click()
  await expect(libraryRow(page, TITLE)).toBeVisible()
  await deleteFromLibrary(page, TITLE)
  expect(fs.existsSync(SAMPLE_EN_MKV)).toBe(true)

  // the file can be picked again
  await page.getByRole('button', { name: '加入影片' }).first().click()
  await expect(dialog.getByRole('button', { name: /sample-en\.mkv/ })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: /sample-en\.mkv/ })).not.toContainText('已在影片庫')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})
