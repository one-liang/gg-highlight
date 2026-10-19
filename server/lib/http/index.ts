// Serving large local files (source previews, clips) to the browser with Range support.
import type { H3Event } from 'h3'

export interface ServeFileOptions {
  contentType?: string
  /** When set, the response is a download (Content-Disposition: attachment) with this file name. */
  downloadName?: string
}

/** MIME type from the extension (mp4, mkv, webm, mov, srt, ass, wav...), default application/octet-stream. */
export function contentTypeFor(filePath: string): string {
  throw new Error('not implemented')
}

/** Content-Disposition value that keeps non-ASCII (Chinese) names via RFC 5987 filename*. */
export function contentDisposition(fileName: string, attachment: boolean): string {
  throw new Error('not implemented')
}

/** Sends the file honouring Range requests (206/416). Throws a 404 H3Error when missing. */
export function serveFile(event: H3Event, filePath: string, opts?: ServeFileOptions): Promise<unknown> {
  throw new Error('not implemented')
}
