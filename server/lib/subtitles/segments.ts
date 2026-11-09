// Raw ASR output → subtitle-sized Transcript segments.
import type { Language } from '../../../shared/types/domain'
import type { RawSegment, RawTranscript } from '../transcription/protocol'
import type { SegmentDraft } from './types'
import { cleanEnText, cleanZhText, hasContent, isSpace, isTight, textUnits, toTaiwanTraditional } from './text'

/** About two subtitle lines: 26 CJK characters or ~52 latin characters. */
export const MAX_SEGMENT_UNITS = 26
export const MAX_SEGMENT_SECONDS = 7
/** A gap between words at least this long is a preferred split point. */
export const PAUSE_SECONDS = 0.4
/** A gap this long always ends a segment, so a line never hangs over a long silence. */
export const HARD_PAUSE_SECONDS = 1.5

interface Token {
  start: number
  end: number
  text: string
  /** Whisper put a space before this word that cleanup removed (a weak word-boundary hint in zh). */
  spaced?: boolean
}

const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '.', '．', '｡'])
const CLAUSE_END = new Set(['，', '、', '；', '：', ',', ';', ':', '…', '⋯', '—'])
const TRAILING_CLOSERS_RE = /[」』）)"'”’》〉】\]]+$/u

// Split costs: lower is a better place to cut (sentence end > clause > pause > any word).
const COST_SENTENCE = 0
const COST_CLAUSE = 3
const COST_CLAUSE_PAUSE = 2
const COST_PAUSE = 6
const COST_SPACED = 8
const COST_WORD = 10
const COST_PIECE = 4
// Safety bound for degenerate input (thousands of punctuation-only words with no duration).
const MAX_WORDS_PER_PIECE = 200
/** A line shorter than this has collapsed word timestamps; it is shown for COLLAPSED_LINE_SECONDS. */
const MIN_LINE_SECONDS = 0.2
const COLLAPSED_LINE_SECONDS = 1

const round3 = (x: number) => Math.round(x * 1000) / 1000

/**
 * Splits raw ASR segments into subtitle-sized Transcript segments using word timestamps:
 * at most MAX_SEGMENT_UNITS units and MAX_SEGMENT_SECONDS long, preferring splits at
 * punctuation and pauses. For zh the text is converted with toTaiwanTraditional and
 * sentence punctuation is turned into spaces/removed the way Taiwanese subtitles do.
 */
export function buildTranscriptSegments(raw: RawTranscript, language: Language): SegmentDraft[] {
  const clean = language === 'zh' ? cleanZhText : cleanEnText
  const drafts: SegmentDraft[] = []
  const segments = (raw?.segments ?? []).filter((seg): seg is RawSegment => !!seg)
  segments.forEach((seg, k) => {
    // Where this segment's speech must stop at the latest: the next segment, or the end of the audio.
    const nextStart = k + 1 < segments.length ? segments[k + 1]!.start : raw?.durationSec
    drafts.push(...splitTokens(segmentTokens(seg, language), clean, typeof nextStart === 'number' && Number.isFinite(nextStart) ? nextStart : null))
  })
  return resolveOverlaps(drafts)
}

function segmentTokens(seg: RawSegment, language: Language): Token[] {
  const words = wordTokens(seg)
  const tokens = words.some(t => t.text.trim()) ? words : proportionalTokens(seg, seg.text ?? '', language === 'zh')
  return language === 'zh' ? convertTokens(dropTightSpacesInTokens(tokens)) : tokens
}

function wordTokens(seg: RawSegment): Token[] {
  const tokens: Token[] = []
  for (const w of seg.words ?? []) {
    if (!w || typeof w.word !== 'string' || !w.word) continue
    if (!Number.isFinite(w.start) || !Number.isFinite(w.end)) continue
    tokens.push({ start: w.start, end: Math.max(w.start, w.end), text: w.word })
  }
  return tokens.sort((a, b) => a.start - b.start)
}

/** Segment without word timestamps: spread its text over the segment's time span by width. */
function proportionalTokens(seg: RawSegment, text: string, tight: boolean): Token[] {
  const pieces = tight ? splitTightText(text) : (text.match(/\s*\S+/gu) ?? [])
  if (!pieces.length || !Number.isFinite(seg.start) || !Number.isFinite(seg.end)) return []
  const weights = pieces.map(p => (hasContent(p) ? textUnits(p.trim()) : 0))
  const total = weights.reduce((a, b) => a + b, 0)
  const span = Math.max(0, seg.end - seg.start)
  const tokens: Token[] = []
  let acc = 0
  pieces.forEach((text, k) => {
    const w = total > 0 ? weights[k]! : 1
    const sum = total > 0 ? total : pieces.length
    const start = seg.start + (acc / sum) * span
    acc += w
    tokens.push({ start: round3(start), end: round3(seg.start + (acc / sum) * span), text })
  })
  return tokens
}

/** One pseudo-word per CJK character, latin runs kept whole; leading whitespace stays attached. */
function splitTightText(text: string): string[] {
  const out: string[] = []
  let pending = ''
  let run = ''
  const push = (piece: string) => {
    out.push(pending + piece)
    pending = ''
  }
  for (const ch of text) {
    if (isSpace(ch) || isTight(ch)) {
      if (run) push(run)
      run = ''
      if (isSpace(ch)) pending += ch
      else push(ch)
    }
    else {
      run += ch
    }
  }
  if (run) push(run)
  return out
}

/** Removes the spaces Whisper puts between CJK characters, across word boundaries too. */
function dropTightSpacesInTokens(tokens: Token[]): Token[] {
  const chars: string[] = []
  const owner: number[] = []
  tokens.forEach((t, k) => {
    for (const ch of t.text) {
      chars.push(ch)
      owner.push(k)
    }
  })
  const keep = chars.map(() => true)
  const spaced = tokens.map(() => false)
  for (let p = 0; p < chars.length;) {
    if (!isSpace(chars[p])) {
      p++
      continue
    }
    let q = p
    while (q < chars.length && isSpace(chars[q])) q++
    if (isTight(chars[p - 1]) && isTight(chars[q])) {
      keep.fill(false, p, q)
      spaced[owner[q]!] = true
    }
    p = q
  }
  const texts = tokens.map(() => '')
  chars.forEach((ch, i) => {
    if (keep[i]) texts[owner[i]!] += ch
  })
  return tokens
    .map((t, k) => ({ ...t, text: texts[k]!, spaced: spaced[k] || t.spaced }))
    .filter(t => t.text !== '')
}

/**
 * Converts the words of one segment to Taiwan Traditional as a whole (so phrases spanning
 * words still convert, e.g. 软|件 → 軟體) and hands the converted text back to the words.
 */
function convertTokens(tokens: Token[]): Token[] {
  const lengths = tokens.map(t => Array.from(t.text).length)
  const whole = toTaiwanTraditional(tokens.map(t => t.text).join(''))
  const wholeChars = Array.from(whole)
  if (wholeChars.length === lengths.reduce((a, b) => a + b, 0)) {
    let p = 0
    return tokens.map((t, k) => {
      const text = wholeChars.slice(p, p + lengths[k]!).join('')
      p += lengths[k]!
      return { ...t, text }
    })
  }
  // A phrase changed length (内存 → 記憶體): find each word's end in the converted text via
  // its converted prefix; when a phrase spans the boundary the next word takes it over.
  const out: Token[] = []
  let source = ''
  let cut = 0
  let carryStart: number | null = null
  tokens.forEach((t, k) => {
    source += t.text
    let next = whole.length
    if (k < tokens.length - 1) {
      const prefix = toTaiwanTraditional(source)
      next = whole.startsWith(prefix) ? Math.max(cut, prefix.length) : cut
    }
    const text = whole.slice(cut, next)
    cut = next
    const start: number = carryStart ?? t.start
    if (text) {
      out.push({ ...t, start, text })
      carryStart = null
    }
    else {
      carryStart = start
    }
  })
  return out
}

function breakCost(tokens: Token[], j: number): number {
  const text = tokens[j]!.text.trimEnd().replace(TRAILING_CLOSERS_RE, '')
  const last = text.slice(-1)
  const pause = tokens[j + 1]!.start - tokens[j]!.end >= PAUSE_SECONDS
  if (SENTENCE_END.has(last)) return COST_SENTENCE
  if (CLAUSE_END.has(last)) return pause ? COST_CLAUSE_PAUSE : COST_CLAUSE
  if (pause) return COST_PAUSE
  return tokens[j + 1]!.spaced ? COST_SPACED : COST_WORD
}

/** Fewer pieces are better, and among equals, balanced ones; tiny pieces cost extra. */
function pieceCost(units: number, seconds: number): number {
  const fill = units / MAX_SEGMENT_UNITS
  const span = Math.max(0, seconds) / MAX_SEGMENT_SECONDS
  const short = units < 4 ? (4 - units) * 0.75 : 0
  return COST_PIECE + 4 * fill * fill + 2 * span * span + short
}

/**
 * Dynamic programming over word boundaries: every piece within the limits, minimum total cost.
 * `nextStart` is where the next raw segment starts (or the audio ends); null when unknown.
 */
function splitTokens(tokens: Token[], clean: (text: string) => string, nextStart: number | null): SegmentDraft[] {
  const n = tokens.length
  if (!n) return []
  const best = new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY)
  const from = new Array<number>(n + 1).fill(-1)
  best[0] = 0
  for (let i = 0; i < n; i++) {
    const base = best[i]!
    if (base === Number.POSITIVE_INFINITY) continue
    let raw = ''
    let rawUnits = 0
    let end = Number.NEGATIVE_INFINITY
    for (let j = i; j < n && j - i < MAX_WORDS_PER_PIECE; j++) {
      const tok = tokens[j]!
      if (j > i && tok.start - end >= HARD_PAUSE_SECONDS) break
      raw += tok.text
      rawUnits += textUnits(tok.text)
      end = Math.max(end, tok.end)
      // Cleanup never makes text wider, so the exact (slower) width is only needed near the limit.
      const units = rawUnits <= MAX_SEGMENT_UNITS ? rawUnits : textUnits(clean(raw))
      const seconds = end - tokens[i]!.start
      // A single word is always allowed, even when it is over the limits on its own.
      if (j > i && (units > MAX_SEGMENT_UNITS || seconds > MAX_SEGMENT_SECONDS)) break
      const cost = base + pieceCost(units, seconds) + (j < n - 1 ? breakCost(tokens, j) : 0)
      if (cost < best[j + 1]!) {
        best[j + 1] = cost
        from[j + 1] = i
      }
    }
  }

  const pieces: Array<[number, number]> = []
  for (let k = n; k > 0; k = from[k]!) pieces.unshift([from[k]!, k - 1])

  const drafts: SegmentDraft[] = []
  pieces.forEach(([i, j], idx) => {
    const group = tokens.slice(i, j + 1)
    const text = clean(group.map(t => t.text).join(''))
    if (!hasContent(text)) return
    const spoken = group.filter(t => hasContent(t.text))
    const timed = spoken.length ? spoken : group
    const start = Math.min(...timed.map(t => t.start))
    let end = Math.max(...timed.map(t => t.end))
    if (end - start < MIN_LINE_SECONDS) {
      // Collapsed word timestamps (a loop often collapses onto the segment's end, so the segment end
      // says nothing): keep the line up for a second, at most until the next piece or segment. When
      // that one starts at the same instant, resolveOverlaps shows the lines one after the other.
      const nextPiece = pieces[idx + 1]
      const next = nextPiece ? tokens[nextPiece[0]]!.start : nextStart
      const limit = next !== null && next > start ? next : start + COLLAPSED_LINE_SECONDS
      end = Math.max(end, Math.min(start + COLLAPSED_LINE_SECONDS, limit))
    }
    drafts.push({ start: round3(start), end: round3(end), text })
  })
  return drafts
}

/**
 * Sorts by time and trims/shifts so no two segments overlap. A segment that starts together with
 * the one before is moved after it and keeps up to a second of its own length, so it never ends up
 * with no time on screen (and so is never left out of a Clip's subtitles).
 */
function resolveOverlaps(drafts: SegmentDraft[]): SegmentDraft[] {
  const sorted = drafts.map(d => ({ ...d })).sort((a, b) => a.start - b.start || a.end - b.end)
  for (let k = 1; k < sorted.length; k++) {
    const prev = sorted[k - 1]!
    const cur = sorted[k]!
    if (cur.start >= prev.end) continue
    if (cur.start > prev.start) {
      prev.end = cur.start
    }
    else {
      const length = cur.end - cur.start
      cur.start = prev.end
      cur.end = round3(Math.max(cur.end, cur.start + Math.min(COLLAPSED_LINE_SECONDS, length)))
    }
  }
  return sorted
}
