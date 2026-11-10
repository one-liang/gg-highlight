import { describe, expect, it } from 'vitest'
import { apiErrorMessage } from './api-error'
import { uploadFile, UploadAbortedError, UploadHttpError, type UploadXhr } from './upload'

class FakeXhr implements UploadXhr {
  method = ''
  url = ''
  headers: Record<string, string> = {}
  body: Blob | null = null
  status = 0
  responseText = ''
  upload: UploadXhr['upload'] = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }

  send(body: Blob) {
    this.body = body
  }

  abort() {
    this.onabort?.()
  }

  respond(status: number, body: string) {
    this.status = status
    this.responseText = body
    this.onload?.()
  }
}

function makeFile(name: string, size = 10) {
  return new File([new Uint8Array(size)], name, { type: 'video/x-matroska' })
}

describe('uploadFile', () => {
  it('sends the raw body with an encoded file name and reports progress', async () => {
    const xhr = new FakeXhr()
    const progress: Array<[number, number]> = []
    const file = makeFile('實況 2026-10-19 21-00-00.mkv', 100)
    const handle = uploadFile<{ uploadId: string }>(file, { createXhr: () => xhr, onProgress: (l, t) => progress.push([l, t]) })

    expect(xhr.method).toBe('POST')
    expect(xhr.url).toBe('/api/uploads')
    expect(xhr.headers['X-File-Name']).toBe(encodeURIComponent('實況 2026-10-19 21-00-00.mkv'))
    expect(decodeURIComponent(xhr.headers['X-File-Name']!)).toBe(file.name)
    expect(xhr.body).toBe(file)

    xhr.upload.onprogress?.({ loaded: 40, total: 100, lengthComputable: true })
    xhr.upload.onprogress?.({ loaded: 70, total: 0, lengthComputable: false })
    expect(progress).toEqual([[40, 100], [70, 100]])

    xhr.respond(200, JSON.stringify({ uploadId: 'u1' }))
    await expect(handle.promise).resolves.toEqual({ uploadId: 'u1' })
  })

  it('rejects with the server statusMessage on HTTP errors', async () => {
    const xhr = new FakeXhr()
    const handle = uploadFile(makeFile('a.txt'), { createXhr: () => xhr })
    xhr.respond(415, JSON.stringify({ statusCode: 415, statusMessage: '不支援這種檔案格式' }))
    const err = await handle.promise.catch(e => e)
    expect(err).toBeInstanceOf(UploadHttpError)
    expect(apiErrorMessage(err, '上傳失敗')).toBe('不支援這種檔案格式')
  })

  it('rejects when a 2xx answer is not JSON', async () => {
    const xhr = new FakeXhr()
    const handle = uploadFile(makeFile('a.mp4'), { createXhr: () => xhr })
    xhr.respond(200, '<!doctype html>')
    const err = await handle.promise.catch(e => e)
    expect(apiErrorMessage(err, '上傳失敗')).toBe('上傳失敗（伺服器回應格式不正確）')
  })

  it('can be aborted', async () => {
    const xhr = new FakeXhr()
    const handle = uploadFile(makeFile('a.mp4'), { createXhr: () => xhr })
    handle.abort()
    const err = await handle.promise.catch(e => e)
    expect(err).toBeInstanceOf(UploadAbortedError)
    expect(apiErrorMessage(err, '上傳失敗')).toBe('已取消')
  })

  it('reports network errors', async () => {
    const xhr = new FakeXhr()
    const handle = uploadFile(makeFile('a.mp4'), { createXhr: () => xhr, method: 'PUT', url: '/api/uploads' })
    expect(xhr.method).toBe('PUT')
    xhr.onerror?.()
    const err = await handle.promise.catch(e => e)
    expect(apiErrorMessage(err, '上傳失敗')).toContain('無法連線')
  })
})
