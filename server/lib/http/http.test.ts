import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createApp, eventHandler, getQuery, toNodeListener } from 'h3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fixtures } from '../../../tests/fixtures'
import { contentDisposition, contentTypeFor, parseRange, serveFile } from './index'

interface Response {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

let dir: string
let server: http.Server
let base: string
let data: Buffer
let dataFile: string
let bigFile: string
const SIZE = 100_000
const DOWNLOAD_NAME = '我的 "精華" 影片_01-05_模糊背景.mp4'

function request(urlPath: string, init: { method?: string, headers?: Record<string, string> } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${urlPath}`, { method: init.method ?? 'GET', headers: init.headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

const range = (value: string) => ({ headers: { Range: value } })

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-http-'))
  data = randomBytes(SIZE)
  dataFile = path.join(dir, 'clip.mp4')
  fs.writeFileSync(dataFile, data)
  fs.writeFileSync(path.join(dir, 'empty.mp4'), '')
  fs.writeFileSync(path.join(dir, 'clip.srt'), '1\n00:00:00,000 --> 00:00:01,000\n你好\n')
  bigFile = path.join(dir, 'big.mkv')
  fs.writeFileSync(bigFile, Buffer.alloc(32 * 1024 * 1024))

  const files: Record<string, string> = {
    '/clip': dataFile,
    '/empty': path.join(dir, 'empty.mp4'),
    '/srt': path.join(dir, 'clip.srt'),
    '/big': bigFile,
    '/missing': path.join(dir, 'nope.mp4'),
    '/dir': dir,
    '/fixture': fixtures().sampleEnMp4,
  }
  const app = createApp()
  app.use(eventHandler((event) => {
    const file = files[event.path.split('?')[0]!]
    if (!file) return
    const query = getQuery(event)
    return serveFile(event, file, {
      downloadName: query.download ? DOWNLOAD_NAME : undefined,
      contentType: typeof query.type === 'string' ? query.type : undefined,
    })
  }))
  server = http.createServer(toNodeListener(app))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('serveFile', () => {
  it('sends the whole file with length, type and Accept-Ranges', async () => {
    const res = await request('/clip')
    expect(res.status).toBe(200)
    expect(res.headers['accept-ranges']).toBe('bytes')
    expect(res.headers['content-type']).toBe('video/mp4')
    expect(res.headers['content-length']).toBe(String(SIZE))
    expect(res.headers['content-range']).toBeUndefined()
    expect(res.headers['content-disposition']).toBeUndefined()
    expect(res.headers['last-modified']).toBe(fs.statSync(dataFile).mtime.toUTCString())
    expect(res.body.equals(data)).toBe(true)
  })

  it('serves a closed byte range', async () => {
    const res = await request('/clip', range('bytes=100-199'))
    expect(res.status).toBe(206)
    expect(res.headers['content-range']).toBe(`bytes 100-199/${SIZE}`)
    expect(res.headers['content-length']).toBe('100')
    expect(res.body.equals(data.subarray(100, 200))).toBe(true)
  })

  it('serves a single byte and clamps an end past the file', async () => {
    let res = await request('/clip', range('bytes=0-0'))
    expect(res.status).toBe(206)
    expect(res.body.equals(data.subarray(0, 1))).toBe(true)

    res = await request('/clip', range(`bytes=${SIZE - 10}-${SIZE * 2}`))
    expect(res.status).toBe(206)
    expect(res.headers['content-range']).toBe(`bytes ${SIZE - 10}-${SIZE - 1}/${SIZE}`)
    expect(res.body.equals(data.subarray(SIZE - 10))).toBe(true)
  })

  it('serves an open-ended range (what <video> sends first)', async () => {
    const res = await request('/clip', range('bytes=0-'))
    expect(res.status).toBe(206)
    expect(res.headers['content-range']).toBe(`bytes 0-${SIZE - 1}/${SIZE}`)
    expect(res.body.equals(data)).toBe(true)

    const tail = await request('/clip', range('bytes=99000-'))
    expect(tail.status).toBe(206)
    expect(tail.headers['content-length']).toBe('1000')
    expect(tail.body.equals(data.subarray(99_000))).toBe(true)
  })

  it('serves a suffix range', async () => {
    const res = await request('/clip', range('bytes=-500'))
    expect(res.status).toBe(206)
    expect(res.headers['content-range']).toBe(`bytes ${SIZE - 500}-${SIZE - 1}/${SIZE}`)
    expect(res.body.equals(data.subarray(SIZE - 500))).toBe(true)

    const all = await request('/clip', range(`bytes=-${SIZE * 3}`))
    expect(all.status).toBe(206)
    expect(all.headers['content-range']).toBe(`bytes 0-${SIZE - 1}/${SIZE}`)
    expect(all.body.equals(data)).toBe(true)
  })

  it('answers 416 with the size for unsatisfiable or malformed ranges', async () => {
    for (const value of [`bytes=${SIZE}-`, `bytes=${SIZE}-${SIZE + 10}`, 'bytes=500-100', 'bytes=-0', 'bytes=abc', 'bytes=', 'bytes=-', 'bytes=1.5-2']) {
      const res = await request('/clip', range(value))
      expect(res.status, value).toBe(416)
      expect(res.headers['content-range'], value).toBe(`bytes */${SIZE}`)
      expect(res.body.length, value).toBe(0)
    }
  })

  it('ignores other units and multiple ranges', async () => {
    for (const value of ['items=0-5', 'bytes=0-1,5-6']) {
      const res = await request('/clip', range(value))
      expect(res.status, value).toBe(200)
      expect(res.body.equals(data), value).toBe(true)
    }
  })

  it('answers HEAD with headers only', async () => {
    const res = await request('/clip', { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers['content-length']).toBe(String(SIZE))
    expect(res.headers['content-type']).toBe('video/mp4')
    expect(res.headers['accept-ranges']).toBe('bytes')
    expect(res.body.length).toBe(0)

    const ranged = await request('/clip', { method: 'HEAD', headers: { Range: 'bytes=10-19' } })
    expect(ranged.status).toBe(206)
    expect(ranged.headers['content-range']).toBe(`bytes 10-19/${SIZE}`)
    expect(ranged.headers['content-length']).toBe('10')
    expect(ranged.body.length).toBe(0)
  })

  it('sends downloads as attachments keeping the Chinese file name', async () => {
    const res = await request('/clip?download=1')
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toBe(contentDisposition(DOWNLOAD_NAME, true))
    const disposition = res.headers['content-disposition']!
    expect(disposition.startsWith('attachment; ')).toBe(true)
    const encoded = /filename\*=UTF-8''(.+)$/.exec(disposition)![1]!
    expect(decodeURIComponent(encoded)).toBe(DOWNLOAD_NAME)
    expect(res.body.equals(data)).toBe(true)

    const ranged = await request('/clip?download=1', range('bytes=0-9'))
    expect(ranged.status).toBe(206)
    expect(ranged.headers['content-disposition']).toBe(disposition)
  })

  it('uses the extension or an explicit content type', async () => {
    const srt = await request('/srt')
    expect(srt.headers['content-type']).toBe('application/x-subrip; charset=utf-8')
    expect(srt.body.toString('utf8')).toContain('你好')
    const custom = await request('/clip?type=application/octet-stream')
    expect(custom.headers['content-type']).toBe('application/octet-stream')
  })

  it('serves empty files', async () => {
    const res = await request('/empty')
    expect(res.status).toBe(200)
    expect(res.headers['content-length']).toBe('0')
    expect(res.body.length).toBe(0)
    const ranged = await request('/empty', range('bytes=0-'))
    expect(ranged.status).toBe(416)
    expect(ranged.headers['content-range']).toBe('bytes */0')
  })

  it('answers 404 for missing files and folders, without file headers', async () => {
    for (const p of ['/missing', '/dir']) {
      const res = await request(p)
      expect(res.status, p).toBe(404)
      expect(res.headers['content-type']).toContain('application/json')
      expect(res.headers['accept-ranges']).toBeUndefined()
      expect(JSON.parse(res.body.toString('utf8'))).toMatchObject({ statusCode: 404, statusMessage: '找不到檔案' })
    }
  })

  it('serves a real video fixture', async () => {
    const file = fixtures().sampleEnMp4
    const res = await request('/fixture', range('bytes=0-7'))
    expect(res.status).toBe(206)
    expect(res.headers['content-range']).toBe(`bytes 0-7/${fs.statSync(file).size}`)
    expect(res.body.subarray(4, 8).toString('latin1')).toBe('ftyp')
  })

  it.skipIf(process.platform !== 'linux')('closes the file when the client aborts mid-stream', async () => {
    const openFds = () => fs.readdirSync('/proc/self/fd').filter((fd) => {
      try {
        return fs.readlinkSync(`/proc/self/fd/${fd}`) === bigFile
      }
      catch {
        return false
      }
    }).length

    await new Promise<void>((resolve, reject) => {
      const req = http.get(`${base}/big`, { agent: false }, (res) => {
        expect(res.statusCode).toBe(200)
        res.once('data', () => {
          req.destroy()
          resolve()
        })
      })
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err)
      })
    })

    const deadline = Date.now() + 5000
    while (openFds() > 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
    expect(openFds()).toBe(0)

    // The server is still healthy afterwards.
    expect((await request('/clip', range('bytes=0-3'))).status).toBe(206)
  })
})

describe('contentTypeFor', () => {
  it('maps known extensions case-insensitively', () => {
    expect(contentTypeFor('a.mp4')).toBe('video/mp4')
    expect(contentTypeFor('A.MKV')).toBe('video/x-matroska')
    expect(contentTypeFor('a.webm')).toBe('video/webm')
    expect(contentTypeFor('a.mov')).toBe('video/quicktime')
    expect(contentTypeFor('a.wav')).toBe('audio/wav')
    expect(contentTypeFor('a.srt')).toBe('application/x-subrip; charset=utf-8')
    expect(contentTypeFor('a.ass')).toBe('text/x-ssa; charset=utf-8')
    expect(contentTypeFor(path.join('C:', 'x', 'preview.mp4'))).toBe('video/mp4')
  })

  it('falls back to octet-stream', () => {
    expect(contentTypeFor('a.xyz')).toBe('application/octet-stream')
    expect(contentTypeFor('noext')).toBe('application/octet-stream')
  })
})

describe('contentDisposition', () => {
  it('keeps plain ASCII names', () => {
    expect(contentDisposition('clip.mp4', true)).toBe(`attachment; filename="clip.mp4"; filename*=UTF-8''clip.mp4`)
    expect(contentDisposition('clip.mp4', false)).toBe(`inline; filename="clip.mp4"; filename*=UTF-8''clip.mp4`)
  })

  it('replaces non-ASCII in the fallback and percent-encodes filename*', () => {
    expect(contentDisposition('影片 1.mp4', true)).toBe(`attachment; filename="__ 1.mp4"; filename*=UTF-8''%E5%BD%B1%E7%89%87%201.mp4`)
  })

  it('escapes quotes and backslashes and encodes RFC 5987 specials', () => {
    const value = contentDisposition(`a"b\\c'(d)*.mp4`, true)
    expect(value).toBe(`attachment; filename="a\\"b\\\\c'(d)*.mp4"; filename*=UTF-8''a%22b%5Cc%27%28d%29%2A.mp4`)
  })

  it('never lets control characters or emoji break the header', () => {
    const value = contentDisposition('a\r\nSet-Cookie: x😀.mp4', true)
    expect(value).not.toMatch(/[\r\n]/)
    expect(value).toContain('filename="a__Set-Cookie: x_.mp4"')
    expect(() => new Headers({ 'content-disposition': value })).not.toThrow()
    expect(() => contentDisposition('bad\uD800.mp4', true)).not.toThrow()
  })
})

describe('parseRange', () => {
  it('parses the three single-range forms', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('Bytes = 5 - 6', 100)).toEqual({ start: 5, end: 6 })
  })

  it('returns null when the whole file should be sent', () => {
    expect(parseRange(undefined, 100)).toBeNull()
    expect(parseRange('', 100)).toBeNull()
    expect(parseRange('items=0-1', 100)).toBeNull()
    expect(parseRange('bytes=0-1, 4-5', 100)).toBeNull()
  })

  it('flags unsatisfiable ranges', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=5-4', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable')
    expect(parseRange('bytes=-5', 0)).toBe('unsatisfiable')
    expect(parseRange('bytes=x-y', 100)).toBe('unsatisfiable')
  })
})
