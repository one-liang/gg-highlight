// YouTube via yt-dlp (docs/design.md「YouTube」「yt-dlp」, ADR-0003).
export * from './types'
export { createMetadataCache, METADATA_CACHE_TTL_MS, type MetadataCache } from './cache'
export {
  baseArgs, chatDownloadArgs, chatFilePath, chatPartPath, metadataArgs, usableFfmpegLocation, videoDownloadArgs,
} from './command'
export {
  CHAT_FAILED_PREFIX, chatDownloadFailureReason, chatLineOffsetMs, downloadChat, downloadVideo, lastChatOffsetMs,
} from './download'
export {
  classifyErrorLine, mapYtdlpError, METADATA_TIMEOUT_MESSAGE, noteUpdateHint, UNKNOWN_ERROR_PREFIX,
  YTDLP_ERROR_MESSAGES, YTDLP_NOT_FOUND_MESSAGE,
} from './errors'
export {
  assertAddable, fetchMetadata, isoUploadDate, languageHintOf, METADATA_TIMEOUT_MS, NOT_VIDEO_MESSAGE, parseMetadata,
} from './info'
export { DownloadProgress, formatFraction, parseFileLine, parseProgressLine } from './progress'
export { logFailure, runYtdlp, YTDLP_CLI_MESSAGES } from './run'
export { createYoutubeTools, ytdlpConfigFrom } from './tools'
// Chat density and replay heatmap Signals (readChatMessages, chatDensity, heatmapTrack and their constants).
export * from './chat'
export * from './heatmap'
