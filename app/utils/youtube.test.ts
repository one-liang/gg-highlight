import { describe, expect, it } from 'vitest'
import type { MediaInfo, YoutubeMeta } from '../../shared/types/domain'
import { NOT_YOUTUBE_MESSAGE, PLAYLIST_OR_CHANNEL_MESSAGE } from '../../shared/utils/youtube-url'
import {
  chatAvailabilityText,
  formatUploadDate,
  heatmapAvailabilityText,
  languageFromHint,
  videoDurationSec,
  YOUTUBE_PROBE_LOADING_TEXT,
  YOUTUBE_RIGHTS_NOTICE,
  youtubeAddBody,
  youtubeInputState,
  youtubeKindLabel,
  youtubeWatchUrl,
} from './youtube'

const ID = 'dQw4w9WgXcQ'
const CANONICAL = `https://www.youtube.com/watch?v=${ID}`

const media: MediaInfo = { durationSec: 125.4, width: 1920, height: 1080, fps: 30, videoCodec: 'h264', container: 'mov,mp4', audioTracks: [] }
const meta: YoutubeMeta = {
  id: ID,
  channel: '頻道',
  durationSec: 3725,
  liveStatus: 'was_live',
  uploadDate: '2026-10-01',
  chatAvailable: true,
  heatmapAvailable: false,
}

describe('youtubeInputState', () => {
  it('stays quiet while nothing is typed', () => {
    expect(youtubeInputState('')).toEqual({ kind: 'empty' })
    expect(youtubeInputState('   \n')).toEqual({ kind: 'empty' })
  })

  it('accepts any single-video form and gives the canonical URL', () => {
    expect(youtubeInputState(`https://youtu.be/${ID}?si=abc&t=30`)).toEqual({ kind: 'valid', id: ID, url: CANONICAL })
    expect(youtubeInputState(`  https://www.youtube.com/live/${ID}  `)).toEqual({ kind: 'valid', id: ID, url: CANONICAL })
    expect(youtubeInputState(`https://www.youtube.com/watch?v=${ID}&list=PL123`)).toEqual({ kind: 'valid', id: ID, url: CANONICAL })
  })

  it('explains what is wrong, with the server\'s messages', () => {
    expect(youtubeInputState('https://example.com/watch?v=abc')).toEqual({ kind: 'invalid', message: NOT_YOUTUBE_MESSAGE })
    expect(youtubeInputState('隨便打的字')).toEqual({ kind: 'invalid', message: NOT_YOUTUBE_MESSAGE })
    expect(youtubeInputState('https://www.youtube.com/playlist?list=PL123')).toEqual({ kind: 'invalid', message: PLAYLIST_OR_CHANNEL_MESSAGE })
    expect(youtubeInputState('https://www.youtube.com/@someone')).toEqual({ kind: 'invalid', message: PLAYLIST_OR_CHANNEL_MESSAGE })
  })
})

describe('YouTube preview texts', () => {
  it('names the kind of video', () => {
    expect(youtubeKindLabel('was_live')).toBe('直播重播')
    expect(youtubeKindLabel('not_live')).toBe('影片')
    expect(youtubeKindLabel(null)).toBe('影片')
  })

  it('says whether the chat replay and the heatmap exist', () => {
    expect(chatAvailabilityText(true)).toBe('有')
    expect(chatAvailabilityText(false)).toBe('沒有')
    expect(heatmapAvailabilityText(true)).toBe('有')
    expect(heatmapAvailabilityText(false)).toBe('還沒有')
  })

  it('has the loading text and the rights notice of design.md', () => {
    expect(YOUTUBE_PROBE_LOADING_TEXT).toBe('正在向 YouTube 讀取影片資訊…（約 5–20 秒）')
    expect(YOUTUBE_RIGHTS_NOTICE).toBe('請只下載你自己擁有或已取得授權的影片。影片檔會存在 data/downloads/，從影片庫移除時一起刪除。')
  })

  it('formats the upload date', () => {
    expect(formatUploadDate('2026-10-01')).toBe('2026/10/01')
    expect(formatUploadDate('20261001')).toBe('2026/10/01')
    expect(formatUploadDate(null)).toBe('')
    expect(formatUploadDate('昨天')).toBe('')
  })
})

describe('adding a YouTube video', () => {
  it('preselects the hinted language, 中文 otherwise', () => {
    expect(languageFromHint('en')).toBe('en')
    expect(languageFromHint('zh')).toBe('zh')
    expect(languageFromHint(null)).toBe('zh')
    expect(languageFromHint(undefined)).toBe('zh')
  })

  it('sends the canonical URL with audio track 0', () => {
    expect(youtubeAddBody({ url: CANONICAL }, 'en')).toEqual({ sourceKind: 'youtube', youtubeUrl: CANONICAL, language: 'en', audioTrack: 0 })
  })
})

describe('YouTube videos in the Library', () => {
  it('shows the probed length, else YouTube\'s length before the download', () => {
    expect(videoDurationSec({ media, youtube: meta })).toBe(125.4)
    expect(videoDurationSec({ media: null, youtube: meta })).toBe(3725)
    expect(videoDurationSec({ media: null, youtube: { ...meta, durationSec: null } })).toBeNull()
    expect(videoDurationSec({ media: null, youtube: null })).toBeNull()
    expect(videoDurationSec({ media, youtube: null })).toBe(125.4)
  })

  it('links YouTube videos to their watch page only', () => {
    expect(youtubeWatchUrl({ sourceKind: 'youtube', youtubeUrl: CANONICAL })).toBe(CANONICAL)
    expect(youtubeWatchUrl({ sourceKind: 'youtube', youtubeUrl: null })).toBeNull()
    expect(youtubeWatchUrl({ sourceKind: 'upload', youtubeUrl: CANONICAL })).toBeNull()
    expect(youtubeWatchUrl({ sourceKind: 'youtube', youtubeUrl: 'javascript:alert(1)' })).toBeNull()
  })
})
