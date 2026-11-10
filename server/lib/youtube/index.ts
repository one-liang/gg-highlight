// YouTube via yt-dlp (docs/design.md「YouTube」「yt-dlp」, ADR-0003).
export * from './types'
export { createMetadataCache, METADATA_CACHE_TTL_MS, type MetadataCache } from './cache'
export {
  baseArgs, chatDownloadArgs, chatFilePath, chatPartPath, metadataArgs, usableFfmpegLocation, videoDownloadArgs,
} from './command'
export { CHAT_FAILED_PREFIX, chatLineOffsetMs, downloadChat, downloadVideo, lastChatOffsetMs } from './download'
export {
  classifyErrorLine, mapYtdlpError, METADATA_TIMEOUT_MESSAGE, noteUpdateHint, UNKNOWN_ERROR_PREFIX,
  YTDLP_ERROR_MESSAGES, YTDLP_NOT_FOUND_MESSAGE,
} from './errors'
export {
  assertAddable, fetchMetadata, isoUploadDate, languageHintOf, METADATA_TIMEOUT_MS, NOT_VIDEO_MESSAGE, parseMetadata,
} from './info'
export { DownloadProgress, formatFraction, parseFileLine, parseProgressLine } from './progress'
export { runYtdlp } from './run'
export { createYoutubeTools, ytdlpConfigFrom } from './tools'
export { readChatMessages, chatDensity } from './chat'
export { heatmapTrack } from './heatmap'
