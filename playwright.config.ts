// End-to-end tests through the real browser UI: `pnpm test:e2e`.
// The webServer builds the app when the sources changed, then runs the production server on a free
// port with a fresh data folder, the tiny ASR model on CPU and libx264. A fake Ollama
// (server/lib/llm/test-helpers/fake-ollama.mjs, scenario 'ok') stands in for the local LLM; specs
// switch its scenario with POST $GG_E2E_OLLAMA_URL/__scenario. A fake yt-dlp
// (server/lib/youtube/test-helpers/fake-yt-dlp.mjs) stands in for YouTube: the video id in the link
// picks the scenario, and a download copies the 60 s highlights-zh.mkv fixture.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'
import { FIXTURES_DIR } from './tests/fixtures/make-fixtures.mjs'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

// Playwright loads this file in the runner and again in every worker: pick the port and the data
// folder once and hand them to the workers through the environment they inherit.
function freePortSync(): number {
  const script = 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})'
  return Number(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }))
}
process.env.GG_E2E_PORT ??= String(freePortSync())
if (!process.env.GG_E2E_OLLAMA_PORT) {
  let ollamaPort = freePortSync()
  while (String(ollamaPort) === process.env.GG_E2E_PORT) ollamaPort = freePortSync()
  process.env.GG_E2E_OLLAMA_PORT = String(ollamaPort)
}
process.env.GG_E2E_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'gg-e2e-'))

const port = Number(process.env.GG_E2E_PORT)
const baseURL = `http://127.0.0.1:${port}`
const ollamaPort = Number(process.env.GG_E2E_OLLAMA_PORT)
const ollamaUrl = `http://127.0.0.1:${ollamaPort}`
process.env.GG_E2E_OLLAMA_URL = ollamaUrl

export default defineConfig({
  testDir: 'tests/e2e',
  // One app, one analysis / export queue: run the specs one after another.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  // Analysis (tiny model on CPU) and two exports with libx264 take a while.
  timeout: 5 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  use: {
    baseURL,
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      // Use a specific Chromium build (e.g. an older one already on the machine) instead of
      // the one `npx playwright install chromium` downloads.
      executablePath: process.env.PW_CHROMIUM_PATH || undefined,
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [{
    // never a developer's real Ollama: e2e runs must not depend on (or load) a 6.6 GB model
    command: `node server/lib/llm/test-helpers/fake-ollama.mjs --port ${ollamaPort} --scenario ok`,
    url: `${ollamaUrl}/api/version`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
  }, {
    command: 'node tests/e2e/server.mjs',
    url: `${baseURL}/api/system`,
    reuseExistingServer: false,
    // includes `pnpm build` when the sources changed
    timeout: 5 * 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      HOST: '127.0.0.1',
      PORT: String(port),
      GG_DATA_DIR: process.env.GG_E2E_DATA_DIR,
      GG_ASR_MODEL_ZH: 'Systran/faster-whisper-tiny',
      GG_ASR_MODEL_EN: 'Systran/faster-whisper-tiny',
      GG_ASR_DEVICE: 'cpu',
      GG_VIDEO_ENCODER: 'libx264',
      GG_OLLAMA_URL: ollamaUrl,
      GG_OLLAMA_MODEL: 'qwen3.5:9b',
      // never the real yt-dlp (and no install or update into tools/)
      GG_YTDLP_CMD: JSON.stringify([process.execPath, path.join(rootDir, 'server', 'lib', 'youtube', 'test-helpers', 'fake-yt-dlp.mjs')]),
      GG_FAKE_YTDLP_MEDIA: path.join(FIXTURES_DIR, 'highlights-zh.mkv'),
      GG_FAKE_YTDLP_DURATION: '60',
      // the heatmap burst at 33–39 s: with the default (20–26 s) it starts inside the first 30 s, which
      // the heatmap Signal flattens (design.md「重播熱度」step 2), so the Signal would be missing
      GG_FAKE_YTDLP_HEATMAP_PEAK: '36',
      // ggSlowDl001's download takes 50 steps × 1 s: youtube.spec.ts removes the video while it runs
      GG_FAKE_YTDLP_SLOW_MS: '1000',
      GG_FAKE_YTDLP_LOG_DIR: path.join(process.env.GG_E2E_DATA_DIR!, 'fake-yt-dlp-logs'),
    },
  }],
})
