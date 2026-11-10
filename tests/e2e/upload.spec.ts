// Upload through the 上傳檔案 tab: the copy is probed, added, analysed, and removed with the video.
import fs from 'node:fs'
import path from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { chooseAndStart, deleteFromLibrary, libraryRow, SAMPLE_EN_MP4, waitForAnalysisDone } from './helpers'

const TITLE = 'sample-en'

test('uploaded video is analysed and can be removed', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '影片庫', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: '加入影片' }).first().click()
  const dialog = page.getByRole('dialog', { name: '加入影片' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('tab', { name: '上傳檔案' }).click()

  await dialog.locator('input[type="file"]').setInputFiles(SAMPLE_EN_MP4)
  // after the upload the form shows the file and its probe result
  await expect(dialog.getByText('sample-en.mp4', { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(dialog.getByText('已上傳・')).toBeVisible()
  await expect(dialog.getByText('1280×720')).toBeVisible()
  // one audio track: nothing to choose, but the select shows it
  await expect(dialog.getByRole('combobox')).toContainText('音軌 1：')
  await chooseAndStart(dialog, page, { language: 'English' })

  const row = await waitForAnalysisDone(page, TITLE)
  await expect(row.getByText('上傳', { exact: true })).toBeVisible()

  await row.getByRole('link', { name: TITLE, exact: true }).click()
  await expect(page.getByRole('heading', { name: TITLE, level: 1 })).toBeVisible()
  const transcript = page.locator('section').filter({ has: page.getByRole('heading', { name: '逐字稿' }) })
  await expect(transcript.getByTitle('點一下修改文字').first()).toBeVisible()
  await expect(transcript).toContainText(/hello|welcome|stream/i)

  // the preview of an mp4 upload is the uploaded file itself
  const media = await page.request.get(page.url().replace(/\/videos\/([^/?#]+).*$/, '/api/videos/$1/media'), { headers: { Range: 'bytes=0-99' } })
  expect(media.status()).toBe(206)

  await page.getByRole('link', { name: '影片庫' }).first().click()
  await expect(libraryRow(page, TITLE)).toBeVisible()
  await deleteFromLibrary(page, TITLE)
})

test('closing the dialog during an upload cancels it, and the dialog still closes normally afterwards', async ({ page }) => {
  const uploadsDir = path.join(process.env.GG_E2E_DATA_DIR!, 'uploads')
  const listUploads = () => (fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir).sort() : [])
  const before = listUploads()

  await page.goto('/')
  await page.getByRole('button', { name: '加入影片' }).first().click()
  const dialog = page.getByRole('dialog', { name: '加入影片' })
  await dialog.getByRole('tab', { name: '上傳檔案' }).click()

  // slow the upload down so it is still running when the dialog closes
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 256 * 1024 })
  await dialog.locator('input[type="file"]').setInputFiles(SAMPLE_EN_MP4)
  await expect(dialog.getByRole('progressbar')).toBeVisible()
  await expect(dialog.getByText('已上傳 ')).toBeVisible()
  // Esc / clicking outside must not interrupt a running upload…
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  // …but the close button does, and cancels it
  await dialog.getByRole('button', { name: '關閉' }).click()
  await expect(dialog).toBeHidden()
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })

  // the partial copy is removed
  await expect.poll(listUploads, { timeout: 10_000 }).toEqual(before)

  // reopened, the dialog is dismissible again (it used to stay locked as if still uploading)
  await page.getByRole('button', { name: '加入影片' }).first().click()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('tab', { name: '影片資料夾' })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

/** Dispatches a file dragover + drop on the first element matching `selector`, like dropping a video from Explorer. */
function dropFile(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const target = document.querySelector(sel)!
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array(4096).fill(7)], 'dropped.mkv', { type: 'video/x-matroska' }))
    // A constructed DataTransfer ignores dropEffect writes; record them instead, starting from what
    // the browser starts a real file drag with.
    let dropEffect = 'copy'
    Object.defineProperty(dt, 'dropEffect', { configurable: true, get: () => dropEffect, set: (v: string) => { dropEffect = v } })
    const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })
    target.dispatchEvent(over)
    const effectAfterOver = dropEffect
    const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
    target.dispatchEvent(drop)
    // not cancelled = the browser would open the file in place of the app
    return { over: over.defaultPrevented, drop: drop.defaultPrevented, dropEffect: effectAfterOver }
  }, selector)
}

test('a video dropped outside the upload drop zone does not replace the app; the drop zone takes it', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '影片庫', level: 1 })).toBeVisible()
  expect(await dropFile(page, 'main')).toEqual({ over: true, drop: true, dropEffect: 'none' })

  await page.getByRole('button', { name: '加入影片' }).first().click()
  const dialog = page.getByRole('dialog', { name: '加入影片' })
  await expect(dialog).toBeVisible()
  // the 影片資料夾 tab is shown: the upload drop zone is hidden
  expect(await dropFile(page, '[role="dialog"]')).toEqual({ over: true, drop: true, dropEffect: 'none' })

  await dialog.getByRole('tab', { name: '上傳檔案' }).click()
  await expect(dialog.getByText('把影片拖到這裡，或點一下選擇檔案')).toBeVisible()
  const zone = await dropFile(page, '[role="dialog"] label:has(input[type="file"])')
  expect(zone.over).toBe(true)
  expect(zone.drop).toBe(true)
  expect(zone.dropEffect).toBe('copy')
  // the drop zone uploaded the (unreadable) file and says why it cannot be used
  await expect(dialog.getByText('無法讀取這個影片檔：')).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(/\/$/)
})

test('an unreadable upload shows why, without internal paths', async ({ page }, testInfo) => {
  const broken = testInfo.outputPath('broken.mp4')
  fs.writeFileSync(broken, Buffer.alloc(64 * 1024, 7))

  await page.goto('/')
  await page.getByRole('button', { name: '加入影片' }).first().click()
  const dialog = page.getByRole('dialog', { name: '加入影片' })
  await dialog.getByRole('tab', { name: '上傳檔案' }).click()
  await dialog.locator('input[type="file"]').setInputFiles(broken)

  const alert = dialog.getByText('無法讀取這個影片檔：')
  await expect(alert).toBeVisible()
  await expect(alert).not.toContainText('uploads')
  await expect(alert).not.toContainText('無法讀取影片：')
  // still on the picker, ready for another file
  await expect(dialog.getByText('把影片拖到這裡，或點一下選擇檔案')).toBeVisible()
})
