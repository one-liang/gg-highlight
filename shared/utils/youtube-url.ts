// YouTube link parsing shared by the server (validation) and the UI (instant feedback). Pure.
// Rules: docs/design.md「YouTube」→「加入」.

export const NOT_YOUTUBE_MESSAGE = '這不是 YouTube 影片連結'
export const PLAYLIST_OR_CHANNEL_MESSAGE = '不支援播放清單或頻道，請貼單一影片的連結'

export type YoutubeUrlResult =
  | { ok: true, /** 11-character video id. */ id: string, /** https://www.youtube.com/watch?v=<id> */ url: string }
  /** not-youtube → HTTP 400, playlist-or-channel → HTTP 422; message is the zh-TW text above. */
  | { ok: false, reason: 'not-youtube' | 'playlist-or-channel', message: string }

/**
 * Accepts youtube.com/watch?v=, youtu.be/, /live/, /shorts/, /embed/, /v/ on www., m., music. and
 * youtube-nocookie.com, with or without scheme, surrounding whitespace allowed. Drops list=, t=, si=…
 * (a watch URL with list= is still the single video). Playlist-only, channel (/@name, /channel/, /c/,
 * /user/) and search (/results) links → playlist-or-channel. Anything else → not-youtube.
 */
export function parseYoutubeUrl(input: string): YoutubeUrlResult {
  void input
  throw new Error('not implemented')
}
