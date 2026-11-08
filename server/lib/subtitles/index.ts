// Turns raw ASR output into Transcript segments, and Transcript segments into clip subtitles.
// Pure functions only (no I/O) so everything here is unit-testable.
//   text.ts      OpenCC conversion, character widths, per-language cleanup
//   segments.ts  raw ASR segments → subtitle-sized Transcript segments
//   cues.ts      Transcript segments → clip-relative cues
//   wrap.ts      balanced line breaking
//   ass.ts       subtitle style per canvas, ASS and SRT documents
export { SUBTITLE_FONT_NAME } from './types'
export type { Cue, SegmentDraft, SubtitleCanvas, SubtitleStyle } from './types'
export { textEm, textUnits, toTaiwanTraditional } from './text'
export { buildTranscriptSegments, HARD_PAUSE_SECONDS, MAX_SEGMENT_SECONDS, MAX_SEGMENT_UNITS, PAUSE_SECONDS } from './segments'
export { cuesForRange, MIN_CUE_SECONDS } from './cues'
export { wrapLines } from './wrap'
export { buildAss, buildSrt, escapeAssText, fittingFontSize, FONT_SIZE_PER_EM, formatAssTime, formatSrtTime, subtitleStyleFor } from './ass'
