// YoutubeTools over a YtdlpConfig, and the YtdlpConfig of the app.
import { type AppConfig, ytdlpStampPath } from '../config'
import { downloadsDir } from '../library/removal'
import { downloadChat, downloadVideo } from './download'
import { fetchMetadata } from './info'
import type { YoutubeTools, YtdlpConfig } from './types'

/** How the app runs yt-dlp. updateStampPath only for the yt-dlp the app manages (not GG_YTDLP_CMD). */
export function ytdlpConfigFrom(config: AppConfig, nodePath: string = process.execPath): YtdlpConfig {
  return {
    command: config.ytdlpCommand,
    ffmpegPath: config.ffmpegPath,
    nodePath,
    downloadsDir: downloadsDir(config),
    updateStampPath: config.ytdlpManaged ? ytdlpStampPath(config) : null,
  }
}

export function createYoutubeTools(config: YtdlpConfig): YoutubeTools {
  return {
    fetchMetadata: (url, options) => fetchMetadata(config, url, options),
    downloadVideo: options => downloadVideo(config, options),
    downloadChat: options => downloadChat(config, options),
  }
}
