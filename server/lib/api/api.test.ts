import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { H3Error } from 'h3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addVideoSchema, allowedMethods, asHttpError, checkHighlightRange, clipDownloadName, createClipSchema, END_SLACK_SECONDS, fileNameClock, httpError, isHttpError,
  normalizeWatchFolders, parseIndexParam, parseWith, safeFileNamePart, settingsSchema, titleFromFileName, unreadableVideo,
  updateHighlightSchema, updateSegmentSchema,
} from '.'

function statusOf(fn: () => unknown): { statusCode: number, statusMessage: string } {
  try {
    fn()
  }
  catch (err) {
    const e = err as H3Error
    return { statusCode: e.statusCode, statusMessage: e.statusMessage ?? '' }
  }
  throw new Error('expected a throw')
}

async function statusOfAsync(fn: () => Promise<unknown>): Promise<{ statusCode: number, statusMessage: string }> {
  try {
    await fn()
  }
  catch (err) {
    const e = err as H3Error
    return { statusCode: e.statusCode, statusMessage: e.statusMessage ?? '' }
  }
  throw new Error('expected a throw')
}

describe('httpError', () => {
  it('builds an H3Error with the Chinese text as statusMessage and message', () => {
    const err = httpError(409, '這個影片檔已經在影片庫裡了')
    expect(err).toBeInstanceOf(H3Error)
    expect(isHttpError(err)).toBe(true)
    expect(err.statusCode).toBe(409)
    expect(err.statusMessage).toBe('這個影片檔已經在影片庫裡了')
    expect(err.message).toBe('這個影片檔已經在影片庫裡了')
  })

  it('asHttpError keeps HTTP errors and wraps others without stack lines', () => {
    const original = httpError(404, 'x')
    expect(asHttpError(original, 500, 'y')).toBe(original)
    const wrapped = asHttpError(new Error('boom\n    at foo (a.ts:1:1)'), 422, '無法讀取')
    expect(wrapped.statusCode).toBe(422)
    expect(wrapped.statusMessage).toBe('無法讀取：boom')
    expect(isHttpError(new Error('x'))).toBe(false)
  })

  it('unreadableVideo is a 422 that does not repeat probeMedia\'s prefix', () => {
    const err = unreadableVideo(new Error('無法讀取影片：Invalid data found when processing input\nmore'))
    expect(err.statusCode).toBe(422)
    expect(err.statusMessage).toBe('無法讀取這個影片檔：Invalid data found when processing input')
    expect(unreadableVideo(new Error('無法讀取影片：找不到影像軌')).statusMessage).toBe('無法讀取這個影片檔：找不到影像軌')
    expect(unreadableVideo(new Error('')).statusMessage).toBe('無法讀取這個影片檔')
  })
})

describe('validation', () => {
  it('addVideoSchema defaults the audio track and rejects bad values in Chinese', () => {
    expect(parseWith(addVideoSchema, { sourceKind: 'upload', uploadId: 'u', language: 'zh' })).toEqual({ sourceKind: 'upload', uploadId: 'u', language: 'zh', audioTrack: 0 })
    expect(statusOf(() => parseWith(addVideoSchema, null))).toEqual({ statusCode: 400, statusMessage: '請求內容必須是 JSON 物件' })
    expect(statusOf(() => parseWith(addVideoSchema, { sourceKind: 'upload', language: 'zh', audioTrack: 1.5 })).statusMessage).toBe('音軌必須是整數')
    expect(statusOf(() => parseWith(addVideoSchema, { sourceKind: 'upload', language: 'zh', audioTrack: -1 })).statusMessage).toBe('音軌不能小於 0')
    expect(statusOf(() => parseWith(addVideoSchema, { sourceKind: 'x', language: 'zh' })).statusMessage).toBe('來源必須是 watch-folder 或 upload')
  })

  it('updateSegmentSchema trims and limits to 200 characters (by code point)', () => {
    expect(parseWith(updateSegmentSchema, { text: '  好  ' })).toEqual({ text: '好' })
    expect(statusOf(() => parseWith(updateSegmentSchema, { text: ' \n ' })).statusMessage).toBe('字幕文字不能是空的')
    expect(parseWith(updateSegmentSchema, { text: '😀'.repeat(200) }).text).toHaveLength(400)
    expect(statusOf(() => parseWith(updateSegmentSchema, { text: '字'.repeat(201) })).statusMessage).toBe('字幕文字最多 200 字')
    expect(statusOf(() => parseWith(updateSegmentSchema, { text: 3 })).statusMessage).toBe('字幕文字必須是文字')
  })

  it('updateHighlightSchema needs at least one field', () => {
    expect(parseWith(updateHighlightSchema, { status: 'dismissed' })).toEqual({ status: 'dismissed' })
    expect(statusOf(() => parseWith(updateHighlightSchema, {})).statusMessage).toBe('沒有要修改的內容')
    expect(statusOf(() => parseWith(updateHighlightSchema, { start: Number.NaN })).statusCode).toBe(400)
  })

  it('createClipSchema checks the Layout and defaults burnSubtitles to true', () => {
    expect(parseWith(createClipSchema, { layout: 'center-crop' })).toEqual({ layout: 'center-crop', burnSubtitles: true })
    expect(statusOf(() => parseWith(createClipSchema, { layout: 'square', burnSubtitles: true })).statusMessage).toContain('版型')
  })

  it('settingsSchema wants a list of strings', () => {
    expect(statusOf(() => parseWith(settingsSchema, { watchFolders: [1] })).statusMessage).toBe('資料夾路徑必須是文字')
  })

  it('parseIndexParam accepts only non-negative integers', () => {
    expect(parseIndexParam('0', '段落編號')).toBe(0)
    expect(parseIndexParam('12', '段落編號')).toBe(12)
    for (const bad of [undefined, '', '-1', '1.5', 'abc', '1e3']) {
      expect(statusOf(() => parseIndexParam(bad, '段落編號'))).toEqual({ statusCode: 400, statusMessage: '段落編號必須是 0 以上的整數' })
    }
  })
})

describe('checkHighlightRange', () => {
  it('accepts 0 <= start < end <= duration with at least 0.5 s', () => {
    expect(checkHighlightRange(0, 0.5, 10)).toEqual({ start: 0, end: 0.5 })
    expect(checkHighlightRange(1.23456, 9.87654, 10)).toEqual({ start: 1.235, end: 9.877 })
    // A millisecond past the end (float noise from the player) is clamped.
    expect(checkHighlightRange(5, 10.0004, 10)).toEqual({ start: 5, end: 10 })
  })

  it('accepts an end up to the rounding of the shown length past the video, clamped to the length', () => {
    // 17.86 s is shown as 0:17.9 / 0:18; 1:02:05.6 as 1:02:06; 1:59:59.7 as 2:00:00
    expect(checkHighlightRange(1, 17.9, 17.86)).toEqual({ start: 1, end: 17.86 })
    expect(checkHighlightRange(1, 18, 17.86)).toEqual({ start: 1, end: 17.86 })
    expect(checkHighlightRange(0, 3726, 3725.6)).toEqual({ start: 0, end: 3725.6 })
    expect(checkHighlightRange(7000, 7200, 7199.7)).toEqual({ start: 7000, end: 7199.7 })
    expect(checkHighlightRange(1, 17.86 + END_SLACK_SECONDS, 17.86)).toEqual({ start: 1, end: 17.86 })
    // the length named in the message is accepted too
    expect(statusOf(() => checkHighlightRange(1, 18.4, 17.86))).toEqual({ statusCode: 422, statusMessage: '終點不能超過影片長度（0:17）' })
    expect(checkHighlightRange(1, 17, 17.86)).toEqual({ start: 1, end: 17 })
    // the minimum length counts from the clamped end
    expect(statusOf(() => checkHighlightRange(17.5, 17.9, 17.86))).toEqual({ statusCode: 422, statusMessage: '精華片段至少要 0.5 秒' })
  })

  it('rejects everything else with a 422', () => {
    const cases: Array<[number, number, string]> = [
      [-0.1, 2, '起點不能小於 0'],
      [3, 3, '終點必須晚於起點'],
      [4, 3, '終點必須晚於起點'],
      [1, 70.5, '終點不能超過影片長度（1:05）'],
      [1, 1.4, '精華片段至少要 0.5 秒'],
    ]
    for (const [start, end, message] of cases) {
      expect(statusOf(() => checkHighlightRange(start, end, 65.2))).toEqual({ statusCode: 422, statusMessage: message })
    }
  })
})

describe('allowedMethods (the /api/** fallback)', () => {
  const h = () => {}
  it('lists the methods of the route that matched the path', () => {
    expect(allowedMethods({ path: '/api/settings', handlers: { get: h, put: h } }, '/api/**')).toEqual(['GET', 'HEAD', 'PUT'])
    expect(allowedMethods({ path: '/api/videos/:id/retry', handlers: { post: h } }, '/api/**')).toEqual(['POST'])
  })

  it('ignores the catch-all that h3 caches on a route as its \'all\' handler', () => {
    expect(allowedMethods({ path: '/api/videos/:id', handlers: { get: h, delete: h, all: h } }, '/api/**')).toEqual(['DELETE', 'GET', 'HEAD'])
  })

  it('is empty when only the catch-all matched (an unknown path)', () => {
    expect(allowedMethods({ path: '/api/**', handlers: { all: h } }, '/api/**')).toEqual([])
    expect(allowedMethods(undefined, '/api/**')).toEqual([])
    expect(allowedMethods({ path: '/api/x' }, '/api/**')).toEqual([])
  })
})

describe('names', () => {
  it('titleFromFileName drops the extension and folders', () => {
    expect(titleFromFileName('2026-11-08 20-15-33.mkv')).toBe('2026-11-08 20-15-33')
    expect(titleFromFileName('C:\\Videos\\我的直播.mp4')).toBe('我的直播')
    expect(titleFromFileName('/a/b/clip.final.mov')).toBe('clip.final')
    expect(titleFromFileName('.mp4')).toBe('.mp4')
  })

  it('fileNameClock is m-ss with minutes past 59', () => {
    expect(fileNameClock(0)).toBe('0-00')
    expect(fileNameClock(75.9)).toBe('1-15')
    expect(fileNameClock(3725)).toBe('62-05')
  })

  it('clipDownloadName is 影片標題_起點_版型 with unsafe characters replaced', () => {
    expect(clipDownloadName('我的直播', 75.4, 'blurred-background', '.mp4')).toBe('我的直播_1-15_模糊背景.mp4')
    expect(clipDownloadName('a/b:c*?"<>|', 0, 'center-crop', '.mp4')).toBe('a_b_c_______0-00_置中裁切.mp4')
    expect(clipDownloadName('   ', 5, 'original', '.srt')).toBe('剪輯_0-05_原比例.srt')
    expect(safeFileNamePart('trailing dots... ')).toBe('trailing dots')
  })
})

describe('normalizeWatchFolders', () => {
  let tmp: string
  beforeAll(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gg-api-rules-'))
    await fsp.mkdir(path.join(tmp, 'OBS 錄影'))
    await fsp.writeFile(path.join(tmp, 'file.mp4'), 'x')
  })
  afterAll(async () => {
    await fsp.rm(tmp, { recursive: true, force: true })
  })

  it('resolves, drops blanks and duplicates, strips quotes', async () => {
    const dir = path.join(tmp, 'OBS 錄影')
    expect(await normalizeWatchFolders([dir, ` ${dir}${path.sep} `, '', `"${dir}"`, path.join(dir, '..', 'OBS 錄影')])).toEqual([dir])
    expect(await normalizeWatchFolders([])).toEqual([])
  })

  it('names the bad folder', async () => {
    expect(await statusOfAsync(() => normalizeWatchFolders(['relative/dir']))).toEqual({ statusCode: 400, statusMessage: '「relative/dir」不是完整的資料夾路徑' })
    const missing = path.join(tmp, 'missing')
    expect(await statusOfAsync(() => normalizeWatchFolders([missing]))).toEqual({ statusCode: 400, statusMessage: `找不到資料夾「${missing}」` })
    const file = path.join(tmp, 'file.mp4')
    expect(await statusOfAsync(() => normalizeWatchFolders([file]))).toEqual({ statusCode: 400, statusMessage: `「${file}」不是資料夾` })
  })
})
