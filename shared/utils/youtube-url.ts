// YouTube link parsing shared by the server (validation) and the UI (instant feedback). Pure.
// Rules: docs/design.md「YouTube」→「加入」.

export const NOT_YOUTUBE_MESSAGE = '這不是 YouTube 影片連結'
export const PLAYLIST_OR_CHANNEL_MESSAGE = '不支援播放清單或頻道，請貼單一影片的連結'

export type YoutubeUrlResult =
  | { ok: true, /** 11-character video id. */ id: string, /** https://www.youtube.com/watch?v=<id> */ url: string }
  /** not-youtube → HTTP 400, playlist-or-channel → HTTP 422; message is the zh-TW text above. */
  | { ok: false, reason: 'not-youtube' | 'playlist-or-channel', message: string }

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
])
const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be'])
/** YouTube Studio: the address bar of a video's pages there reads /video/<id>/edit (or /livestreaming, /analytics/…). */
const STUDIO_HOST = 'studio.youtube.com'
/** Path prefixes whose next segment is the video id. */
const ID_PATHS = new Set(['live', 'shorts', 'embed', 'v'])
/** Channel pages (besides /@name). */
const CHANNEL_PATHS = new Set(['channel', 'c', 'user'])

/** True for an 11-character YouTube video id. */
export function isYoutubeVideoId(value: string): boolean {
  return VIDEO_ID_RE.test(value)
}

/** https://www.youtube.com/watch?v=<id> */
export function canonicalYoutubeUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`
}

function video(id: string | null | undefined): YoutubeUrlResult {
  if (id && VIDEO_ID_RE.test(id)) return { ok: true, id, url: canonicalYoutubeUrl(id) }
  return notYoutube()
}

function notYoutube(): YoutubeUrlResult {
  return { ok: false, reason: 'not-youtube', message: NOT_YOUTUBE_MESSAGE }
}

function playlistOrChannel(): YoutubeUrlResult {
  return { ok: false, reason: 'playlist-or-channel', message: PLAYLIST_OR_CHANNEL_MESSAGE }
}

function parseUrl(input: string): URL | null {
  let text = input.trim()
  if (!text) return null
  if (text.startsWith('//')) text = `https:${text}`
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`
  try {
    const url = new URL(text)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null
  }
  catch {
    return null
  }
}

/**
 * Accepts youtube.com/watch?v=, youtu.be/, /live/, /shorts/, /embed/, /v/ on www., m., music. and
 * youtube-nocookie.com, and YouTube Studio's studio.youtube.com/video/<id>/…, with or without scheme,
 * surrounding whitespace allowed. Drops list=, t=, si=…
 * (a watch URL with list= is still the single video). Playlist-only, channel (/@name, /channel/, /c/,
 * /user/) and search (/results) links → playlist-or-channel. Anything else → not-youtube.
 */
export function parseYoutubeUrl(input: string): YoutubeUrlResult {
  const url = parseUrl(input)
  if (!url) return notYoutube()
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  const segments = url.pathname.split('/').filter(Boolean)

  if (SHORT_HOSTS.has(host)) return video(segments[0])
  if (host === STUDIO_HOST) return segments[0]?.toLowerCase() === 'video' ? video(segments[1]) : notYoutube()
  if (!YOUTUBE_HOSTS.has(host)) return notYoutube()

  const first = (segments[0] ?? '').toLowerCase()
  if (first === 'watch') {
    const id = url.searchParams.get('v')
    if (id) return video(id)
    return url.searchParams.has('list') ? playlistOrChannel() : notYoutube()
  }
  if (ID_PATHS.has(first)) {
    // /embed/videoseries?list=… is an embedded playlist.
    if (first === 'embed' && segments[1] === 'videoseries') return playlistOrChannel()
    return video(segments[1])
  }
  if (first === 'playlist' || first === 'results' || first.startsWith('@') || CHANNEL_PATHS.has(first)) {
    return playlistOrChannel()
  }
  return notYoutube()
}
