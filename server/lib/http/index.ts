// Serving large local files (source previews, clips) to the browser with Range support.
import fs from 'node:fs'
import fsp, { type FileHandle } from 'node:fs/promises'
import { createError, getRequestHeader, type H3Event, send, sendStream, setResponseHeader, setResponseStatus } from 'h3'
import { contentDisposition, contentTypeFor, parseRange } from './headers'

export { contentDisposition, contentTypeFor, parseRange } from './headers'
export type { ByteRange } from './headers'

export interface ServeFileOptions {
  contentType?: string
  /** When set, the response is a download (Content-Disposition: attachment) with this file name. */
  downloadName?: string
}

const BODY_HEADERS = ['accept-ranges', 'content-disposition', 'content-length', 'content-range', 'content-type', 'last-modified']

function notFound() {
  return createError({ statusCode: 404, statusMessage: '找不到檔案' })
}

/** Opens first so a missing or unreadable file fails before any header is set. */
async function openFile(filePath: string): Promise<{ handle: FileHandle, size: number, mtime: Date }> {
  let handle: FileHandle
  try {
    handle = await fsp.open(filePath, 'r')
  }
  catch {
    throw notFound()
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw notFound()
    return { handle, size: stat.size, mtime: stat.mtime }
  }
  catch (err) {
    await handle.close().catch(() => {})
    throw err
  }
}

/** Sends the file honouring Range requests (206/416). Throws a 404 H3Error when missing. */
export async function serveFile(event: H3Event, filePath: string, opts: ServeFileOptions = {}): Promise<unknown> {
  const { handle, size, mtime } = await openFile(filePath)
  const res = event.node.res
  let streaming = false
  try {
    setResponseHeader(event, 'Accept-Ranges', 'bytes')
    setResponseHeader(event, 'Last-Modified', mtime.toUTCString())

    const range = parseRange(getRequestHeader(event, 'range'), size)
    if (range === 'unsatisfiable') {
      setResponseStatus(event, 416)
      setResponseHeader(event, 'Content-Range', `bytes */${size}`)
      setResponseHeader(event, 'Content-Length', 0)
      return await send(event, '')
    }

    const start = range?.start ?? 0
    const end = range?.end ?? size - 1
    setResponseStatus(event, range ? 206 : 200)
    if (range) setResponseHeader(event, 'Content-Range', `bytes ${start}-${end}/${size}`)
    setResponseHeader(event, 'Content-Type', opts.contentType ?? contentTypeFor(filePath))
    setResponseHeader(event, 'Content-Length', size === 0 ? 0 : end - start + 1)
    if (opts.downloadName) setResponseHeader(event, 'Content-Disposition', contentDisposition(opts.downloadName, true))

    if (event.method === 'HEAD' || size === 0) return await send(event, '')

    const stream = fs.createReadStream(filePath, { fd: handle, start, end, autoClose: true })
    streaming = true
    // A seeking <video> aborts many requests; release the file right away (Windows can't delete open files).
    if (res.socket) res.once('close', () => stream.destroy())
    try {
      return await sendStream(event, stream)
    }
    catch (err) {
      stream.destroy()
      if (res.headersSent) res.destroy()
      else for (const name of BODY_HEADERS) res.removeHeader(name)
      throw err
    }
  }
  finally {
    if (!streaming) await handle.close().catch(() => {})
  }
}
