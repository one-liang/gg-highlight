// Helpers shared by the server/api routes: validation, errors and API business rules.
// Explicit imports only, so Vitest can test them without Nitro.
export { asHttpError, badRequest, conflict, forbidden, httpError, isHttpError, notFound, unprocessable, unreadableVideo } from './errors'
export {
  addVideoSchema, createClipSchema, createHighlightSchema, MAX_SEGMENT_TEXT_CHARS, parseIndexParam, parseWith,
  probeSchema, reanalyzeSchema, requireParam, settingsSchema, updateHighlightSchema, updateSegmentSchema,
} from './validation'
export {
  checkHighlightRange, clipDownloadName, clock, END_SLACK_SECONDS, fileNameClock, LAYOUT_LABELS, MIN_HIGHLIGHT_SECONDS,
  normalizeWatchFolders, safeFileNamePart, titleFromFileName,
} from './rules'
export { getClipOr404, getHighlightOr404, getVideoOr404, readJsonBody } from './lookup'
export { allowedMethods, type MatchedRoute } from './fallback'
export {
  checkReanalyze, NOT_READY_MESSAGES, REANALYZE_BUSY_MESSAGE, REANALYZE_CLIPS_BUSY_MESSAGE, REANALYZE_MISSING_SOURCE_MESSAGE,
  REANALYZE_NO_TRANSCRIPT_MESSAGE, requireTranscriptReady, transcriptReady,
} from './analysis'
export type { ReanalyzeContext } from './analysis'
export { ollamaInfo, SYSTEM_OLLAMA_TIMEOUT_MS } from './system'
