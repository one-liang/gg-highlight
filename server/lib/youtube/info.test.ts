import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertAddable, isoUploadDate, languageHintOf, parseMetadata } from './info'
import { YtdlpError } from './types'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-fixtures', 'heatmap')
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))
const NOW = new Date('2026-11-09T12:00:00.000Z')

const full = {
  _type: 'video',
  id: 'ggVodChat01',
  title: '測試直播重播',
  channel: '測試頻道',
  uploader: '上傳者',
  duration: 3605.5,
  live_status: 'was_live',
  upload_date: '20261101',
  language: 'zh-TW',
  subtitles: { live_chat: [{ url: 'https://www.youtube.com/watch?v=ggVodChat01', ext: 'json', protocol: 'youtube_live_chat_replay' }] },
  heatmap: [
    { start_time: 0, end_time: 36.055, value: 1 },
    { start_time: 36.055, end_time: 72.11, value: 0.25 },
  ],
  formats: [{ format_id: '137' }],
  automatic_captions: { en: [] },
}

describe('parseMetadata', () => {
  it('keeps the needed fields', () => {
    expect(parseMetadata(full, NOW)).toEqual({
      id: 'ggVodChat01',
      url: 'https://www.youtube.com/watch?v=ggVodChat01',
      title: '測試直播重播',
      channel: '測試頻道',
      durationSec: 3605.5,
      liveStatus: 'was_live',
      uploadDate: '2026-11-01',
      chatAvailable: true,
      heatmapAvailable: true,
      heatmap: [
        { start: 0, end: 36.055, value: 1 },
        { start: 36.055, end: 72.11, value: 0.25 },
      ],
      languageHint: 'zh',
      fetchedAt: '2026-11-09T12:00:00.000Z',
    })
  })

  it('tolerates missing and odd fields', () => {
    const meta = parseMetadata({ id: 'abcdefghijk', duration: 'long', live_status: 'something_new', upload_date: '2026-11-01', subtitles: [], heatmap: 'x', language: 42 }, NOW)
    expect(meta).toMatchObject({
      id: 'abcdefghijk',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
      title: 'abcdefghijk',
      channel: null,
      durationSec: null,
      liveStatus: null,
      uploadDate: null,
      chatAvailable: false,
      heatmapAvailable: false,
      heatmap: null,
      languageHint: null,
    })
  })

  it('falls back from channel to uploader and from title to fulltitle', () => {
    const meta = parseMetadata({ id: 'abcdefghijk', uploader: '上傳者', fulltitle: '完整標題' }, NOW)
    expect(meta.channel).toBe('上傳者')
    expect(meta.title).toBe('完整標題')
  })

  it('chat is available only with a non-empty subtitles.live_chat', () => {
    expect(parseMetadata({ id: 'abcdefghijk', subtitles: { live_chat: [] } }).chatAvailable).toBe(false)
    expect(parseMetadata({ id: 'abcdefghijk', subtitles: { en: [{}] } }).chatAvailable).toBe(false)
    expect(parseMetadata({ id: 'abcdefghijk', subtitles: { live_chat: [{ ext: 'json' }] } }).chatAvailable).toBe(true)
  })

  it('heatmap: drops broken buckets; null when absent, null or empty', () => {
    const meta = parseMetadata({ id: 'abcdefghijk', heatmap: [{ start_time: 0, end_time: 1, value: 0.5 }, { start_time: 'x' }, null] })
    expect(meta.heatmap).toEqual([{ start: 0, end: 1, value: 0.5 }])
    expect(parseMetadata({ id: 'abcdefghijk', heatmap: [] }).heatmap).toBeNull()
    expect(parseMetadata({ id: 'abcdefghijk', heatmap: null }).heatmapAvailable).toBe(false)
    expect(parseMetadata({ id: 'abcdefghijk', heatmap: [{ start_time: 'x' }] }).heatmap).toBeNull()
  })

  it('reads the -J shaped heatmap fixtures', () => {
    const names = fs.readdirSync(FIXTURES).filter(n => n.startsWith('heatmap_'))
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      const raw = fixture(name)
      const meta = parseMetadata(raw, NOW)
      expect(meta.id).toBe(raw.id)
      expect(meta.heatmapAvailable).toBe(true)
      expect(meta.heatmap).toHaveLength(raw.heatmap.length)
      expect(meta.heatmap![0]).toEqual({ start: raw.heatmap[0].start_time, end: raw.heatmap[0].end_time, value: raw.heatmap[0].value })
      expect(meta.durationSec).toBe(raw.duration ?? null)
    }
    for (const name of fs.readdirSync(FIXTURES).filter(n => n.startsWith('no_heatmap_'))) {
      const meta = parseMetadata(fixture(name), NOW)
      expect(meta.heatmap).toBeNull()
      expect(meta.heatmapAvailable).toBe(false)
    }
  })

  it('a playlist or other non-video result → not-video (422)', () => {
    let error: unknown
    try {
      parseMetadata({ _type: 'playlist', id: 'PLabc', entries: [] })
    }
    catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(YtdlpError)
    expect((error as YtdlpError).kind).toBe('not-video')
    expect((error as YtdlpError).message).toBe('不支援播放清單或頻道，請貼單一影片的連結')
    expect((error as YtdlpError).httpStatus).toBe(422)
  })

  it('not metadata at all → unknown', () => {
    for (const bad of [null, 'x', [1], {}, { id: '' }]) {
      expect(() => parseMetadata(bad)).toThrow(YtdlpError)
    }
  })
})

describe('assertAddable', () => {
  it('accepts not_live, was_live and an unknown status', () => {
    for (const liveStatus of ['not_live', 'was_live', null] as const) expect(() => assertAddable({ liveStatus })).not.toThrow()
  })

  it.each([
    ['is_live', 'live', '還在直播中或還沒開始的直播不能加入，結束後再來'],
    ['is_upcoming', 'live', '還在直播中或還沒開始的直播不能加入，結束後再來'],
    ['post_live', 'post-live', '直播剛結束，YouTube 還在處理重播，請過一段時間再加入'],
  ] as const)('%s → %s', (liveStatus, kind, message) => {
    let error: unknown
    try {
      assertAddable({ liveStatus })
    }
    catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(YtdlpError)
    expect((error as YtdlpError).kind).toBe(kind)
    expect((error as YtdlpError).message).toBe(message)
    expect((error as YtdlpError).httpStatus).toBe(422)
  })
})

describe('field helpers', () => {
  it('languageHintOf: zh* → zh, en* → en, else null', () => {
    expect(languageHintOf('zh-TW')).toBe('zh')
    expect(languageHintOf('zh-Hant')).toBe('zh')
    expect(languageHintOf('ZH')).toBe('zh')
    expect(languageHintOf('en-US')).toBe('en')
    expect(languageHintOf('en')).toBe('en')
    expect(languageHintOf('ja')).toBeNull()
    expect(languageHintOf('')).toBeNull()
    expect(languageHintOf(null)).toBeNull()
  })

  it('isoUploadDate: YYYYMMDD → YYYY-MM-DD', () => {
    expect(isoUploadDate('20261101')).toBe('2026-11-01')
    expect(isoUploadDate('2026-11-01')).toBeNull()
    expect(isoUploadDate('202611')).toBeNull()
    expect(isoUploadDate(undefined)).toBeNull()
  })
})
