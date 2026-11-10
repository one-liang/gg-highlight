// Raw ASR output → the same shape with known hallucinations removed (design.md「逐字稿清理」).
// The batched GPU pipeline has no anti-hallucination options, and decoding penalties eat real
// repetition (過來過來, go go go), so this runs afterwards, before buildTranscriptSegments:
//   1. stock phrases that are never spoken here (subtitle credits, channel plugs) are cut out
//      (a known phrase exactly; a core with the few words of its clause around it)
//   2. segments that look like silence (noSpeechProb / avgLogprob) are dropped
//   3. runaway repetition (快 × 78) is shortened to a few copies
//   4. removed characters take their word timestamps with them; empty segments are dropped
//   5. repeated identical segments are dropped
// Pure: the input is not mutated, and cleaning a cleaned transcript changes nothing.
import type { RawSegment, RawTranscript, RawWord } from '../transcription/protocol'
import { hasContent, isSpace, isTight } from './text'

export interface CleanupReport {
  /** Stock-phrase hallucinations removed: each removed stretch of text, or a whole low-confidence segment. */
  stockPhrases: number
  /** Segments dropped as silence (noSpeechProb and avgLogprob both say no speech). */
  silenceDropped: number
  /** Runs of a repeated character, word or phrase that were shortened. */
  repeatsCollapsed: number
  /** Letters and digits removed by shortening repeats. */
  charsRemoved: number
  /** Segments dropped because they repeat the segment before. */
  duplicatesDropped: number
  /** Segments dropped for any reason. */
  segmentsDropped: number
  /** Input segments whose compressionRatio is above faster-whisper's loop threshold (counted, not acted on). */
  highCompression: number
}

// ---------- thresholds (design.md「逐字稿清理」) ----------

/** Copies kept of a repeated unit, of a two-unit phrase (and a three-word one), and of anything longer. */
const MAX_COPIES_SINGLE = 4
const MAX_COPIES_SHORT = 3
const MAX_COPIES_LONG = 2
/** Longest repeated phrase looked for, in CJK characters / latin words. */
const MAX_PERIOD_CHARS = 15
const MAX_PERIOD_WORDS = 8
/** A latin "word" longer than this has no spaces to split on (4QA4QA4QA…): compare it char by char. */
const LONG_WORD_CHARS = 20
/** A silence this long between two copies ends a run: spaced-out repetition is real speech. */
const RUN_BREAK_SECONDS = 1.5
/** faster-whisper's no-speech rule: both must hold for a segment to count as silence. */
const SILENCE_NO_SPEECH_PROB = 0.6
const SILENCE_AVG_LOGPROB = -1.0
/** A phrase that might really be said is a hallucination only when its segment has low confidence. */
const LOW_WORD_PROBABILITY = 0.5
const LOW_CONFIDENCE_NO_SPEECH_PROB = 0.6
const LOW_CONFIDENCE_AVG_LOGPROB = -1.0
/** Identical consecutive segments: at most this many in a row when each follows within the gap. */
const MAX_SAME_SEGMENTS = 2
const SAME_SEGMENT_GAP_SECONDS = 2
/** Two identical segments overlap when one starts this much before the other ends, or both start together. */
const OVERLAP_TOLERANCE_SECONDS = 0.05
/** faster-whisper's compression_ratio_threshold (a decode above it is usually a loop). */
const HIGH_COMPRESSION_RATIO = 2.4
/** A pause this long ends a clause when cutting a stock phrase out of running text. */
const CLAUSE_PAUSE_SECONDS = 0.4
/** Punctuation that ends a clause (colons bind a credit to its name, so they do not). */
const CLAUSE_PUNCT = /[。！？!?.．｡，、；,;…⋯—]/u
/**
 * How far a stock-phrase core takes its clause with it on each side: 6 CJK characters or 3 latin
 * words (a word counts 2). Whisper often writes no punctuation, so a clause can be a whole segment.
 */
const MAX_CLAUSE_SPREAD = 6

// Phrases are compared after normalize(): NFKC, lower case, letters and digits only.
/** Stock phrases Whisper writes over silence or music: removed wherever they appear. */
const STOCK_PHRASES = [
  '請不吝點贊訂閱轉發打賞支持明鏡與點點欄目', '請不吝點讚訂閱轉發打賞支持明鏡與點點欄目', '请不吝点赞订阅转发打赏支持明镜与点点栏目',
  '字幕由amaraorg社區提供', '字幕由amaraorg社区提供', '小編字幕由amaraorg社區提供', '小编字幕由amaraorg社区提供',
  '優優獨播劇場yoyotelevisionseriesexclusive', '优优独播剧场yoyotelevisionseriesexclusive',
  'subtitlesbytheamaraorgcommunity', 'transcribedbyhttpsotterai',
]
/** Cores of stock phrases nobody says in a stream: removed together with the clause around them (up to MAX_CLAUSE_SPREAD). */
const STOCK_PHRASE_CORES = [
  '明鏡與點點', '明镜与点点', '請不吝點贊', '請不吝點讚', '请不吝点赞', '點贊訂閱轉發打賞', '點讚訂閱轉發打賞', '点赞订阅转发打赏',
  '字幕志願者', '字幕志愿者', '優優獨播劇場', '优优独播剧场', 'yoyotelevisionseries', 'amaraorg',
]
/** Cores of a credit followed by a name (「字幕志願者 楊茜茜」): the name is part of the hallucination. */
const NAMED_CREDIT_CORES = new Set(['字幕志願者', '字幕志愿者'])
/** Longest name taken after a named credit's Whisper space, in units (a longer run is real speech). */
const MAX_CREDIT_NAME = 4
/** Phrases someone might really say: removed only when they are a whole low-confidence segment. */
const LOW_CONFIDENCE_PHRASES = new Set([
  '謝謝觀看', '谢谢观看', '感謝觀看', '感谢观看', '謝謝收看', '谢谢收看', '謝謝大家觀看', '谢谢大家观看',
  'thankyouforwatching', 'thanksforwatching', 'thankyou', 'pleasesubscribe', 'subscribe', 'bye', 'you',
])

// ---------- entry points ----------

/** Removes ASR hallucinations from a raw transcript. Returns a new transcript and what was removed. */
export function cleanRawTranscript(raw: RawTranscript): { raw: RawTranscript, report: CleanupReport } {
  const report = emptyReport()
  const segments: RawSegment[] = []
  const repeats = new RepeatTracker()
  for (const seg of raw?.segments ?? []) {
    if (!seg) continue
    if ((seg.compressionRatio ?? 0) > HIGH_COMPRESSION_RATIO) report.highCompression++
    let cleaned = cleanSegment(seg, report)
    const hasText = !!cleaned && normalize(cleaned.text) !== ''
    if (cleaned && hasText && repeats.isRepeat(cleaned)) {
      report.duplicatesDropped++
      cleaned = null
    }
    if (!cleaned) {
      report.segmentsDropped++
      continue
    }
    segments.push(cleaned)
    if (hasText) repeats.kept(cleaned)
  }
  return { raw: { ...raw, segments }, report }
}

/** One analysis-log line summing up the cleanup, or null when nothing was removed. */
export function formatCleanupReport(report: CleanupReport): string | null {
  const changes: string[] = []
  if (report.repeatsCollapsed) changes.push(`縮短連續重複 ${report.repeatsCollapsed} 處（刪掉 ${report.charsRemoved} 字）`)
  if (report.stockPhrases) changes.push(`刪掉幻覺句 ${report.stockPhrases} 處`)
  if (report.silenceDropped) changes.push(`刪掉靜音段落 ${report.silenceDropped} 段`)
  if (report.duplicatesDropped) changes.push(`刪掉重複段落 ${report.duplicatesDropped} 段`)
  if (!changes.length) return null // every removal is counted by one of the rules above
  let line = `逐字稿清理：${changes.join('、')}`
  if (report.segmentsDropped) line += `，共刪掉 ${report.segmentsDropped} 段`
  if (report.highCompression) line += `；${report.highCompression} 段壓縮比偏高`
  return line
}

function emptyReport(): CleanupReport {
  return { stockPhrases: 0, silenceDropped: 0, repeatsCollapsed: 0, charsRemoved: 0, duplicatesDropped: 0, segmentsDropped: 0, highCompression: 0 }
}

// ---------- whole segments ----------

/** The segment with its hallucinated text removed, or null when nothing real is left. */
function cleanSegment(seg: RawSegment, report: CleanupReport): RawSegment | null {
  if (isSilence(seg)) {
    report.silenceDropped++
    return null
  }
  const edited = removeHallucinatedTextFully(seg, report)
  if (edited && LOW_CONFIDENCE_PHRASES.has(normalize(edited.text)) && isLowConfidence(edited)) {
    report.stockPhrases++
    return null
  }
  return edited
}

function isSilence(seg: RawSegment): boolean {
  return seg.noSpeechProb !== undefined && seg.avgLogprob !== undefined
    && seg.noSpeechProb > SILENCE_NO_SPEECH_PROB && seg.avgLogprob < SILENCE_AVG_LOGPROB
}

/** Any available confidence measure is low (a missing one does not count). */
function isLowConfidence(seg: RawSegment): boolean {
  const probabilities = (seg.words ?? [])
    .filter(w => hasContent(wordText(w)) && Number.isFinite(w.probability))
    .map(w => w.probability)
  const mean = probabilities.length ? probabilities.reduce((a, b) => a + b, 0) / probabilities.length : undefined
  return (mean !== undefined && mean < LOW_WORD_PROBABILITY)
    || (seg.noSpeechProb ?? 0) >= LOW_CONFIDENCE_NO_SPEECH_PROB
    || (seg.avgLogprob ?? 0) <= LOW_CONFIDENCE_AVG_LOGPROB
}

/**
 * The duplicate rule: a segment with the same text as the last kept one that overlaps it, or the
 * third or later of a run of identical segments each starting within SAME_SEGMENT_GAP_SECONDS of
 * the one before. The run counts the original neighbours, dropped ones included, so a long run of
 * identical segments keeps its first two, not every other one.
 */
class RepeatTracker {
  private lastKept: RawSegment | null = null
  private last: { text: string, end: number } | null = null
  private run = 0

  /** Call for every segment with text, in order; true = drop it. */
  isRepeat(seg: RawSegment): boolean {
    const text = normalize(seg.text)
    const continues = !!this.last && this.last.text === text && seg.start - this.last.end <= SAME_SEGMENT_GAP_SECONDS
    this.run = continues ? this.run + 1 : 1
    this.last = { text, end: seg.end }
    const prev = this.lastKept
    const overlapsKept = !!prev && normalize(prev.text) === text && overlaps(prev, seg)
    return overlapsKept || this.run > MAX_SAME_SEGMENTS
  }

  kept(seg: RawSegment): void {
    this.lastKept = seg
  }
}

/** `seg` starts before `prev` ends, or both start together (zero-length segments at one instant too). */
function overlaps(prev: RawSegment, seg: RawSegment): boolean {
  return seg.start < prev.end - OVERLAP_TOLERANCE_SECONDS || Math.abs(seg.start - prev.start) <= OVERLAP_TOLERANCE_SECONDS
}

// ---------- text inside a segment ----------

type UnitKind = 'char' | 'word'

/** One character of the segment's text and the word it belongs to. */
interface Char {
  ch: string
  word: number
}

/**
 * What repetition is counted in: one CJK character or one latin word. `content` holds its
 * letters; `chars` also holds the separators (spaces, punctuation) after it, which go with it.
 */
interface Unit {
  key: string
  kind: UnitKind
  content: number[]
  chars: number[]
}

interface TextStream {
  /** False when the segment has no word timestamps: its text is then one word over the whole segment. */
  timed: boolean
  words: RawWord[]
  chars: Char[]
  units: Unit[]
}

type TimeOf = (unit: Unit) => readonly [start: number, end: number]

/**
 * Repeats the in-segment rules until they change nothing: a shortened run can reveal a longer
 * repeated phrase (快快快快快走 × 3 → 快快快快走 × 3 → × 2). This is what makes cleanup idempotent.
 */
function removeHallucinatedTextFully(seg: RawSegment, report: CleanupReport): RawSegment | null {
  let current = seg
  for (;;) {
    const next = removeHallucinatedText(current, report)
    if (next === current || !next) return next
    current = next
  }
}

/** Runs the in-segment rules once (stock phrases, then repeats) and applies the removals. */
function removeHallucinatedText(seg: RawSegment, report: CleanupReport): RawSegment | null {
  const stream = textStream(seg)
  if (!stream.units.length) return seg
  const timeOf: TimeOf = unit => [
    stream.words[stream.chars[unit.content[0]!]!.word]!.start,
    stream.words[stream.chars[unit.content.at(-1)!]!.word]!.end,
  ]

  const drop = stockPhraseUnits(stream, timeOf)
  report.stockPhrases += countStretches(drop)

  const remaining = stream.units.map((_, k) => k).filter(k => !drop.has(k))
  const repeats = repeatedUnits(remaining.map(k => stream.units[k]!), timeOf)
  report.repeatsCollapsed += repeats.runs
  for (const r of repeats.drop) {
    const k = remaining[r]!
    drop.add(k)
    report.charsRemoved += stream.units[k]!.content.filter(i => hasContent(stream.chars[i]!.ch)).length
  }
  return drop.size ? withoutUnits(seg, stream, drop) : seg
}

function textStream(seg: RawSegment): TextStream {
  const timed = (seg.words ?? []).some(w => hasContent(wordText(w)))
  const words = timed ? seg.words : [{ word: seg.text ?? '', start: seg.start, end: seg.end, probability: 1 }]
  const chars: Char[] = []
  words.forEach((w, word) => {
    for (const ch of wordText(w)) chars.push({ ch, word })
  })
  return { timed, words, chars, units: toUnits(chars) }
}

function toUnits(chars: Char[]): Unit[] {
  const units: Unit[] = []
  const unit = (content: number[], kind: UnitKind): Unit =>
    ({ key: normalizeKey(content.map(i => chars[i]!.ch).join('')), kind, content, chars: [...content] })
  let k = 0
  while (k < chars.length) {
    const ch = chars[k]!.ch
    if (isTight(ch) && hasContent(ch)) {
      units.push(unit([k], 'char'))
      k++
    }
    else if (isLatin(ch)) {
      const start = k
      while (k < chars.length && (isLatin(chars[k]!.ch) || isApostrophe(chars[k]!.ch))) k++
      const content = Array.from({ length: k - start }, (_, j) => start + j)
      if (content.length > LONG_WORD_CHARS) units.push(...content.map(i => unit([i], 'char')))
      else units.push(unit(content, 'word'))
    }
    else {
      units.at(-1)?.chars.push(k) // a separator goes with the unit before it
      k++
    }
  }
  return units
}

// ---------- rule: stock phrases ----------

/**
 * Units of the stock phrases in the text. An exact STOCK_PHRASES match removes only itself. A core
 * found outside an exact match also removes the rest of its clause, at most MAX_CLAUSE_SPREAD on
 * each side, so a credit glued to real speech (Whisper writes no punctuation and contiguous word
 * times) does not take the speech with it. A named credit's clause also takes the name Whisper
 * writes after a space (at most MAX_CREDIT_NAME units, ending its own clause). Matches must start
 * and end on unit boundaries, so the latin core "amaraorg" matches "Amara.org" but not "Tamara organized".
 */
function stockPhraseUnits({ units, chars }: TextStream, timeOf: TimeOf): Set<number> {
  const keys = units.map(u => lettersOnly(u.key))
  const joined = keys.join('')
  const unitAt = keys.flatMap((key, u) => Array.from({ length: key.length }, () => u))
  const wholeUnits = (from: number, to: number) =>
    (from === 0 || unitAt[from - 1] !== unitAt[from]) && (to === joined.length - 1 || unitAt[to + 1] !== unitAt[to])
  const drop = new Set<number>()
  const add = (from: number, to: number) => {
    for (let u = from; u <= to; u++) drop.add(u)
  }
  const pauseAfter = (u: number) => timeOf(units[u + 1]!)[0] - timeOf(units[u]!)[1] >= CLAUSE_PAUSE_SECONDS
  const tightSpaceAfter = (u: number) => isTightUnit(units[u]!, chars) && isTightUnit(units[u + 1]!, chars)
    && units[u]!.chars.some(c => isSpace(chars[c]!.ch))
  const endsClause = (u: number) =>
    u >= units.length - 1 || units[u]!.chars.some(c => CLAUSE_PUNCT.test(chars[c]!.ch)) || tightSpaceAfter(u) || pauseAfter(u)
  const spreadCost = (u: number) => (units[u]!.kind === 'word' ? 2 : 1)

  const exact: Array<[number, number]> = []
  for (const phrase of STOCK_PHRASES) {
    for (const [from, to] of findAll(joined, phrase, wholeUnits)) {
      exact.push([from, to])
      add(unitAt[from]!, unitAt[to]!)
    }
  }
  for (const core of STOCK_PHRASE_CORES) {
    for (const [from, to] of findAll(joined, core, wholeUnits)) {
      if (exact.some(([a, b]) => a <= from && to <= b)) continue
      let a = unitAt[from]!
      let b = unitAt[to]!
      for (let budget = MAX_CLAUSE_SPREAD; a > 0 && !endsClause(a - 1) && spreadCost(a - 1) <= budget; a--) budget -= spreadCost(a - 1)
      for (let budget = MAX_CLAUSE_SPREAD; !endsClause(b) && spreadCost(b + 1) <= budget; b++) budget -= spreadCost(b + 1)
      if (NAMED_CREDIT_CORES.has(core) && b === unitAt[to]! && b < units.length - 1 && tightSpaceAfter(b) && !pauseAfter(b)) {
        // Whisper writes the name after a space: a short run that then ends its clause is the name.
        let c = b + 1
        while (c - b < MAX_CREDIT_NAME && !endsClause(c)) c++
        if (endsClause(c)) b = c
      }
      add(a, b)
    }
  }
  return drop
}

/** A CJK character unit (not a letter of a long latin run split into characters). */
function isTightUnit(unit: Unit, chars: Char[]): boolean {
  return unit.kind === 'char' && isTight(chars[unit.content[0]!]!.ch)
}

/** [first, last] index of every non-overlapping occurrence of `needle` that `accept` agrees to. */
function findAll(haystack: string, needle: string, accept: (from: number, to: number) => boolean): Array<[number, number]> {
  const found: Array<[number, number]> = []
  for (let at = haystack.indexOf(needle); at >= 0;) {
    const to = at + needle.length - 1
    if (accept(at, to)) {
      found.push([at, to])
      at = haystack.indexOf(needle, to + 1)
    }
    else {
      at = haystack.indexOf(needle, at + 1)
    }
  }
  return found
}

/** Number of stretches of consecutive indices. */
function countStretches(indices: Set<number>): number {
  let count = 0
  for (const k of indices) if (!indices.has(k - 1)) count++
  return count
}

// ---------- rule: runaway repetition ----------

interface ExcessRun {
  /** Units [dropFrom, end) are removed; the copies before dropFrom stay. */
  dropFrom: number
  end: number
}

/** Unit indices to remove so no run has more copies than allowed, and how many runs were shortened. */
function repeatedUnits(units: Unit[], timeOf: TimeOf): { drop: Set<number>, runs: number } {
  const drop = new Set<number>()
  let runs = 0
  let i = 0
  while (i < units.length) {
    const run = excessRunAt(units, i, timeOf)
    if (!run) {
      i++
      continue
    }
    runs++
    for (let u = run.dropFrom; u < run.end; u++) drop.add(u)
    i = run.end
  }
  return { drop, runs }
}

/** The shortest phrase starting at unit i that repeats more often than allowed, if any. */
function excessRunAt(units: Unit[], i: number, timeOf: TimeOf): ExcessRun | null {
  for (let period = 1; period <= MAX_PERIOD_CHARS && i + 2 * period <= units.length; period++) {
    const kind: UnitKind = units.slice(i, i + period).every(u => u.kind === 'char') ? 'char' : 'word'
    if (kind === 'word' && period > MAX_PERIOD_WORDS) continue
    const copies = countCopies(units, i, period, timeOf)
    const keep = maxCopies(period, kind)
    if (copies <= keep) continue
    return { dropFrom: i + keep * period, end: withTrailingPartial(units, i, period, i + copies * period) }
  }
  return null
}

/** Copies kept of a repeated phrase `period` units long (單字 4 次、兩個字 3 次、更長 2 次; 英文 2–3 個字 3 次). */
function maxCopies(period: number, kind: UnitKind): number {
  if (period === 1) return MAX_COPIES_SINGLE
  if (period === 2 || (kind === 'word' && period === 3)) return MAX_COPIES_SHORT
  return MAX_COPIES_LONG
}

/** How many times units[i, i + period) repeats back to back, a long pause ending the run. */
function countCopies(units: Unit[], i: number, period: number, timeOf: TimeOf): number {
  let copies = 1
  for (;;) {
    const next = i + copies * period
    if (next + period > units.length || !sameUnits(units, i, next, period)) break
    if (timeOf(units[next]!)[0] - timeOf(units[next - 1]!)[1] >= RUN_BREAK_SECONDS) break
    copies++
  }
  return copies
}

/** A partial copy that ends the segment is loop residue cut off by the decoder (4QA4QA4Q): it goes too. */
function withTrailingPartial(units: Unit[], i: number, period: number, end: number): number {
  let m = 0
  while (m < period - 1 && end + m < units.length && units[i + m]!.key === units[end + m]!.key) m++
  return m > 0 && end + m === units.length ? units.length : end
}

function sameUnits(units: Unit[], a: number, b: number, length: number): boolean {
  for (let q = 0; q < length; q++) {
    if (units[a + q]!.key !== units[b + q]!.key) return false
  }
  return true
}

// ---------- applying removals ----------

/** The segment without the given units; their characters and word timestamps are removed with them. */
function withoutUnits(seg: RawSegment, stream: TextStream, drop: Set<number>): RawSegment | null {
  const removed = new Set<number>()
  for (const u of drop) for (const c of stream.units[u]!.chars) removed.add(c)
  const words = keptWords(stream, removed)
  const text = words.map(w => w.word).join('').trim()
  if (!hasContent(text)) return null
  if (!stream.timed) return { ...seg, text }
  return { ...seg, ...trimmedBounds(seg, stream.words, words), text, words }
}

function keptWords({ words, chars }: TextStream, removed: Set<number>): RawWord[] {
  const charsOf = words.map((): number[] => [])
  chars.forEach((c, i) => charsOf[c.word]!.push(i))
  const out: RawWord[] = []
  words.forEach((word, w) => {
    const all = charsOf[w]!
    const left = all.filter(i => !removed.has(i))
    // A word left with only its leading space keeps it: the space now separates the kept text around it.
    if (left.length === all.length) out.push(word)
    else if (left.length) out.push(narrowWord(word, all, left, chars))
  })
  return out
}

/** A word that lost some characters keeps the time share of the letters left (哈哈哈 → 哈: the first third). */
function narrowWord(word: RawWord, all: number[], left: number[], chars: Char[]): RawWord {
  const text = left.map(i => chars[i]!.ch).join('')
  const kept = new Set(left)
  const letters = all.filter(i => hasContent(chars[i]!.ch))
  const first = letters.findIndex(i => kept.has(i))
  if (first < 0) return { ...word, word: text, end: word.start } // only a space or punctuation left
  const last = letters.findLastIndex(i => kept.has(i))
  const share = (word.end - word.start) / letters.length
  return {
    ...word,
    word: text,
    start: first === 0 ? word.start : round3(word.start + share * first),
    end: last === letters.length - 1 ? word.end : round3(word.start + share * (last + 1)),
  }
}

/**
 * The segment loses the time its removed leading/trailing words took. Words with collapsed
 * timestamps take no time, so a segment that ended in a collapsed loop keeps its end.
 */
function trimmedBounds(seg: RawSegment, before: RawWord[], after: RawWord[]): { start: number, end: number } {
  const [oldFirst, oldLast] = spokenSpan(before)
  const [newFirst, newLast] = spokenSpan(after)
  const headCut = newFirst - oldFirst
  const tailCut = oldLast - newLast
  return {
    start: headCut > 0 ? Math.min(newFirst, round3(seg.start + headCut)) : seg.start,
    end: tailCut > 0 ? Math.max(newLast, round3(seg.end - tailCut)) : seg.end,
  }
}

function spokenSpan(words: RawWord[]): [number, number] {
  const spoken = words.filter(w => hasContent(wordText(w)))
  return [Math.min(...spoken.map(w => w.start)), Math.max(...spoken.map(w => w.end))]
}

// ---------- small helpers ----------

function wordText(word: RawWord): string {
  return typeof word?.word === 'string' ? word.word : ''
}

/** A letter or digit of a script written with spaces between words. */
function isLatin(ch: string): boolean {
  return hasContent(ch) && !isTight(ch)
}

function isApostrophe(ch: string): boolean {
  return ch === '\'' || ch === '’'
}

function normalizeKey(text: string): string {
  return text.normalize('NFKC').toLowerCase()
}

function lettersOnly(text: string): string {
  return text.replace(/[^\p{L}\p{N}]/gu, '')
}

/** Text as compared by the phrase and duplicate rules: NFKC, lower case, letters and digits only. */
function normalize(text: string | undefined): string {
  return lettersOnly(normalizeKey(text ?? ''))
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}
