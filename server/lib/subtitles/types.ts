import type { Layout } from '../../../shared/types/domain'

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
