// Raw-body file upload with progress and cancel (fetch has no upload progress, so XHR).
import { InvalidResponseError } from './api-error'

export class UploadAbortedError extends Error {
  constructor() {
    super('Upload aborted')
    this.name = 'AbortError'
  }
}

/** Non-2xx answer; `data` is the parsed JSON body so describeApiError can read statusMessage. */
export class UploadHttpError extends Error {
  readonly statusCode: number
  readonly data: unknown
  constructor(statusCode: number, data: unknown) {
    super(`Upload failed with HTTP ${statusCode}`)
    this.name = 'UploadHttpError'
    this.statusCode = statusCode
    this.data = data
  }
}

export class UploadNetworkError extends Error {
  constructor() {
    super('Upload network error')
    this.name = 'UploadNetworkError'
  }
}

/** The XHR surface we use; lets tests pass a fake. */
export interface UploadXhr {
  open: (method: string, url: string) => void
  setRequestHeader: (name: string, value: string) => void
  send: (body: Blob) => void
  abort: () => void
  readonly status: number
  readonly responseText: string
  upload: { onprogress: ((e: { loaded: number, total: number, lengthComputable: boolean }) => void) | null }
  onload: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
}

export interface UploadOptions {
  url?: string
  method?: 'POST' | 'PUT'
  onProgress?: (loaded: number, total: number) => void
  createXhr?: () => UploadXhr
}

export interface UploadHandle<T> {
  promise: Promise<T>
  abort: () => void
}

function parseJson(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
  }
}

export function uploadFile<T>(file: Blob & { name: string }, options: UploadOptions = {}): UploadHandle<T> {
  const xhr = options.createXhr ? options.createXhr() : new XMLHttpRequest() as unknown as UploadXhr
  const promise = new Promise<T>((resolve, reject) => {
    xhr.open(options.method ?? 'POST', options.url ?? '/api/uploads')
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name))
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.upload.onprogress = (e) => {
      options.onProgress?.(e.loaded, e.lengthComputable ? e.total : file.size)
    }
    xhr.onload = () => {
      const data = parseJson(xhr.responseText)
      const ok = xhr.status >= 200 && xhr.status < 300
      if (ok && data && typeof data === 'object') resolve(data as T)
      else if (ok) reject(new InvalidResponseError())
      else reject(new UploadHttpError(xhr.status, data))
    }
    xhr.onerror = () => reject(new UploadNetworkError())
    xhr.onabort = () => reject(new UploadAbortedError())
    xhr.send(file)
  })
  return { promise, abort: () => xhr.abort() }
}
