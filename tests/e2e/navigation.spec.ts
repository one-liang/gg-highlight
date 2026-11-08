// Pages that do not exist: an unknown URL and a removed video.
import { expect, test } from '@playwright/test'

test('unknown page shows a zh-TW 404 inside the app with a way back', async ({ page }) => {
  await page.goto('/no-such-page')
  await expect(page.getByText('找不到這個頁面')).toBeVisible()
  await expect(page.getByText('「/no-such-page」')).toBeVisible()
  await expect(page.getByRole('navigation', { name: '主要導覽' })).toBeVisible()
  await page.getByRole('button', { name: '回到影片庫' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: '影片庫', level: 1 })).toBeVisible()

  // the header navigation also leaves the error page
  await page.goto('/no-such-page')
  await expect(page.getByText('找不到這個頁面')).toBeVisible()
  await page.getByRole('navigation', { name: '主要導覽' }).getByRole('link', { name: '設定' }).click()
  await expect(page.getByRole('heading', { name: '設定', level: 1 })).toBeVisible()
})

test('a video that is not in the library', async ({ page }) => {
  await page.goto('/videos/does-not-exist')
  await expect(page.getByText('找不到這支影片')).toBeVisible()
  await page.getByRole('link', { name: '回到影片庫' }).click()
  await expect(page.getByRole('heading', { name: '影片庫', level: 1 })).toBeVisible()
})
