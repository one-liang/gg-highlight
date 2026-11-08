// Character classes, OpenCC conversion and per-language text cleanup.
import { Converter } from 'opencc-js'

type ConvertFn = (text: string) => string

let converter: ConvertFn | null = null

/**
 * Simplified → Taiwan Traditional with Taiwan phrases (OpenCC cn → twp). OpenCC writes the formal
 * 臺 (台灣 → 臺灣, 舞台 → 舞臺); subtitles use the everyday 台, as Taiwanese text does.
 */
export function toTaiwanTraditional(text: string): string {
  if (!text) return text
  converter ??= Converter({ from: 'cn', to: 'twp' })
  return converter(text).replace(/臺/gu, '台')
}

// Ideographs (incl. radicals, extensions, compatibility), kana, bopomofo, hangul,
// CJK symbols/punctuation (U+3000–U+303F), enclosed/compat CJK, vertical forms and
// full-width forms (U+FF00–U+FFEF). Sorted; checked by code point because textUnits is hot.
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x11FF], [0x2E80, 0x2FDF], [0x3000, 0x33FF], [0x3400, 0x4DBF], [0x4E00, 0x9FFF],
  [0xA960, 0xA97F], [0xAC00, 0xD7FF], [0xF900, 0xFAFF], [0xFE30, 0xFE4F], [0xFF00, 0xFFEF],
  [0x20000, 0x3FFFF],
]

function isWideCode(cp: number): boolean {
  if (cp < 0x1100) return false
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp < lo) return false
    if (cp <= hi) return true
  }
  return false
}

// Scripts written without spaces between characters (hangul is left out: Korean uses spaces).
const TIGHT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3001-\u303F\u3100-\u312F\uFE30-\uFE4F\uFF01-\uFFEF]/u

const CONTENT_RE = /[\p{L}\p{N}]/u

/** True for a single character that takes a full (CJK) cell. */
export function isWide(ch: string | undefined): boolean {
  return !!ch && isWideCode(ch.codePointAt(0)!)
}

/** True for a character of a script that is written without spaces (Han, kana, CJK punctuation). */
export function isTight(ch: string | undefined): boolean {
  return !!ch && TIGHT_RE.test(ch)
}

export function isSpace(ch: string | undefined): boolean {
  return !!ch && /\s/u.test(ch)
}

/** True when the text has at least one letter or digit. */
export function hasContent(text: string): boolean {
  return CONTENT_RE.test(text)
}

/** Display width of text in units: CJK/full-width = 1, everything else = 0.5. */
export function textUnits(text: string): number {
  let units = 0
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!
    if (cp > 0xFFFF) i++
    units += isWideCode(cp) ? 1 : 0.5
  }
  return units
}

// Advance widths of ASCII U+0020–U+007E in the bold subtitle font (Noto Sans CJK TC Bold), in 1/1000 em.
const ASCII_ADVANCE = [
  227, 370, 574, 590, 590, 963, 740, 325, 378, 378, 507, 590, 325, 370, 325, 387,
  590, 590, 590, 590, 590, 590, 590, 590, 590, 590, 325, 325, 590, 590, 590, 514,
  1007, 641, 681, 656, 714, 615, 585, 717, 757, 330, 568, 686, 578, 853, 749, 770,
  667, 770, 682, 624, 625, 748, 619, 915, 627, 580, 613, 378, 387, 378, 590, 567,
  626, 591, 644, 527, 644, 581, 372, 597, 640, 304, 306, 604, 315, 964, 641, 626,
  644, 644, 436, 495, 421, 637, 576, 863, 562, 574, 511, 378, 296, 378, 590,
]

/**
 * Rendered width of text in em of the subtitle font: CJK / full-width characters 1, ASCII by the
 * font's own advance widths, anything else 1 (the CJK font draws curly quotes, … and · full width).
 * Unlike textUnits (which segmentation and wrapping count in) this is close to what libass draws.
 */
export function textEm(text: string): number {
  let milli = 0
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!
    if (cp > 0xFFFF) i++
    milli += cp >= 0x20 && cp <= 0x7E ? ASCII_ADVANCE[cp - 0x20]! : 1000
  }
  return milli / 1000
}

/** The code point that ends right before `offset` (UTF-16 index). */
function charBefore(s: string, offset: number): string | undefined {
  if (offset <= 0) return undefined
  const code = s.charCodeAt(offset - 1)
  if (code >= 0xDC00 && code <= 0xDFFF && offset >= 2) return s.slice(offset - 2, offset)
  return s[offset - 1]
}

/** The code point that starts at `offset` (UTF-16 index). */
function charAt(s: string, offset: number): string | undefined {
  const code = s.codePointAt(offset)
  return code === undefined ? undefined : String.fromCodePoint(code)
}

/** Removes whitespace runs that sit between two tight-script characters (Whisper inserts them). */
export function dropTightSpaces(text: string): string {
  return text.replace(/\s+/gu, (run, offset: number, whole: string) =>
    isTight(charBefore(whole, offset)) && isTight(charAt(whole, offset + run.length)) ? '' : run)
}

function isAsciiAlnum(ch: string | undefined): boolean {
  return !!ch && /^[A-Za-z0-9]$/.test(ch)
}

// Removed at the end of a zh subtitle line (？！?! and closing quotes/brackets stay).
const ZH_TRAILING_RE = /[\s，。、；：．,.;:…⋯～~—–-]+$/u

/**
 * Taiwanese subtitle style for zh text that is already in Traditional characters:
 * no spaces between CJK characters, ，。、；：,.;: become one space, no trailing
 * punctuation except ？！?!, collapsed whitespace.
 */
export function cleanZhText(text: string): string {
  let s = dropTightSpaces(text)
  s = s.replace(/[，。、；：．]/gu, ' ')
  // Keep ASCII separators inside numbers and identifiers (3.5, 1,000, 10:30, Node.js).
  s = s.replace(/[,.;:]/g, (m: string, offset: number, whole: string) =>
    isAsciiAlnum(whole[offset - 1]) && isAsciiAlnum(whole[offset + 1]) ? m : ' ')
  s = s.replace(/\s+/gu, ' ').trim()
  return s.replace(ZH_TRAILING_RE, '')
}

/** English: trim and collapse whitespace, punctuation stays. */
export function cleanEnText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}
