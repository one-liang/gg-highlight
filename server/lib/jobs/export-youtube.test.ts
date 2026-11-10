// The Export failure text for a YouTube video whose downloaded file is gone (export.ts; the rest of the
// Export is covered by export.test.ts).
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MISSING_SOURCE_MESSAGE } from './errors'
import { ExportQueue } from './export'
import { createJobTestEnv, type JobTestEnv } from './test-helpers/setup'

let env: JobTestEnv
let queue: ExportQueue | null = null

beforeEach(async () => {
  env = await createJobTestEnv()
})

afterEach(async () => {
  await queue?.stop()
  queue = null
  await env.cleanup()
})

async function exportOnce(sourceKind: 'youtube' | 'watch-folder', filePath: string | null) {
  const video = env.repos.videos.insert({
    title: '測試影片',
    sourceKind,
    filePath,
    youtubeUrl: sourceKind === 'youtube' ? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' : null,
    youtube: sourceKind === 'youtube'
      ? { id: 'dQw4w9WgXcQ', channel: null, durationSec: 10, liveStatus: 'not_live', uploadDate: null, chatAvailable: false, heatmapAvailable: false }
      : null,
    language: 'en',
    audioTrack: 0,
    media: null,
  })
  env.repos.videos.updateAnalysis(video.id, { status: 'done' })
  const highlight = env.repos.highlights.insert({ videoId: video.id, start: 1, end: 2, status: 'selected', origin: 'manual', score: null, reason: null })
  const clip = env.repos.clips.insert({ videoId: video.id, highlightId: highlight.id, start: 1, end: 2, layout: 'original', burnSubtitles: false })
  queue = new ExportQueue({ config: env.config, repos: env.repos, tools: env.tools, transcriberCommand: [], log: () => {} })
  queue.start()
  await queue.whenIdle()
  return env.repos.clips.get(clip.id)!
}

describe('Export of a video whose file is gone', () => {
  it('says the downloaded file is missing for YouTube', async () => {
    const gone = path.join(env.dataDir, 'downloads', 'gone.mp4')
    expect(await exportOnce('youtube', gone)).toMatchObject({ status: 'failed', error: '找不到下載的影片檔', fileName: null })
  })

  it('says the same before any download finished (no filePath yet)', async () => {
    expect(await exportOnce('youtube', null)).toMatchObject({ status: 'failed', error: '找不到下載的影片檔' })
  })

  it('keeps 找不到原始影片檔 for local videos', async () => {
    const gone = path.join(env.dataDir, 'gone.mkv')
    expect(await exportOnce('watch-folder', gone)).toMatchObject({ status: 'failed', error: MISSING_SOURCE_MESSAGE })
  })
})
