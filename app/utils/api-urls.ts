// URLs of the file endpoints used directly by <video> / download links.

const enc = encodeURIComponent

export function videoMediaUrl(videoId: string): string {
  return `/api/videos/${enc(videoId)}/media`
}

export function clipFileUrl(clipId: string, download = false): string {
  return `/api/clips/${enc(clipId)}/file${download ? '?download=1' : ''}`
}

export function clipSrtUrl(clipId: string): string {
  return `/api/clips/${enc(clipId)}/srt`
}
