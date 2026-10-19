// Turns raw ASR output into Transcript segments, and Transcript segments into clip subtitles.
// Pure functions only (no I/O) so everything here is unit-testable.
import type { Language, Layout, TranscriptSegment } from '../../../shared/types/domain'
import type { RawTranscript } from '../transcription/protocol'

export const SUBTITLE_FONT_NAME = 'Noto Sans CJK TC'

/** A Transcript segment before it is stored (no idx / edited flag yet). */
export interface SegmentDraft {
  start: number
  end: number
  text: string
}

/** One subtitle event, with times relative to the start of a Clip. */
export interface Cue {
  start: number
  end: number
  text: string
}

export interface SubtitleCanvas {
  width: number
  height: number
  layout: Layout
}

export interface SubtitleStyle {
  fontSize: number
  /** Distance from the bottom edge to the subtitle baseline area, in canvas pixels (ASS MarginV). */
  marginV: number
  marginH: number
  outline: number
  /** How many "units" fit on one line; a CJK character is 1 unit, a latin character 0.5. */
  maxUnitsPerLine: number
}

/** Simplified → Taiwan Traditional with Taiwan phrases (OpenCC cn → twp). */
export function toTaiwanTraditional(text: string): string {
  throw new Error('not implemented')
}

/** Display width of text in units: CJK/full-width = 1, everything else = 0.5. */
export function textUnits(text: string): number {
  throw new Error('not implemented')
}

/**
 * Splits raw ASR segments into subtitle-sized Transcript segments using word timestamps:
 * at most MAX_SEGMENT_UNITS units and MAX_SEGMENT_SECONDS long, preferring splits at
 * punctuation and pauses. For zh the text is converted with toTaiwanTraditional and
 * sentence punctuation is turned into spaces/removed the way Taiwanese subtitles do.
 */
export function buildTranscriptSegments(raw: RawTranscript, language: Language): SegmentDraft[] {
  throw new Error('not implemented')
}

/**
 * Transcript segments overlapping [start, end] of the source, clamped to the range and shifted
 * so 0 is the clip start. Drops pieces shorter than 0.2 s and empty text.
 */
export function cuesForRange(segments: Array<Pick<TranscriptSegment, 'start' | 'end' | 'text'>>, start: number, end: number): Cue[] {
  throw new Error('not implemented')
}

/** Breaks text into at most maxLines balanced lines of at most maxUnitsPerLine units each. */
export function wrapLines(text: string, maxUnitsPerLine: number, maxLines?: number): string[] {
  throw new Error('not implemented')
}

/** Short-video subtitle look per canvas: big white text, black outline, bottom-centre-ish. */
export function subtitleStyleFor(canvas: SubtitleCanvas): SubtitleStyle {
  throw new Error('not implemented')
}

/** Full ASS document (PlayRes = canvas size) with one Dialogue per cue, pre-wrapped with \N. */
export function buildAss(cues: Cue[], canvas: SubtitleCanvas, fontName?: string): string {
  throw new Error('not implemented')
}

/** SRT document for the cues (1-based numbering, HH:MM:SS,mmm). */
export function buildSrt(cues: Cue[]): string {
  throw new Error('not implemented')
}
