// Helpers shared by the server/api routes: validation, errors and API business rules.
// Explicit imports only, so Vitest can test them without Nitro.
export { asHttpError, badRequest, conflict, forbidden, httpError, isHttpError, notFound, unprocessable, unreadableVideo } from './errors'
export {
  addVideoSchema, createClipSchema, createHighlightSchema, MAX_SEGMENT_TEXT_CHARS, parseIndexParam, parseWith,
  probeSchema, requireParam, settingsSchema, updateHighlightSchema, updateSegmentSchema,
} from './validation'
export {
  checkHighlightRange, clipDownloadName, clock, END_SLACK_SECONDS, fileNameClock, LAYOUT_LABELS, MIN_HIGHLIGHT_SECONDS,
  normalizeWatchFolders, safeFileNamePart, titleFromFileName,
} from './rules'
export { getClipOr404, getHighlightOr404, getVideoOr404, readJsonBody } from './lookup'
export { allowedMethods, type MatchedRoute } from './fallback'
