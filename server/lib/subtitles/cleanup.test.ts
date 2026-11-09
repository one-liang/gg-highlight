import { describe, expect, it } from 'vitest'
import type { Language } from '../../../shared/types/domain'
import type { RawSegment, RawTranscript, RawWord } from '../transcription/protocol'
import { rawTranscriptSchema } from '../transcription/schema'
import { cleanRawTranscript, type CleanupReport, formatCleanupReport } from './cleanup'
import { cuesForRange } from './cues'
import { buildTranscriptSegments } from './segments'
import { hasContent } from './text'

function raw(segments: RawSegment[], language: Language = 'zh'): RawTranscript {
  return { language, durationSec: 900, model: 'test', device: 'cpu', segments }
}

/** zh: one word per token (default: per character), evenly timed. */
function zw(tokens: string | string[], start: number, step = 0.2, probability = 0.9): RawWord[] {
  return (typeof tokens === 'string' ? Array.from(tokens) : tokens).map((word, i) => ({
    word, start: +(start + i * step).toFixed(3), end: +(start + (i + 1) * step).toFixed(3), probability,
  }))
}

/** en: Whisper words with their leading spaces. */
function ew(text: string, start: number, step = 0.3, probability = 0.9): RawWord[] {
  return (text.match(/\s*\S+/g) ?? []).map((word, i) => ({
    word, start: +(start + i * step).toFixed(3), end: +(start + (i + 1) * step).toFixed(3), probability,
  }))
}

/** Words whose timestamps all collapsed onto one instant (DTW ran out of audio frames). */
function collapsed(text: string, at: number): RawWord[] {
  return Array.from(text).map(word => ({ word, start: at, end: at, probability: 0.3 }))
}

function seg(words: RawWord[], extra: Partial<RawSegment> = {}): RawSegment {
  return { start: words[0]!.start, end: words.at(-1)!.end, text: words.map(w => w.word).join('').trim(), words, ...extra }
}

function clean(segments: RawSegment[], language: Language = 'zh') {
  return cleanRawTranscript(raw(segments, language))
}

const texts = (segments: RawSegment[], language: Language = 'zh') => clean(segments, language).raw.segments.map(s => s.text)

type Case = [name: string, input: RawSegment[], expected: string[], language?: Language]

const s1 = seg(zw('學習率決定步長', 0))

const loopCases: Case[] = [
  ['22×快 → 4', [seg(zw('快'.repeat(22), 10))], ['快快快快']],
  ['好快快快過來×4 → 過來×3', [seg(zw(['好', '快', '快', '快', '過來', '過來', '過來', '過來'], 10))], ['好快快快過來過來過來']],
  ['過來×20 (one token per 過來) → ×3', [seg(zw(['好', ...Array<string>(20).fill('過來')], 10))], ['好過來過來過來']],
  ['哈哈哈 tokens ×3 (9 chars) → 4 chars, 2nd token trimmed', [seg(zw(['哈哈哈', '哈哈哈', '哈哈哈'], 10, 0.6))], ['哈哈哈哈']],
  ['快快過來 ×5 → ×2', [seg(zw('快快過來'.repeat(5), 10))], ['快快過來快快過來']],
  ['怎麼辦 ×3 → ×2', [seg(zw('怎麼辦怎麼辦怎麼辦', 10))], ['怎麼辦怎麼辦']],
  ['latin loop without spaces 4QA… (zh tokens) → 4QA4QA', [seg(zw(Array<string[]>(40).fill(['4', 'Q', 'A']).flat(), 10, 0.05))], ['4QA4QA']],
  ['a partial copy that ends the segment is dropped', [seg(zw([...Array<string[]>(10).fill(['4', 'Q', 'A']).flat(), '4', 'Q'], 10, 0.05))], ['4QA4QA']],
  ['a partial copy followed by other text is kept', [seg(zw('過來過來過來過來過去', 10))], ['過來過來過來過去']],
  ['en: no ×6 → ×4', [seg(ew(' no no no no no no', 1))], ['no no no no'], 'en'],
  ['en: come here ×6 → ×3', [seg(ew(' come here come here come here come here come here come here', 1))], ['come here come here come here'], 'en'],
  ['en: punctuation does not hide a repeat', [seg(ew(' Let\'s go, go, go, go, go, go!', 1))], ['Let\'s go, go, go, go,'], 'en'],
  ['en: the words after a shortened run keep their space', [seg(ew(' go go go go go go now', 1))], ['go go go go now'], 'en'],
  ['a shortened run can reveal a longer repeated phrase', [seg(zw('快快快快快走'.repeat(3), 10))], ['快快快快走快快快快走']],
  ['a long latin run that shortens to its neighbours\' spelling is shortened with them', [seg(ew(` 4QA4QA 4QA4QA 4QA4QA 4QA4QA ${'4QA'.repeat(10)}`, 1))], ['4QA4QA 4QA4QA 4QA4QA 4QA4QA'], 'en'],
  ['spaced latin loop: the text after it keeps its space', [seg(zw(['4', 'Q', 'A', ...Array<string[]>(8).fill([' 4', ' Q', 'A']).flat(), ' 3', ' Q', 'A'], 10, 0.05))], ['4QA 4 QA 4 QA 4 QA 3 QA']],
]

const legitimateCases: Case[] = [
  ['過來過來', [seg(zw('過來過來', 10))], ['過來過來']],
  ['不要不要', [seg(zw(['不要', '不要'], 10))], ['不要不要']],
  ['哈哈哈', [seg(zw(['哈哈哈'], 10))], ['哈哈哈']],
  ['對對對對', [seg(zw('對對對對', 10))], ['對對對對']],
  ['過來×3', [seg(zw('過來過來過來', 10))], ['過來過來過來']],
  ['好快快快過來過來', [seg(zw('好快快快過來過來', 10))], ['好快快快過來過來']],
  ['en: go go go', [seg(ew(' go go go', 1))], ['go go go'], 'en'],
  ['en: no no no no', [seg(ew(' no no no no', 1))], ['no no no no'], 'en'],
  ['en: come here ×3', [seg(ew(' come here, come here, come here.', 1))], ['come here, come here, come here.'], 'en'],
  ['numbers', [seg(ew(' I got 100000 points and 8888 8888', 1))], ['I got 100000 points and 8888 8888'], 'en'],
  ['spaced-out repetition (1.5 s gaps)', [seg([...zw('快', 10), ...zw('快', 12), ...zw('快', 14), ...zw('快', 16), ...zw('快', 18), ...zw('快', 20)])], ['快快快快快快']],
]

const stockPhraseCases: Case[] = [
  ['明鏡與點點 segment dropped', [seg(zw('今天就到這裡', 1)), seg(zw('請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目', 5, 0.1, 0.8))], ['今天就到這裡']],
  ['Amara credit removed inside a segment', [seg([...zw('今天就到這裡', 1), ...zw(['字幕', '由', 'Am', 'ara', '.', 'org', '社區', '提供'], 3)])], ['今天就到這裡']],
  ['Amara variant: a core match removes only its clause', [seg([...zw('好那我們下次見，', 1), ...zw(['字幕', '提供', '：', 'Am', 'ara', '.', 'org', ' ', '社群'], 3, 0.2)])], ['好那我們下次見，']],
  ['明鏡與點點 inside running speech (no pause or punctuation) removes the clause', [seg(zw('打賞支持明鏡與點點欄目', 5, 0.1))], []],
  ['Simplified credit', [seg(zw('字幕由Amara.org社区提供', 5, 0.1))], []],
  // faster-whisper zh: token pieces, a space carried on the next token, contiguous word times, no punctuation
  ['a credit glued after speech removes only itself', [seg(zw(['我們', '下次', '見', ' 請', '不', '吝', '點', '贊', ' 訂閱', ' 轉', '發', ' 打', '賞', '支持', '明', '鏡', '與', '點', '點', '欄', '目'], 100, 0.25))], ['我們下次見']],
  ['an Amara credit glued after speech removes only itself', [seg(zw(['好', '那', '今天', '先', '到', '這邊', ' 字幕', '由', 'Am', 'ara', '.', 'org', '社', '區', '提供'], 100, 0.25))], ['好那今天先到這邊']],
  ['an Amara credit glued before speech removes only itself', [seg(zw(['字幕', '由', 'Am', 'ara', '.', 'org', '社', '區', '提供', ' 大家', '好', '歡迎', '回來', '今天', '要', '玩', '皮', '克', '公園'], 100, 0.25))], ['大家好歡迎回來今天要玩皮克公園']],
  ['a core stops at a Whisper space between Chinese characters', [seg(zw(['好', '那', '今天', '先', '到', '這邊', ' 請', '不', '吝', '點', '贊', '訂閱'], 100, 0.25))], ['好那今天先到這邊']],
  ['a core takes at most 6 characters on each side of it', [seg(zw('大家好歡迎回來今天要玩皮克公園明鏡與點點我們先過去那邊看看', 100, 0.25))], ['大家好歡迎回來今天邊看看']],
  ['en: a latin core matches whole words only (Tamara organized)', [seg(ew(' My friend Tamara organized the whole raid for us.', 1))], ['My friend Tamara organized the whole raid for us.'], 'en'],
  ['en: Tamara organized it. is kept', [seg(ew(' Tamara organized it. Thank you.', 1))], ['Tamara organized it. Thank you.'], 'en'],
  ['en: Samara organically is kept', [seg(ew(' We flew to Samara organically grown stuff there.', 1))], ['We flew to Samara organically grown stuff there.'], 'en'],
  ['en: a core takes at most 3 words on each side of it', [seg(ew(' I really want to say thanks to the Amara.org team for this video today', 1))], ['I really want to say video today'], 'en'],
  ['謝謝觀看 alone with low probability → dropped', [seg(zw('謝謝觀看', 30, 0.2, 0.3))], []],
  ['謝謝觀看 alone with high probability → kept', [seg(zw('謝謝觀看', 30, 0.2, 0.95))], ['謝謝觀看']],
  ['en: Thank you. with high probability kept', [seg(ew(' Thank you.', 1, 0.3, 0.9))], ['Thank you.'], 'en'],
  ['en: Thank you for watching with low probability dropped', [seg(ew(' Thank you for watching!', 1, 0.3, 0.2))], [], 'en'],
]

const duplicateCases: Case[] = [
  ['3 identical adjacent segments → keep 2', [s1, seg(zw('學習率決定步長', 2)), seg(zw('學習率決定步長', 4)), seg(zw('下面看例題', 6))], ['學習率決定步長', '學習率決定步長', '下面看例題']],
  ['an overlapping identical segment is dropped', [s1, seg(zw('學習率決定步長', 0.5))], ['學習率決定步長']],
  ['2 identical adjacent segments are kept', [seg(zw('快過來', 0)), seg(zw('快過來', 1))], ['快過來', '快過來']],
  ['identical segments far apart are kept', [s1, seg(zw('學習率決定步長', 30)), seg(zw('學習率決定步長', 60))], ['學習率決定步長', '學習率決定步長', '學習率決定步長']],
  ['8 identical 0.5 s segments back to back → keep 2', sameRun(8, 0.5, 0), ['我們走吧', '我們走吧']],
  ['30 identical 1 s segments 0.2 s apart → keep 2', sameRun(30, 1, 0.2), ['我們走吧', '我們走吧']],
  ['20 identical 2 s segments 0.5 s apart (30 s chunks of BGM) → keep 2', sameRun(20, 2, 0.5), ['我們走吧', '我們走吧']],
  ['a run of identical segments ends at other text', [...sameRun(4, 1, 0.2), seg(zw('好', 104.8)), ...sameRun(3, 1, 0.2, 105.2)], ['我們走吧', '我們走吧', '好', '我們走吧', '我們走吧']],
  ['a run of identical segments ends at a gap over 2 s', [...sameRun(4, 1, 0.2), ...sameRun(4, 1, 0.2, 107)], ['我們走吧', '我們走吧', '我們走吧', '我們走吧']],
]

/** `count` segments saying 我們走吧, each `length` s long and `gap` s after the one before. */
function sameRun(count: number, length: number, gap: number, from = 100): RawSegment[] {
  return Array.from({ length: count }, (_, i) => {
    const start = +(from + i * (length + gap)).toFixed(3)
    return seg(zw('我們走吧', start, length / 4))
  })
}

const allCases = [...loopCases, ...legitimateCases, ...stockPhraseCases, ...duplicateCases]

/** The user's report: 78×快 with collapsed timestamps inside one raw segment. */
const userSegment = seg([...zw('我們先過去那邊', 140, 0.25), ...collapsed('快'.repeat(78), 143.2), ...zw('好過來過來', 146, 0.25)])
/** The same loop as three raw segments of 26×快, all at 143.2 (faster-whisper: segment end = last word end). */
const userTriplet = [0, 1, 2].map(() => seg(collapsed('快'.repeat(26), 143.2)))

const NO_CHANGES: CleanupReport = { stockPhrases: 0, silenceDropped: 0, repeatsCollapsed: 0, charsRemoved: 0, duplicatesDropped: 0, segmentsDropped: 0, highCompression: 0 }

function duplicateStarts(drafts: Array<{ start: number }>): number[] {
  const starts = drafts.map(d => d.start)
  return starts.filter((s, k) => starts.indexOf(s) !== k)
}

describe('cleanRawTranscript', () => {
  describe('shortens runaway repetition', () => {
    it.each(loopCases)('%s', (_name, input, expected, language) => {
      expect(texts(input, language)).toEqual(expected)
    })
  })

  describe('leaves legitimate repetition alone', () => {
    it.each(legitimateCases)('%s', (_name, input, expected, language) => {
      expect(texts(input, language)).toEqual(expected)
    })

    it('returns such segments unchanged, with nothing reported', () => {
      for (const [, input, , language] of legitimateCases) {
        const { raw: out, report } = clean(input, language)
        expect(out.segments).toEqual(input)
        expect(report).toEqual(NO_CHANGES)
      }
    })

    it('leaves ordinary English speech alone', () => {
      const input = [
        seg(ew(' Okay, let\'s go, go, go, no, no, no, come here, come here, come here.', 1.58)),
        seg(ew(' Welcome back to the stream, today we are playing something new.', 8)),
      ]
      expect(clean(input, 'en').raw.segments).toEqual(input)
    })
  })

  describe('removes stock phrases', () => {
    it.each(stockPhraseCases)('%s', (_name, input, expected, language) => {
      expect(texts(input, language)).toEqual(expected)
    })

    it('counts each removed stretch once', () => {
      const { report } = clean(stockPhraseCases[0]![1])
      expect(report).toEqual({ ...NO_CHANGES, stockPhrases: 1, segmentsDropped: 1 })
    })

    it('treats a whole stock phrase as low confidence when the segment says so', () => {
      const words = zw('謝謝觀看', 30, 0.2, 0.95)
      expect(texts([seg(words, { noSpeechProb: 0.65, avgLogprob: -0.3 })])).toEqual([])
      expect(texts([seg(words, { noSpeechProb: 0.1, avgLogprob: -1.2 })])).toEqual([])
      expect(texts([seg(words, { noSpeechProb: 0.1, avgLogprob: -0.3 })])).toEqual(['謝謝觀看'])
    })
  })

  describe('drops repeated segments', () => {
    it.each(duplicateCases)('%s', (_name, input, expected, language) => {
      expect(texts(input, language)).toEqual(expected)
    })

    it('treats identical segments that start together as overlapping, even with no duration', () => {
      const a = seg(collapsed('快快快快', 143.2))
      expect(texts([a, seg(collapsed('快快快快', 143.2))])).toEqual(['快快快快'])
    })
  })

  describe('drops silence', () => {
    const words = zw('然後我們就', 5)

    it('drops a segment when noSpeechProb > 0.6 and avgLogprob < -1', () => {
      const { raw: out, report } = clean([seg(words, { noSpeechProb: 0.7, avgLogprob: -1.2 })])
      expect(out.segments).toEqual([])
      expect(report).toEqual({ ...NO_CHANGES, silenceDropped: 1, segmentsDropped: 1 })
    })

    it('keeps it when only one of them says silence, or either is missing', () => {
      expect(texts([seg(words, { noSpeechProb: 0.7, avgLogprob: -0.5 })])).toEqual(['然後我們就'])
      expect(texts([seg(words, { noSpeechProb: 0.3, avgLogprob: -1.5 })])).toEqual(['然後我們就'])
      expect(texts([seg(words, { noSpeechProb: 0.9 })])).toEqual(['然後我們就'])
      expect(texts([seg(words, { avgLogprob: -3 })])).toEqual(['然後我們就'])
    })
  })

  describe('the user\'s case: 快 × 78 at 143.2', () => {
    it('one raw segment: the subtitle lines no longer repeat at the same start', () => {
      const before = buildTranscriptSegments(raw([userSegment]), 'zh')
      expect(before.some(d => /快{5,}/u.test(d.text))).toBe(true) // the bug as reported

      const { raw: cleaned, report } = cleanRawTranscript(raw([userSegment]))
      const after = buildTranscriptSegments(cleaned, 'zh')
      expect(duplicateStarts(after)).toEqual([])
      expect(after.some(d => /快{5,}/u.test(d.text))).toBe(false)
      expect(after).toEqual([
        { start: 140, end: 143.2, text: '我們先過去那邊快快快快' },
        { start: 146, end: 147.25, text: '好過來過來' },
      ])
      expect(report).toEqual({ ...NO_CHANGES, repeatsCollapsed: 1, charsRemoved: 74 })
      expect(formatCleanupReport(report)).toBe('逐字稿清理：縮短連續重複 1 處（刪掉 74 字）')
    })

    it('three raw segments of 26×快: one short line is left', () => {
      const before = buildTranscriptSegments(raw(userTriplet), 'zh')
      expect(before.filter(d => /快{5,}/u.test(d.text))).toHaveLength(3)

      const { raw: cleaned, report } = cleanRawTranscript(raw(userTriplet))
      const after = buildTranscriptSegments(cleaned, 'zh')
      expect(duplicateStarts(after)).toEqual([])
      expect(after).toEqual([{ start: 143.2, end: 144.2, text: '快快快快' }])
      expect(report).toEqual({ ...NO_CHANGES, repeatsCollapsed: 3, charsRemoved: 66, duplicatesDropped: 2, segmentsDropped: 2 })
    })

    it('a loop that collapsed onto the end of a segment after speech still shows, and is exported', () => {
      const input = [seg([...zw('我們先過去那邊', 138, 0.25), ...collapsed('快'.repeat(26), 143.2)])]
      expect(input[0]!.end).toBe(143.2)
      const after = buildTranscriptSegments(clean(input).raw, 'zh')
      expect(after).toEqual([
        { start: 138, end: 139.75, text: '我們先過去那邊' },
        { start: 143.2, end: 144.2, text: '快快快快' },
      ])
      expect(cuesForRange(after, 135, 150).map(c => c.text)).toEqual(['我們先過去那邊', '快快快快'])
    })

    it('two loop segments at 143.2 that differ at the end become two lines one after the other', () => {
      const input = [seg(collapsed('快'.repeat(30), 143.2)), seg(collapsed(`${'快'.repeat(30)}走吧`, 143.2))]
      const after = buildTranscriptSegments(clean(input).raw, 'zh')
      expect(after).toEqual([
        { start: 143.2, end: 144.2, text: '快快快快' },
        { start: 144.2, end: 145.2, text: '快快快快走吧' },
      ])
      expect(duplicateStarts(after)).toEqual([])
      expect(cuesForRange(after, 135, 150).map(c => c.text)).toEqual(['快快快快', '快快快快走吧'])
    })

    it('no Transcript line ends up with no time on screen', () => {
      for (const [, input, , language] of [...allCases, ['user', [userSegment], []] as Case, ['triplet', userTriplet, []] as Case]) {
        for (const segments of [input, clean(input, language).raw.segments]) {
          for (const d of buildTranscriptSegments(raw(segments, language), language ?? 'zh')) expect(d.end).toBeGreaterThan(d.start)
        }
      }
    })
  })

  describe('timestamps', () => {
    it('removed characters take their time with them; kept words keep theirs', () => {
      const [out] = clean([seg(zw('快'.repeat(22), 10))]).raw.segments
      expect(out!.words).toEqual(zw('快快快快', 10))
      expect([out!.start, out!.end]).toEqual([10, 10.8])
    })

    it('a partly removed token keeps the time share of what is left', () => {
      const [out] = clean([seg(zw(['哈哈哈', '哈哈哈', '哈哈哈'], 10, 0.6))]).raw.segments
      expect(out!.words).toEqual([
        { word: '哈哈哈', start: 10, end: 10.6, probability: 0.9 },
        { word: '哈', start: 10.6, end: 10.8, probability: 0.9 },
      ])
      expect([out!.start, out!.end]).toEqual([10, 10.8])
    })

    it('a segment ending in a collapsed loop keeps its end, and its line shows for a second', () => {
      const [out] = clean([seg(collapsed('快'.repeat(26), 143.2))]).raw.segments
      expect([out!.start, out!.end, out!.text]).toEqual([143.2, 143.2, '快快快快'])
      expect(buildTranscriptSegments(raw([out!]), 'zh')).toEqual([{ start: 143.2, end: 144.2, text: '快快快快' }])
      // a later segment cuts the second short
      const next = seg(zw('好', 143.6))
      expect(buildTranscriptSegments(raw([out!, next]), 'zh')[0]).toEqual({ start: 143.2, end: 143.6, text: '快快快快' })
    })

    it('stay ordered within every cleaned segment', () => {
      for (const [, input, , language] of [...allCases, ['user', [userSegment], []] as Case]) {
        for (const s of clean(input, language).raw.segments) {
          const spoken = s.words.filter(w => hasContent(w.word))
          for (const [k, w] of s.words.entries()) {
            expect(w.start).toBeLessThanOrEqual(w.end)
            if (k > 0) expect(w.start).toBeGreaterThanOrEqual(s.words[k - 1]!.start)
          }
          expect(s.start).toBeLessThanOrEqual(Math.min(...spoken.map(w => w.start)))
          expect(s.end).toBeGreaterThanOrEqual(Math.max(...spoken.map(w => w.end)))
          expect(s.text).toBe(s.words.map(w => w.word).join('').trim())
        }
      }
    })
  })

  describe('purity', () => {
    it('is idempotent', () => {
      for (const [, input, , language] of [...allCases, ['user', [userSegment], []] as Case, ['triplet', userTriplet, []] as Case]) {
        const once = clean(input, language)
        const twice = cleanRawTranscript(once.raw)
        expect(twice.raw).toEqual(once.raw)
        expect(twice.report).toEqual(NO_CHANGES)
      }
    })

    it('does not mutate its input', () => {
      for (const [, input, , language] of [...allCases, ['user', [userSegment], []] as Case, ['triplet', userTriplet, []] as Case]) {
        const transcript = raw(input, language)
        const copy = structuredClone(transcript)
        cleanRawTranscript(transcript)
        expect(transcript).toEqual(copy)
      }
    })

    it('keeps the transcript fields and leaves segments without letters alone', () => {
      const empty: RawSegment = { start: 3, end: 4, text: '', words: [] }
      const { raw: out, report } = cleanRawTranscript({ language: 'en', durationSec: 12.5, model: 'm', device: 'cuda', segments: [empty] })
      expect(out).toEqual({ language: 'en', durationSec: 12.5, model: 'm', device: 'cuda', segments: [empty] })
      expect(report).toEqual(NO_CHANGES)
    })
  })

  describe('input shapes', () => {
    it('cleans transcripts written before the confidence fields existed', () => {
      const file = JSON.parse(JSON.stringify(raw([userSegment, seg(zw('謝謝觀看', 150, 0.2, 0.95))]))) as unknown
      const parsed = rawTranscriptSchema.parse(file)
      expect(parsed.segments[0]).not.toHaveProperty('avgLogprob')
      expect(cleanRawTranscript(parsed).raw.segments.map(s => s.text)).toEqual(['我們先過去那邊快快快快好過來過來', '謝謝觀看'])
    })

    it('cleans the text of a segment without word timestamps', () => {
      const input: RawSegment = { start: 20, end: 25, text: '快'.repeat(30), words: [] }
      const [out] = clean([input]).raw.segments
      expect(out).toEqual({ start: 20, end: 25, text: '快快快快', words: [] })
    })

    it('counts high compression ratios without acting on them', () => {
      const input = [seg(zw('大家好歡迎回來', 0), { compressionRatio: 2.6 }), seg(zw('今天玩新遊戲', 3), { compressionRatio: 1.2 })]
      const { raw: out, report } = clean(input)
      expect(out.segments).toEqual(input)
      expect(report).toEqual({ ...NO_CHANGES, highCompression: 1 })
    })
  })
})

describe('formatCleanupReport', () => {
  it('returns null when nothing was removed', () => {
    expect(formatCleanupReport(NO_CHANGES)).toBeNull()
    expect(formatCleanupReport({ ...NO_CHANGES, highCompression: 3 })).toBeNull()
  })

  it('lists what each rule removed', () => {
    expect(formatCleanupReport({
      stockPhrases: 2, silenceDropped: 1, repeatsCollapsed: 3, charsRemoved: 70, duplicatesDropped: 4, segmentsDropped: 6, highCompression: 2,
    })).toBe('逐字稿清理：縮短連續重複 3 處（刪掉 70 字）、刪掉幻覺句 2 處、刪掉靜音段落 1 段、刪掉重複段落 4 段，共刪掉 6 段；2 段壓縮比偏高')
    expect(formatCleanupReport({ ...NO_CHANGES, silenceDropped: 1, segmentsDropped: 1 })).toBe('逐字稿清理：刪掉靜音段落 1 段，共刪掉 1 段')
  })
})
