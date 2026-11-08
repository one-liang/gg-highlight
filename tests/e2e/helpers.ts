// Shared steps for the e2e specs.
import fs from 'node:fs'
import path from 'node:path'
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test'
import { FIXTURES_DIR } from '../fixtures/make-fixtures.mjs'

export { FIXTURES_DIR }
export const SAMPLE_EN_MKV = path.join(FIXTURES_DIR, 'sample-en.mkv')
export const SAMPLE_EN_MP4 = path.join(FIXTURES_DIR, 'sample-en.mp4')

/** Analysis with the tiny model on CPU, plus the preview remux. */
export const ANALYSIS_TIMEOUT = 3 * 60_000
/** One libx264 export of a ~10 s 1080x1920 clip. */
export const EXPORT_TIMEOUT = 3 * 60_000

/**
 * Full-page screenshot attached to the report; also written to $E2E_SHOTS_DIR/<name>.png when set
 * (for looking at the pages without opening the report).
 */
export async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  // the header and the transcript column are sticky: capture from the top, without hover tooltips
  await page.mouse.move(0, 0)
  await page.evaluate(() => window.scrollTo(0, 0))
  const body = await page.screenshot({ fullPage: true, animations: 'disabled' })
  await testInfo.attach(name, { body, contentType: 'image/png' })
  const dir = process.env.E2E_SHOTS_DIR
  if (dir) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${name}.png`), body)
  }
}

/** Row of a video in the library list, found by its title. */
export function libraryRow(page: Page, title: string): Locator {
  return page.locator('li').filter({ has: page.getByRole('link', { name: title, exact: true }) })
}

/** Picks the language and analysis audio track in the add-video form, then starts the analysis. */
export async function chooseAndStart(dialog: Locator, page: Page, opts: { language: 'English' | '中文（含中英夾雜）', track?: number }): Promise<void> {
  // the probe result (duration etc.) is shown before the choices
  await expect(dialog.getByText('長度', { exact: true })).toBeVisible()
  await dialog.getByRole('radio', { name: opts.language }).check()
  if (opts.track !== undefined) {
    await dialog.getByRole('combobox').click()
    await page.getByRole('option', { name: new RegExp(`^音軌 ${opts.track}：`) }).click()
    await expect(dialog.getByRole('combobox')).toContainText(`音軌 ${opts.track}：`)
  }
  await dialog.getByRole('button', { name: '開始分析' }).click()
  await expect(dialog).toBeHidden()
}

/** Waits until the library row shows the analysis as 完成. */
export async function waitForAnalysisDone(page: Page, title: string): Promise<Locator> {
  const row = libraryRow(page, title)
  await expect(row).toBeVisible()
  await expect(row.getByText('失敗', { exact: true })).toHaveCount(0)
  await expect(row.getByText('完成', { exact: true })).toBeVisible({ timeout: ANALYSIS_TIMEOUT })
  return row
}

/** Deletes a video from the library through the row's trash button and the confirm dialog. */
export async function deleteFromLibrary(page: Page, title: string): Promise<void> {
  const row = libraryRow(page, title)
  await row.getByRole('button', { name: '從影片庫移除' }).click()
  const dialog = page.getByRole('dialog', { name: '從影片庫移除？' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(title)
  await dialog.getByRole('button', { name: '移除', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(row).toHaveCount(0)
}
