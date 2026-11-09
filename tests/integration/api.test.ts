// API tests against the real Nitro build, with the fake transcriber, the fake Ollama and real ffmpeg.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Clip, Highlight, MediaInfo, Settings, SourceVideo, SystemInfo, TranscriptSegment, UploadResult, WatchFolderFile } from '../../shared/types/domain'
import { type FakeOllama, startFakeOllama } from '../../server/lib/llm/test-helpers/fake-ollama.mjs'
import { fixtures } from '../fixtures'
import { api, ensureBuild, FAKE_TRANSCRIBER, getBytes, ROOT_DIR, type RunningServer, startServer, uploadFile, waitUntil } from './server'

const OLLAMA_VERSION = '0.40.15'
const OLLAMA_MODEL = 'qwen3.5:9b'
/** The fake Ollama's first reason, in Simplified Chinese; the server stores it in Taiwan Traditional. */
const OK_REASON = '大家笑成一團的反應'

const SYSTEM_NOTO = '/usr/share/fonts/opentype/noto'

let server: RunningServer
let ollama: FakeOllama
let base: string
let tmp: string
let dataDir: string
let watchDir: string
let outsideDir: string
let failMarker: string

// Files in the Watch Folder (copies of the fixtures, so deleting can never touch the shared ones).
let mkvPath: string
let mp4Path: string
let noAudioPath: string

function fontsDir(): string {
  const repoFonts = path.join(ROOT_DIR, 'fonts')
  const has = (dir: string) => {
    try {
      return fs.readdirSync(dir).some(n => /^NotoSansCJK.*\.(?:otf|ttc)$/i.test(n))
    }
    catch {
      return false
    }
  }
  return has(repoFonts) ? repoFonts : SYSTEM_NOTO
}

async function waitForAnalysis(id: string, statuses: SourceVideo['analysis']['status'][] = ['done', 'failed']) {
  return waitUntil(async () => {
    const res = await api<SourceVideo>(base, 'GET', `/api/videos/${id}`)
    return statuses.includes(res.body.analysis.status) ? res.body : null
  })
}

beforeAll(async () => {
  const fx = fixtures()
  await ensureBuild()
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gg-api-'))
  dataDir = path.join(tmp, 'data')
  watchDir = path.join(tmp, 'watch 資料夾')
  outsideDir = path.join(tmp, 'outside')
  failMarker = path.join(tmp, 'fail-transcriber')
  await fsp.mkdir(watchDir, { recursive: true })
  await fsp.mkdir(outsideDir, { recursive: true })
  mkvPath = path.join(watchDir, '直播 測試.mkv')
  mp4Path = path.join(watchDir, 'sample-en.mp4')
  noAudioPath = path.join(watchDir, 'noaudio.mp4')
  await fsp.copyFile(fx.sampleEnMkv, mkvPath)
  await fsp.copyFile(fx.sampleEnMp4, mp4Path)
  await fsp.copyFile(fx.noAudioMp4, noAudioPath)
  await fsp.writeFile(path.join(watchDir, 'notes.txt'), 'not a video')
  await fsp.copyFile(fx.sampleEnMp4, path.join(outsideDir, 'outside.mp4'))

  ollama = await startFakeOllama({ version: OLLAMA_VERSION, models: [OLLAMA_MODEL] })
  server = await startServer({
    GG_DATA_DIR: dataDir,
    GG_FONTS_DIR: fontsDir(),
    GG_TRANSCRIBER_CMD: JSON.stringify([process.execPath, FAKE_TRANSCRIBER]),
    GG_VIDEO_ENCODER: 'libx264',
    GG_ASR_DEVICE: 'cpu',
    GG_ASR_MODEL_EN: 'test/en-model',
    GG_ASR_MODEL_ZH: 'test/zh-model',
    GG_FAKE_FAIL_FILE: failMarker,
    // A slower fake transcriber, so a 'full' re-analysis is still queued or running while the guards are checked.
    GG_FAKE_DELAY_MS: '100',
    GG_OLLAMA_URL: ollama.url,
    GG_OLLAMA_MODEL: OLLAMA_MODEL,
  })
  base = server.url
})

afterAll(async () => {
  if (server) {
    const code = await server.stop()
    // Graceful shutdown (close hook: stop queues, close the database).
    expect(code === 0 || code === null).toBe(true)
  }
  await ollama?.close()
  if (tmp) await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('system and settings', () => {
  it('GET /api/system reports version, encoder, data folder and fonts', async () => {
    const res = await api<SystemInfo>(base, 'GET', '/api/system')
    expect(res.status).toBe(200)
    const pkg = JSON.parse(await fsp.readFile(path.join(ROOT_DIR, 'package.json'), 'utf8')) as { version: string }
    expect(res.body).toEqual({
      version: pkg.version, videoEncoder: 'libx264', videoEncoderForced: true, dataDir, fontsReady: true,
      ollama: { url: ollama.url, model: OLLAMA_MODEL, status: 'ready', version: OLLAMA_VERSION },
    })
    expect(fs.existsSync(path.join(dataDir, 'gg-highlight.db'))).toBe(true)
  })

  it('GET /api/system reports a missing model and an outdated Ollama', async () => {
    try {
      ollama.setScenario('model-missing')
      expect((await api<SystemInfo>(base, 'GET', '/api/system')).body.ollama).toEqual({ url: ollama.url, model: OLLAMA_MODEL, status: 'model-missing', version: OLLAMA_VERSION })
      ollama.setScenario('old-version')
      expect((await api<SystemInfo>(base, 'GET', '/api/system')).body.ollama).toMatchObject({ status: 'outdated', version: '0.20.0' })
    }
    finally {
      ollama.setScenario('ok')
    }
  })

  it('unknown API routes answer a JSON 404 instead of the SPA page', async () => {
    for (const [method, url] of [['GET', '/api/nope'], ['GET', '/api/videos/x/nope'], ['POST', '/api/nope/deeper']]) {
      const res = await api(base, method!, url!)
      expect(res.status, `${method} ${url}`).toBe(404)
      expect(res.body.statusMessage).toBe('找不到這個 API')
    }
    const page = await fetch(`${base}/settings`)
    expect(page.headers.get('content-type')).toContain('text/html')
  })

  it('a known API path asked with another method answers a JSON 405 (not the SPA page), every time', async () => {
    const cases: Array<[string, string, string]> = [
      ['DELETE', '/api/settings', 'GET, HEAD, PUT'],
      ['POST', '/api/system', 'GET, HEAD'],
      ['PUT', '/api/videos/abc', 'DELETE, GET, HEAD'],
      ['GET', '/api/videos/abc/retry', 'POST'],
      ['PATCH', '/api/videos', 'GET, HEAD, POST'],
      ['GET', '/api/highlights/abc', 'PATCH'],
      ['DELETE', '/api/videos/abc/transcript/0', 'PATCH'],
      ['PUT', '/api/uploads', 'POST'],
    ]
    // twice: h3 caches the fallback on the route after the first miss
    for (let round = 0; round < 2; round++) {
      for (const [method, url, allow] of cases) {
        const res = await api(base, method, url)
        expect(res.status, `${method} ${url}`).toBe(405)
        expect(res.headers.get('content-type'), `${method} ${url}`).toContain('application/json')
        expect(res.headers.get('allow'), `${method} ${url}`).toBe(allow)
        expect(res.body.statusMessage).toBe('不支援這個請求方法')
      }
    }
    // HEAD of a GET route is answered like the GET, without a body
    const head = await fetch(`${base}/api/system`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toContain('application/json')
    expect(await head.text()).toBe('')
    // the real routes still answer their own methods
    expect((await api(base, 'GET', '/api/settings')).status).toBe(200)
    expect((await api(base, 'GET', '/api/videos/abc')).status).toBe(404)
    expect((await api(base, 'GET', '/api/videos/abc')).body.statusMessage).not.toBe('找不到這個 API')
    expect((await api(base, 'DELETE', '/api/videos/abc')).status).toBe(404)
    for (const url of ['/api', '/api/']) {
      const res = await api(base, 'GET', url)
      expect(res.status, url).toBe(404)
      expect(res.body.statusMessage, url).toBe('找不到這個 API')
    }
  })

  it('GET /api/settings starts empty', async () => {
    const res = await api<Settings>(base, 'GET', '/api/settings')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ watchFolders: [] })
  })

  it('PUT /api/settings rejects bad Watch Folders by name', async () => {
    const relative = await api(base, 'PUT', '/api/settings', { watchFolders: ['videos/obs'] })
    expect(relative.status).toBe(400)
    expect(relative.body.statusMessage).toBe('「videos/obs」不是完整的資料夾路徑')

    const missing = path.join(tmp, 'nope')
    const notFound = await api(base, 'PUT', '/api/settings', { watchFolders: [watchDir, missing] })
    expect(notFound.status).toBe(400)
    expect(notFound.body.statusMessage).toBe(`找不到資料夾「${missing}」`)

    const file = await api(base, 'PUT', '/api/settings', { watchFolders: [mp4Path] })
    expect(file.status).toBe(400)
    expect(file.body.statusMessage).toContain('不是資料夾')

    const shape = await api(base, 'PUT', '/api/settings', { watchFolders: 'x' })
    expect(shape.status).toBe(400)
    expect(shape.body.statusMessage).toBe('影片資料夾必須是清單')

    const json = await api(base, 'PUT', '/api/settings', '{not json')
    expect(json.status).toBe(400)
    expect((await api<Settings>(base, 'GET', '/api/settings')).body.watchFolders).toEqual([])
  })

  it('PUT /api/settings saves resolved, de-duplicated folders', async () => {
    const res = await api<Settings>(base, 'PUT', '/api/settings', { watchFolders: [watchDir, `${watchDir}${path.sep}`, ` ${watchDir} `, ''] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ watchFolders: [watchDir] })
    expect((await api<Settings>(base, 'GET', '/api/settings')).body).toEqual({ watchFolders: [watchDir] })
  })

  it('GET /api/watch-folders/files lists the video files only', async () => {
    const res = await api<WatchFolderFile[]>(base, 'GET', '/api/watch-folders/files')
    expect(res.status).toBe(200)
    expect(res.body.map(f => f.name).sort()).toEqual(['noaudio.mp4', 'sample-en.mp4', '直播 測試.mkv'].sort())
    expect(res.body.every(f => !f.inLibrary && f.folder === watchDir && f.sizeBytes > 0)).toBe(true)
  })
})

describe('probe and adding videos', () => {
  it('POST /api/probe only reads files inside a Watch Folder', async () => {
    const outside = await api(base, 'POST', '/api/probe', { filePath: path.join(outsideDir, 'outside.mp4') })
    expect(outside.status).toBe(403)
    expect(outside.body.statusMessage).toBe('只能讀取設定的影片資料夾裡的影片檔')

    const traversal = await api(base, 'POST', '/api/probe', { filePath: path.join(watchDir, '..', 'outside', 'outside.mp4') })
    expect(traversal.status).toBe(403)

    const missing = await api(base, 'POST', '/api/probe', { filePath: path.join(watchDir, 'missing.mp4') })
    expect(missing.status).toBe(404)

    const bad = await api(base, 'POST', '/api/probe', {})
    expect(bad.status).toBe(400)
    expect(bad.body.statusMessage).toBe('請提供影片路徑')

    const ok = await api<MediaInfo>(base, 'POST', '/api/probe', { filePath: mkvPath })
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ width: 1280, height: 720, videoCodec: 'h264' })
    expect(ok.body.audioTracks.map(t => t.index)).toEqual([0, 1])
  })

  it('POST /api/videos rejects paths outside the Watch Folders', async () => {
    for (const filePath of [
      path.join(outsideDir, 'outside.mp4'),
      path.join(watchDir, '..', 'outside', 'outside.mp4'),
      'sample-en.mp4',
      watchDir,
      path.join(watchDir, 'notes.txt'),
    ]) {
      const res = await api(base, 'POST', '/api/videos', { sourceKind: 'watch-folder', filePath, language: 'en', audioTrack: 0 })
      expect(res.status, filePath).toBe(403)
      expect(res.body.statusMessage).toBe('只能加入設定的影片資料夾裡的影片檔')
    }
    expect((await api<SourceVideo[]>(base, 'GET', '/api/videos')).body).toEqual([])
  })

  it('POST /api/videos validates the body and the audio track', async () => {
    const lang = await api(base, 'POST', '/api/videos', { sourceKind: 'watch-folder', filePath: mkvPath, language: 'fr', audioTrack: 0 })
    expect(lang.status).toBe(400)
    expect(lang.body.statusMessage).toContain('語言')

    const kind = await api(base, 'POST', '/api/videos', { sourceKind: 'youtube', language: 'en', audioTrack: 0 })
    expect(kind.status).toBe(400)

    const track = await api(base, 'POST', '/api/videos', { sourceKind: 'watch-folder', filePath: mkvPath, language: 'en', audioTrack: 7 })
    expect(track.status).toBe(422)
    expect(track.body.statusMessage).toBe('找不到第 8 條音軌（這支影片只有 2 條音軌）')

    const silent = await api(base, 'POST', '/api/videos', { sourceKind: 'watch-folder', filePath: noAudioPath, language: 'en', audioTrack: 0 })
    expect(silent.status).toBe(422)
    expect(silent.body.statusMessage).toContain('沒有音訊')

    const missing = await api(base, 'POST', '/api/videos', { sourceKind: 'watch-folder', filePath: path.join(watchDir, 'gone.mp4'), language: 'en', audioTrack: 0 })
    expect(missing.status).toBe(404)
  })
})

describe('a watch-folder video end to end', () => {
  let video: SourceVideo
  let transcript: TranscriptSegment[]
  let highlight: Highlight

  it('adds the video, titled after the file, and rejects the same path twice', async () => {
    const res = await api<SourceVideo>(base, 'POST', '/api/videos', { sourceKind: 'watch-folder', filePath: mkvPath, language: 'en', audioTrack: 1 })
    expect(res.status).toBe(200)
    video = res.body
    expect(video).toMatchObject({ title: '直播 測試', sourceKind: 'watch-folder', filePath: mkvPath, language: 'en', audioTrack: 1, fileMissing: false, youtubeUrl: null })
    expect(['queued', 'running']).toContain(video.analysis.status)
    expect(video.media?.audioTracks).toHaveLength(2)
    expect(video).not.toHaveProperty('previewPath')

    const again = await api(base, 'POST', '/api/videos', { sourceKind: 'watch-folder', filePath: path.join(watchDir, '.', '直播 測試.mkv'), language: 'zh', audioTrack: 0 })
    expect(again.status).toBe(409)
    expect(again.body.statusMessage).toBe('這個影片檔已經在影片庫裡了')

    const files = await api<WatchFolderFile[]>(base, 'GET', '/api/watch-folders/files')
    expect(files.body.find(f => f.path === mkvPath)?.inLibrary).toBe(true)
  })

  it('finishes the Analysis with a transcript, a remuxed preview and a candidate Highlight with a reason', async () => {
    const done = await waitForAnalysis(video.id)
    expect(done.analysis).toMatchObject({
      status: 'done', mode: 'full', version: 2, progress: 1, error: null,
      signals: [{ kind: 'loudness', status: 'used', reason: null }, { kind: 'transcript', status: 'used', reason: null }],
    })
    const candidates = (await api<Highlight[]>(base, 'GET', `/api/videos/${video.id}/highlights`)).body
    expect(candidates.length).toBeGreaterThan(0)
    for (const c of candidates) {
      expect(c).toMatchObject({ videoId: video.id, origin: 'analysis', status: 'candidate', reason: OK_REASON })
      expect(c.score).toBeGreaterThan(0)
    }
    expect(fs.existsSync(path.join(dataDir, 'videos', video.id, 'signals.json'))).toBe(true)
    // The model was unloaded after reading the Transcript.
    expect(ollama.requests.at(-1)?.body).toEqual({ model: OLLAMA_MODEL, messages: [], keep_alive: 0 })
    const list = await api<SourceVideo[]>(base, 'GET', '/api/videos')
    expect(list.body.map(v => v.id)).toEqual([video.id])

    const res = await api<TranscriptSegment[]>(base, 'GET', `/api/videos/${video.id}/transcript`)
    expect(res.status).toBe(200)
    transcript = res.body
    expect(transcript.length).toBeGreaterThanOrEqual(3)
    expect(transcript.map(s => s.text).join(' ')).toContain('welcome back to the stream')
    expect(fs.existsSync(path.join(dataDir, 'videos', video.id, 'preview.mp4'))).toBe(true)
    expect(fs.existsSync(path.join(dataDir, 'videos', video.id, 'audio.wav'))).toBe(false)
    expect(fs.existsSync(path.join(dataDir, 'videos', video.id, 'transcript.raw.json'))).toBe(true)
  })

  it('GET /api/videos/:id/media serves the preview with Range support', async () => {
    const previewSize = fs.statSync(path.join(dataDir, 'videos', video.id, 'preview.mp4')).size
    const full = await getBytes(base, `/api/videos/${video.id}/media`)
    expect(full.status).toBe(200)
    expect(full.headers.get('content-type')).toBe('video/mp4')
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    expect(full.bytes.length).toBe(previewSize)

    const part = await getBytes(base, `/api/videos/${video.id}/media`, { range: 'bytes=0-99' })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 0-99/${previewSize}`)
    expect(part.bytes.length).toBe(100)
    expect(part.bytes.subarray(4, 8).toString('latin1')).toBe('ftyp')

    const tail = await getBytes(base, `/api/videos/${video.id}/media`, { range: 'bytes=-10' })
    expect(tail.status).toBe(206)
    expect(tail.bytes.equals(full.bytes.subarray(previewSize - 10))).toBe(true)

    const bad = await getBytes(base, `/api/videos/${video.id}/media`, { range: `bytes=${previewSize + 10}-` })
    expect(bad.status).toBe(416)
    expect(bad.headers.get('content-range')).toBe(`bytes */${previewSize}`)

    const head = await getBytes(base, `/api/videos/${video.id}/media`, {}, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(previewSize))
    expect(head.bytes.length).toBe(0)

    const unknown = await api(base, 'GET', '/api/videos/00000000-0000-4000-8000-000000000000/media')
    expect(unknown.status).toBe(404)
    expect(unknown.body.statusMessage).toBe('找不到這支影片')
  })

  it('PATCH /api/videos/:id/transcript/:idx edits the text with validation', async () => {
    const ok = await api<TranscriptSegment>(base, 'PATCH', `/api/videos/${video.id}/transcript/0`, { text: '  大家好，歡迎回來  ' })
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ idx: 0, text: '大家好，歡迎回來', edited: true, start: transcript[0]!.start, end: transcript[0]!.end })

    const empty = await api(base, 'PATCH', `/api/videos/${video.id}/transcript/0`, { text: '   ' })
    expect(empty.status).toBe(400)
    expect(empty.body.statusMessage).toBe('字幕文字不能是空的')

    const long = await api(base, 'PATCH', `/api/videos/${video.id}/transcript/0`, { text: '字'.repeat(201) })
    expect(long.status).toBe(400)
    expect(long.body.statusMessage).toBe('字幕文字最多 200 字')
    expect((await api(base, 'PATCH', `/api/videos/${video.id}/transcript/0`, { text: '字'.repeat(200) })).status).toBe(200)

    expect((await api(base, 'PATCH', `/api/videos/${video.id}/transcript/999`, { text: 'x' })).status).toBe(404)
    expect((await api(base, 'PATCH', `/api/videos/${video.id}/transcript/abc`, { text: 'x' })).status).toBe(400)
    expect((await api(base, 'PATCH', '/api/videos/nope/transcript/0', { text: 'x' })).status).toBe(404)

    // Restoring the ASR text clears the edited flag.
    const restored = await api<TranscriptSegment>(base, 'PATCH', `/api/videos/${video.id}/transcript/0`, { text: transcript[0]!.text })
    expect(restored.body.edited).toBe(false)
    const edited = await api<TranscriptSegment>(base, 'PATCH', `/api/videos/${video.id}/transcript/1`, { text: '今天我們要玩新遊戲' })
    expect(edited.body.edited).toBe(true)
  })

  it('creates and updates Highlights within the video length', async () => {
    const duration = video.media!.durationSec
    const url = `/api/videos/${video.id}/highlights`
    const cases: Array<[unknown, number, string]> = [
      [{ start: 3, end: 2 }, 422, '終點必須晚於起點'],
      [{ start: 2, end: 2 }, 422, '終點必須晚於起點'],
      [{ start: -1, end: 2 }, 422, '起點不能小於 0'],
      [{ start: 1, end: duration + 5 }, 422, '終點不能超過影片長度（0:10）'],
      [{ start: 1, end: 1.3 }, 422, '精華片段至少要 0.5 秒'],
      [{ start: '1', end: 2 }, 400, '起點必須是數字（秒）'],
      [{ end: 2 }, 400, '起點必須是數字（秒）'],
    ]
    for (const [body, status, message] of cases) {
      const res = await api(base, 'POST', url, body)
      expect(res.status, JSON.stringify(body)).toBe(status)
      expect(res.body.statusMessage).toBe(message)
    }
    expect((await api(base, 'POST', '/api/videos/nope/highlights', { start: 1, end: 2 })).status).toBe(404)

    const created = await api<Highlight>(base, 'POST', url, { start: 2, end: 3.5 })
    expect(created.status).toBe(200)
    highlight = created.body
    expect(highlight).toMatchObject({ videoId: video.id, start: 2, end: 3.5, status: 'selected', origin: 'manual', score: null, reason: null })
    const early = await api<Highlight>(base, 'POST', url, { start: 0.5, end: 1.5 })
    expect(early.status).toBe(200)

    const list = await api<Highlight[]>(base, 'GET', url)
    expect(list.body.filter(h => h.origin === 'manual').map(h => h.id)).toEqual([early.body.id, highlight.id])

    const dismissed = await api<Highlight>(base, 'PATCH', `/api/highlights/${early.body.id}`, { status: 'dismissed' })
    expect(dismissed.body.status).toBe('dismissed')
    const moved = await api<Highlight>(base, 'PATCH', `/api/highlights/${early.body.id}`, { end: 1.75 })
    expect(moved.body).toMatchObject({ start: 0.5, end: 1.75, status: 'dismissed' })
    // The page shows the length rounded (up to 0.5 s above the real one): such an end is clamped.
    const clamped = await api<Highlight>(base, 'PATCH', `/api/highlights/${early.body.id}`, { end: duration + 0.4 })
    expect(clamped.status).toBe(200)
    expect(clamped.body.end).toBe(Math.round(duration * 1000) / 1000)
    expect((await api<Highlight>(base, 'PATCH', `/api/highlights/${early.body.id}`, { end: 1.75 })).body.end).toBe(1.75)
    expect((await api(base, 'PATCH', `/api/highlights/${early.body.id}`, { end: duration + 1 })).status).toBe(422)
    expect((await api(base, 'PATCH', `/api/highlights/${early.body.id}`, { start: 1.6 })).body.statusMessage).toBe('精華片段至少要 0.5 秒')
    expect((await api(base, 'PATCH', `/api/highlights/${early.body.id}`, {})).status).toBe(400)
    expect((await api(base, 'PATCH', `/api/highlights/${early.body.id}`, { status: 'deleted' })).status).toBe(400)
    expect((await api(base, 'PATCH', '/api/highlights/nope', { status: 'selected' })).status).toBe(404)
  })

  it('exports clips (with and without subtitles) and serves the files', async () => {
    const bad = await api(base, 'POST', `/api/highlights/${highlight.id}/clips`, { layout: 'square', burnSubtitles: true })
    expect(bad.status).toBe(400)
    expect(bad.body.statusMessage).toContain('版型')
    expect((await api(base, 'POST', '/api/highlights/nope/clips', { layout: 'original', burnSubtitles: true })).status).toBe(404)

    const blurred = await api<Clip>(base, 'POST', `/api/highlights/${highlight.id}/clips`, { layout: 'blurred-background', burnSubtitles: true })
    expect(blurred.status).toBe(200)
    expect(blurred.body).toMatchObject({ videoId: video.id, highlightId: highlight.id, start: 2, end: 3.5, layout: 'blurred-background', burnSubtitles: true, hasFile: false, hasSrt: false })
    expect(['queued', 'running']).toContain(blurred.body.status)
    const plain = await api<Clip>(base, 'POST', `/api/highlights/${highlight.id}/clips`, { layout: 'original', burnSubtitles: false })
    expect(plain.status).toBe(200)

    // The Highlight can change afterwards; the clip keeps its snapshot.
    await api(base, 'PATCH', `/api/highlights/${highlight.id}`, { end: 4 })

    const clips = await waitUntil(async () => {
      const res = await api<Clip[]>(base, 'GET', `/api/videos/${video.id}/clips`)
      return res.body.every(c => c.status === 'done' || c.status === 'failed') ? res.body : null
    })
    expect(clips.map(c => c.id)).toEqual([plain.body.id, blurred.body.id])
    for (const clip of clips) {
      expect(clip).toMatchObject({ status: 'done', progress: 1, hasFile: true, hasSrt: true, error: null, start: 2, end: 3.5 })
      expect(clip.finishedAt).not.toBeNull()
    }
    const clipDir = path.join(dataDir, 'clips', video.id)
    expect(fs.existsSync(path.join(clipDir, `${blurred.body.id}.ass`))).toBe(true)
    expect(fs.existsSync(path.join(clipDir, `${plain.body.id}.ass`))).toBe(false)

    const id = blurred.body.id
    const size = fs.statSync(path.join(clipDir, `${id}.mp4`)).size
    const file = await getBytes(base, `/api/clips/${id}/file`)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toBe('video/mp4')
    expect(file.headers.get('content-disposition')).toBeNull()
    expect(file.bytes.length).toBe(size)

    const range = await getBytes(base, `/api/clips/${id}/file`, { range: 'bytes=100-1123' })
    expect(range.status).toBe(206)
    expect(range.bytes.equals(file.bytes.subarray(100, 1124))).toBe(true)

    const download = await getBytes(base, `/api/clips/${id}/file?download=1`)
    expect(download.status).toBe(200)
    const disposition = download.headers.get('content-disposition') ?? ''
    expect(disposition.startsWith('attachment;')).toBe(true)
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('直播 測試_0-02_模糊背景.mp4')}`)

    const srt = await getBytes(base, `/api/clips/${id}/srt`)
    expect(srt.status).toBe(200)
    const srtText = srt.bytes.toString('utf8')
    expect(srtText).toContain('00:00:00,000 --> ')
    expect(srtText).toContain('-->')
    expect(srt.headers.get('content-disposition')).toContain(encodeURIComponent('直播 測試_0-02_模糊背景.srt'))
    const plainSrt = await getBytes(base, `/api/clips/${plain.body.id}/srt`)
    expect(plainSrt.headers.get('content-disposition')).toContain(encodeURIComponent('直播 測試_0-02_原比例.srt'))

    expect((await api(base, 'GET', '/api/clips/nope/file')).status).toBe(404)
    expect((await api(base, 'GET', '/api/clips/nope/srt')).status).toBe(404)
  })
})

describe('re-analysis', () => {
  let video: SourceVideo
  let manual: Highlight
  let exported: Highlight

  const highlights = async () => (await api<Highlight[]>(base, 'GET', `/api/videos/${video.id}/highlights`)).body
  const transcript = async () => (await api<TranscriptSegment[]>(base, 'GET', `/api/videos/${video.id}/transcript`)).body
  const overlaps = (a: Highlight, b: Highlight) => a.start < b.end && b.start < a.end

  it('validates the request, and answers 409 while the video is queued or being analysed', async () => {
    const zhPath = path.join(watchDir, '中文 直播.mkv')
    await fsp.copyFile(fixtures().sampleZhMkv, zhPath)
    const added = await api<SourceVideo>(base, 'POST', '/api/videos', { sourceKind: 'watch-folder', filePath: zhPath, language: 'zh', audioTrack: 1 })
    expect(added.status).toBe(200)
    video = added.body
    for (const mode of ['full', 'highlights']) {
      const busy = await api(base, 'POST', `/api/videos/${video.id}/reanalyze`, { mode })
      expect([busy.status, busy.body.statusMessage]).toEqual([409, '這支影片正在排隊或分析中，請等分析結束再重新分析'])
    }
    expect((await waitForAnalysis(video.id)).analysis.status).toBe('done')

    expect((await api(base, 'POST', '/api/videos/nope/reanalyze', { mode: 'full' })).status).toBe(404)
    const bad = await api(base, 'POST', `/api/videos/${video.id}/reanalyze`, { mode: 'all' })
    expect([bad.status, bad.body.statusMessage]).toEqual([400, '重新分析的方式必須是 full（重新辨識語音並找精華）或 highlights（只重新找精華片段）'])
    expect((await api(base, 'POST', `/api/videos/${video.id}/reanalyze`, '{not json')).status).toBe(400)
    const get = await api(base, 'GET', `/api/videos/${video.id}/reanalyze`)
    expect([get.status, get.headers.get('allow')]).toEqual([405, 'POST'])
  })

  it('full is refused while clips of the video are exporting', async () => {
    // A manual Highlight, an exported candidate, and an edit in the Transcript.
    const created = await api<Highlight>(base, 'POST', `/api/videos/${video.id}/highlights`, { start: 0.5, end: 2 })
    manual = created.body
    const [candidate] = (await highlights()).filter(h => h.origin === 'analysis')
    expect(candidate).toBeDefined()
    exported = candidate!
    const edited = await api<TranscriptSegment>(base, 'PATCH', `/api/videos/${video.id}/transcript/0`, { text: '大家好，這是改過的字幕' })
    expect(edited.body.edited).toBe(true)

    // Two exports: the second one is certainly still queued when the request below arrives.
    for (let i = 0; i < 2; i++) {
      expect((await api(base, 'POST', `/api/highlights/${exported.id}/clips`, { layout: 'original', burnSubtitles: false })).status).toBe(200)
    }
    const busy = await api(base, 'POST', `/api/videos/${video.id}/reanalyze`, { mode: 'full' })
    expect([busy.status, busy.body.statusMessage]).toEqual([409, '這支影片還有剪輯在排隊或輸出中，請等輸出完成再重新辨識語音'])
    await waitUntil(async () => {
      const clips = (await api<Clip[]>(base, 'GET', `/api/videos/${video.id}/clips`)).body
      return clips.every(c => c.status === 'done' || c.status === 'failed')
    })
  })

  it('highlights keeps the edited Transcript and the kept Highlights, and stays editable while it runs', async () => {
    const before = await transcript()
    const res = await api<SourceVideo>(base, 'POST', `/api/videos/${video.id}/reanalyze`, { mode: 'highlights' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: video.id, analysis: { mode: 'highlights' } })
    expect(['queued', 'running']).toContain(res.body.analysis.status)
    expect((await api(base, 'POST', `/api/videos/${video.id}/reanalyze`, { mode: 'full' })).status).toBe(409)
    // Editing goes on during a highlights-only run.
    const edit = await api<TranscriptSegment>(base, 'PATCH', `/api/videos/${video.id}/transcript/1`, { text: '今天我們要玩新遊戲，哈哈' })
    expect(edit.status).toBe(200)

    const done = await waitForAnalysis(video.id)
    expect(done.analysis).toMatchObject({ status: 'done', mode: 'highlights', version: 2, error: null })
    const after = await transcript()
    expect(after.map(s => [s.start, s.end])).toEqual(before.map(s => [s.start, s.end]))
    expect(after[0]).toMatchObject({ text: '大家好，這是改過的字幕', edited: true })
    expect(after[1]).toMatchObject({ text: '今天我們要玩新遊戲，哈哈', edited: true })

    const list = await highlights()
    expect(list.map(h => h.id)).toEqual(expect.arrayContaining([manual.id, exported.id]))
    for (const fresh of list.filter(h => h.status === 'candidate' && h.id !== exported.id)) {
      expect(overlaps(fresh, manual) || overlaps(fresh, exported)).toBe(false)
    }
  })

  it('full transcribes again (edits are replaced) and keeps manual and exported Highlights; nothing can be changed until it is done', async () => {
    const res = await api<SourceVideo>(base, 'POST', `/api/videos/${video.id}/reanalyze`, { mode: 'full' })
    expect(res.status).toBe(200)
    expect(res.body.analysis.mode).toBe('full')
    const guards: Array<[string, string, unknown, string]> = [
      ['PATCH', `/api/videos/${video.id}/transcript/0`, { text: 'x' }, '影片分析完成後才能修改逐字稿'],
      ['POST', `/api/videos/${video.id}/highlights`, { start: 3, end: 4 }, '影片分析完成後才能新增精華片段'],
      ['PATCH', `/api/highlights/${manual.id}`, { status: 'dismissed' }, '影片分析完成後才能調整精華片段'],
      ['POST', `/api/highlights/${manual.id}/clips`, { layout: 'original', burnSubtitles: true }, '影片分析完成後才能輸出剪輯'],
    ]
    for (const [method, url, body, message] of guards) {
      const r = await api(base, method, url, body)
      expect([r.status, r.body.statusMessage], `${method} ${url}`).toEqual([409, message])
    }
    expect((await api<SourceVideo>(base, 'GET', `/api/videos/${video.id}`)).body.analysis.status).not.toBe('done')

    const done = await waitForAnalysis(video.id)
    expect(done.analysis).toMatchObject({ status: 'done', mode: 'full', version: 2 })
    const after = await transcript()
    expect(after.every(s => !s.edited)).toBe(true)
    expect(after.map(s => s.text).join('')).toContain('歡迎回到直播')
    expect((await highlights()).map(h => h.id)).toEqual(expect.arrayContaining([manual.id, exported.id]))
    expect((await api(base, 'PATCH', `/api/highlights/${manual.id}`, { status: 'dismissed' })).status).toBe(200)
  })

  it('full needs the source file (422); highlights runs without it', async () => {
    const copy = path.join(watchDir, '會被刪掉.mp4')
    await fsp.copyFile(mp4Path, copy)
    const added = await api<SourceVideo>(base, 'POST', '/api/videos', { sourceKind: 'watch-folder', filePath: copy, language: 'en', audioTrack: 0 })
    expect((await waitForAnalysis(added.body.id)).analysis.status).toBe('done')
    await fsp.rm(copy)

    const full = await api(base, 'POST', `/api/videos/${added.body.id}/reanalyze`, { mode: 'full' })
    expect([full.status, full.body.statusMessage]).toEqual([422, '找不到原始影片檔，無法重新辨識語音'])
    const res = await api<SourceVideo>(base, 'POST', `/api/videos/${added.body.id}/reanalyze`, { mode: 'highlights' })
    expect(res.status).toBe(200)
    expect(res.body.fileMissing).toBe(true)
    const done = await waitForAnalysis(added.body.id)
    expect(done.analysis).toMatchObject({ status: 'done', mode: 'highlights' })
    expect(done.analysis.signals?.map(s => s.status)).toEqual(['used', 'used'])
    expect((await api(base, 'DELETE', `/api/videos/${added.body.id}`)).status).toBe(200)
  })
})

describe('uploads', () => {
  let upload: UploadResult

  it('POST /api/uploads streams the body to data/uploads and probes it', async () => {
    const fx = fixtures()
    const res = await uploadFile(base, fx.sampleEnMp4, { 'x-file-name': encodeURIComponent('上傳 影片.mp4') })
    expect(res.status).toBe(200)
    upload = res.body as UploadResult
    expect(upload.fileName).toBe('上傳 影片.mp4')
    expect(upload.uploadId).toMatch(/^[0-9a-f-]{36}$/)
    expect(upload.media.audioTracks).toHaveLength(1)
    const stored = path.join(dataDir, 'uploads', `${upload.uploadId}.mp4`)
    expect(fs.statSync(stored).size).toBe(fs.statSync(fx.sampleEnMp4).size)
  })

  it('rejects missing names, non-video files and unreadable videos (deleting them again)', async () => {
    const fx = fixtures()
    const before = fs.readdirSync(path.join(dataDir, 'uploads')).sort()

    const noName = await uploadFile(base, fx.sampleEnMp4, {})
    expect(noName.status).toBe(400)
    expect(noName.body.statusMessage).toContain('缺少檔案名稱')

    const text = await uploadFile(base, fx.sampleEnMp4, { 'x-file-name': encodeURIComponent('notes.txt') })
    expect(text.status).toBe(415)

    const garbage = path.join(tmp, 'garbage.mp4')
    await fsp.writeFile(garbage, Buffer.alloc(64 * 1024, 3))
    const broken = await uploadFile(base, garbage, { 'x-file-name': encodeURIComponent('壞掉.mp4') })
    expect(broken.status).toBe(422)
    expect(broken.body.statusMessage).toContain('無法讀取這個影片檔')

    expect(fs.readdirSync(path.join(dataDir, 'uploads')).sort()).toEqual(before)
  })

  it('adds an upload to the Library by uploadId', async () => {
    expect((await api(base, 'POST', '/api/videos', { sourceKind: 'upload', language: 'en', audioTrack: 0 })).status).toBe(400)
    const unknown = await api(base, 'POST', '/api/videos', { sourceKind: 'upload', uploadId: '00000000-0000-4000-8000-000000000000', language: 'en', audioTrack: 0 })
    expect(unknown.status).toBe(404)
    expect(unknown.body.statusMessage).toBe('找不到上傳的檔案，請重新上傳')
    expect((await api(base, 'POST', '/api/videos', { sourceKind: 'upload', uploadId: '../../etc/passwd', language: 'en', audioTrack: 0 })).status).toBe(404)

    const res = await api<SourceVideo>(base, 'POST', '/api/videos', { sourceKind: 'upload', uploadId: upload.uploadId, language: 'en', audioTrack: 0 })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ title: '上傳 影片', sourceKind: 'upload' })
    expect((await api(base, 'POST', '/api/videos', { sourceKind: 'upload', uploadId: upload.uploadId, language: 'en', audioTrack: 0 })).status).toBe(409)

    const done = await waitForAnalysis(res.body.id)
    expect(done.analysis.status).toBe('done')

    // Deleting an uploaded video removes the uploaded copy too.
    const del = await api(base, 'DELETE', `/api/videos/${res.body.id}`)
    expect(del.status).toBe(200)
    expect(fs.existsSync(path.join(dataDir, 'uploads', `${upload.uploadId}.mp4`))).toBe(false)
    expect(fs.existsSync(path.join(dataDir, 'uploads', `${upload.uploadId}.json`))).toBe(false)
  })
})

describe('failure, retry and removal', () => {
  it('a failed Analysis can be retried in the same mode; only failed ones', async () => {
    await fsp.writeFile(failMarker, '1')
    const added = await api<SourceVideo>(base, 'POST', '/api/videos', { sourceKind: 'watch-folder', filePath: mp4Path, language: 'en', audioTrack: 0 })
    expect(added.status).toBe(200)
    const id = added.body.id
    const failed = await waitForAnalysis(id)
    expect(failed.analysis).toMatchObject({ status: 'failed', mode: 'full', step: 'transcribe', error: '語音辨識失敗：語音辨識模型載入失敗（測試）' })

    // No Transcript yet: nothing to edit or find highlights in.
    const h = await api(base, 'POST', `/api/videos/${id}/highlights`, { start: 1, end: 2 })
    expect([h.status, h.body.statusMessage]).toEqual([409, '影片分析完成後才能新增精華片段'])
    const edit = await api(base, 'PATCH', `/api/videos/${id}/transcript/0`, { text: 'x' })
    expect([edit.status, edit.body.statusMessage]).toEqual([409, '影片分析完成後才能修改逐字稿'])
    const onlyHighlights = await api(base, 'POST', `/api/videos/${id}/reanalyze`, { mode: 'highlights' })
    expect([onlyHighlights.status, onlyHighlights.body.statusMessage]).toEqual([409, '這支影片還沒有逐字稿，只能選「重新辨識語音並找精華」'])

    await fsp.rm(failMarker)
    const retry = await api<SourceVideo>(base, 'POST', `/api/videos/${id}/retry`)
    expect(retry.status).toBe(200)
    expect(retry.body.analysis).toMatchObject({ mode: 'full' })
    expect(['queued', 'running']).toContain(retry.body.analysis.status)
    expect((await waitForAnalysis(id)).analysis.status).toBe('done')

    // A failed full re-analysis after a finished one: the Transcript, Highlights and Clips stay usable.
    const manual = await api<Highlight>(base, 'POST', `/api/videos/${id}/highlights`, { start: 1, end: 2 })
    expect(manual.status).toBe(200)
    await fsp.writeFile(failMarker, '1')
    expect((await api(base, 'POST', `/api/videos/${id}/reanalyze`, { mode: 'full' })).status).toBe(200)
    expect((await waitForAnalysis(id)).analysis).toMatchObject({ status: 'failed', mode: 'full', version: 2 })
    const edited = await api<TranscriptSegment>(base, 'PATCH', `/api/videos/${id}/transcript/0`, { text: '失敗之後改的字' })
    expect([edited.status, edited.body.edited]).toEqual([200, true])
    expect((await api(base, 'PATCH', `/api/highlights/${manual.body.id}`, { status: 'dismissed' })).status).toBe(200)
    expect((await api(base, 'POST', `/api/videos/${id}/highlights`, { start: 3, end: 4 })).status).toBe(200)
    for (let i = 0; i < 2; i++) {
      const clip = await api(base, 'POST', `/api/highlights/${manual.body.id}/clips`, { layout: 'original', burnSubtitles: true })
      expect(clip.status).toBe(200)
    }
    // 重試 transcribes again: refused while the Transcript is being exported, like 重新分析 (full)
    const busy = await api(base, 'POST', `/api/videos/${id}/retry`)
    expect([busy.status, busy.body.statusMessage]).toEqual([409, '這支影片還有剪輯在排隊或輸出中，請等輸出完成再重新辨識語音'])
    await waitUntil(async () => {
      const clips = (await api<Clip[]>(base, 'GET', `/api/videos/${id}/clips`)).body
      return clips.length === 2 && clips.every(c => c.status === 'done')
    })
    // 只重新找精華片段 is offered too, and keeps the edit
    const onlyHighlightsNow = await api<SourceVideo>(base, 'POST', `/api/videos/${id}/reanalyze`, { mode: 'highlights' })
    expect(onlyHighlightsNow.status).toBe(200)
    expect((await waitForAnalysis(id)).analysis).toMatchObject({ status: 'done', mode: 'highlights', version: 2 })
    expect((await api<TranscriptSegment[]>(base, 'GET', `/api/videos/${id}/transcript`)).body[0]).toMatchObject({ text: '失敗之後改的字', edited: true })

    // fails again; the retry keeps 'full' and replaces the edit
    expect((await api(base, 'POST', `/api/videos/${id}/reanalyze`, { mode: 'full' })).status).toBe(200)
    expect((await waitForAnalysis(id)).analysis).toMatchObject({ status: 'failed', mode: 'full', version: 2 })
    await fsp.rm(failMarker)
    expect((await api<SourceVideo>(base, 'POST', `/api/videos/${id}/retry`)).body.analysis.mode).toBe('full')
    expect((await waitForAnalysis(id)).analysis.status).toBe('done')
    const kept = (await api<Highlight[]>(base, 'GET', `/api/videos/${id}/highlights`)).body
    expect(kept.map(x => x.id)).toContain(manual.body.id)
    expect((await api<TranscriptSegment[]>(base, 'GET', `/api/videos/${id}/transcript`)).body.every(seg => !seg.edited)).toBe(true)

    const again = await api(base, 'POST', `/api/videos/${id}/retry`)
    expect(again.status).toBe(409)
    expect(again.body.statusMessage).toBe('只有分析失敗的影片可以重試')
    expect((await api(base, 'POST', '/api/videos/nope/retry')).status).toBe(404)
  })

  it('DELETE /api/videos/:id removes rows and data files but keeps the Watch Folder original', async () => {
    const videos = (await api<SourceVideo[]>(base, 'GET', '/api/videos')).body
    const target = videos.find(v => v.filePath === mkvPath)!
    const clips = (await api<Clip[]>(base, 'GET', `/api/videos/${target.id}/clips`)).body
    expect(clips.length).toBeGreaterThan(0)

    const res = await api(base, 'DELETE', `/api/videos/${target.id}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect((await api(base, 'GET', `/api/videos/${target.id}`)).status).toBe(404)
    expect((await api(base, 'GET', `/api/clips/${clips[0]!.id}/file`)).status).toBe(404)
    expect(fs.existsSync(path.join(dataDir, 'videos', target.id))).toBe(false)
    expect(fs.existsSync(path.join(dataDir, 'clips', target.id))).toBe(false)
    expect(fs.existsSync(mkvPath)).toBe(true)
    expect(fs.existsSync(path.join(watchDir, 'notes.txt'))).toBe(true)
    expect((await api(base, 'DELETE', `/api/videos/${target.id}`)).status).toBe(404)

    // It can be added again afterwards.
    const files = await api<WatchFolderFile[]>(base, 'GET', '/api/watch-folders/files')
    expect(files.body.find(f => f.path === mkvPath)?.inLibrary).toBe(false)
  })

  it('deleting a video while it is being analysed cancels the job', async () => {
    const added = await api<SourceVideo>(base, 'POST', '/api/videos', { sourceKind: 'watch-folder', filePath: mkvPath, language: 'en', audioTrack: 1 })
    expect(added.status).toBe(200)
    const del = await api(base, 'DELETE', `/api/videos/${added.body.id}`)
    expect(del.status).toBe(200)
    expect(fs.existsSync(path.join(dataDir, 'videos', added.body.id))).toBe(false)
    expect(fs.existsSync(mkvPath)).toBe(true)

    // The queue still works afterwards.
    const next = await api<SourceVideo>(base, 'POST', '/api/videos', { sourceKind: 'watch-folder', filePath: mkvPath, language: 'en', audioTrack: 1 })
    expect((await waitForAnalysis(next.body.id)).analysis.status).toBe('done')
    expect(server.output()).not.toMatch(/工作意外失敗|unhandled/i)
  })
})

describe('restart recovery (startup plugin)', () => {
  /** A second data folder, served by servers that are stopped or killed mid-Analysis. */
  async function restartCase(stopWith: 'SIGTERM' | 'SIGKILL') {
    const caseDir = await fsp.mkdtemp(path.join(tmp, `restart-${stopWith}-`))
    const pidFile = path.join(caseDir, 'pid.json')
    const env = {
      GG_DATA_DIR: path.join(caseDir, 'data'),
      GG_FONTS_DIR: fontsDir(),
      GG_VIDEO_ENCODER: 'libx264',
      GG_ASR_DEVICE: 'cpu',
      GG_FAKE_PID_FILE: pidFile,
    }
    const slow = await startServer({ ...env, GG_TRANSCRIBER_CMD: JSON.stringify([process.execPath, FAKE_TRANSCRIBER, '--scenario=slow']) })
    let pid = 0
    try {
      expect((await api(slow.url, 'PUT', '/api/settings', { watchFolders: [watchDir] })).status).toBe(200)
      // startServer turns Ollama off unless a test sets GG_OLLAMA_URL.
      expect((await api<SystemInfo>(slow.url, 'GET', '/api/system')).body.ollama).toMatchObject({ url: null, status: 'disabled', version: null })
      const added = await api<SourceVideo>(slow.url, 'POST', '/api/videos', { sourceKind: 'watch-folder', filePath: mp4Path, language: 'en', audioTrack: 0 })
      expect(added.status).toBe(200)
      await waitUntil(async () => fs.existsSync(pidFile))
      pid = (JSON.parse(await fsp.readFile(pidFile, 'utf8')) as { pid: number }).pid
      const running = await api<SourceVideo>(slow.url, 'GET', `/api/videos/${added.body.id}`)
      expect(running.body.analysis).toMatchObject({ status: 'running', step: 'transcribe' })

      if (stopWith === 'SIGTERM') {
        expect(await slow.stop()).toBe(0)
        // The graceful shutdown killed the transcriber too.
        await waitUntil(async () => !alive(pid), 10_000)
      }
      else {
        slow.child.kill('SIGKILL')
        await slow.stop()
        // A hard kill leaves the (detached) transcriber behind; clean it up like the OS would on reboot.
        if (alive(pid)) process.kill(pid, 'SIGKILL')
      }

      const next = await startServer({ ...env, GG_TRANSCRIBER_CMD: JSON.stringify([process.execPath, FAKE_TRANSCRIBER]) })
      try {
        await waitUntil(async () => next.output().includes('重新排隊 1 個中斷的分析'), 10_000)
        const done = await waitUntil(async () => {
          const res = await api<SourceVideo>(next.url, 'GET', `/api/videos/${added.body.id}`)
          return res.body.analysis.status === 'done' ? res.body : null
        })
        expect(done.analysis.error).toBeNull()
        const transcript = await api<TranscriptSegment[]>(next.url, 'GET', `/api/videos/${added.body.id}/transcript`)
        expect(transcript.body.length).toBeGreaterThan(0)
      }
      finally {
        await next.stop()
      }
    }
    finally {
      if (slow.child.exitCode === null) await slow.stop()
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
    }
  }

  function alive(pid: number) {
    try {
      process.kill(pid, 0)
      return true
    }
    catch {
      return false
    }
  }

  // Windows has no SIGTERM: child.kill() terminates at once, which is the crash case below.
  it.skipIf(process.platform === 'win32')('re-runs an Analysis interrupted by a normal shutdown', async () => {
    await restartCase('SIGTERM')
  })

  it('re-runs an Analysis interrupted by a crash', async () => {
    await restartCase('SIGKILL')
  })
})

describe('Ollama going away', () => {
  it('GET /api/system answers quickly with status unreachable, and an Analysis still finishes with loudness only', async () => {
    await ollama.close()
    const started = Date.now()
    const res = await api<SystemInfo>(base, 'GET', '/api/system')
    expect(res.status).toBe(200)
    expect(res.body.ollama).toEqual({ url: ollama.url, model: OLLAMA_MODEL, status: 'unreachable', version: null })
    expect(Date.now() - started).toBeLessThan(3000)

    const videos = (await api<SourceVideo[]>(base, 'GET', '/api/videos')).body
    const target = videos.find(v => v.filePath === mp4Path)!
    expect((await api(base, 'POST', `/api/videos/${target.id}/reanalyze`, { mode: 'highlights' })).status).toBe(200)
    const done = await waitForAnalysis(target.id)
    expect(done.analysis.status).toBe('done')
    expect(done.analysis.signals).toEqual([
      { kind: 'loudness', status: 'used', reason: null },
      { kind: 'transcript', status: 'missing', reason: `連不到 Ollama（${ollama.url}），請確認 Ollama 已啟動` },
    ])
  })
})
