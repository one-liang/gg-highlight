import { describe, expect, it } from 'vitest'
import type { Language } from '../../../shared/types/domain'
import type { RawSegment, RawTranscript, RawWord } from '../transcription/protocol'
import { buildTranscriptSegments, HARD_PAUSE_SECONDS, MAX_SEGMENT_SECONDS, MAX_SEGMENT_UNITS } from './segments'
import { textUnits, toTaiwanTraditional } from './text'
import type { SegmentDraft } from './types'

function raw(segments: RawSegment[], language: Language = 'zh'): RawTranscript {
  const end = segments.reduce((m, s) => Math.max(m, s.end), 0)
  return { language, durationSec: end, model: 'test', device: 'cpu', segments }
}

/** One word per character (how Whisper times Chinese), evenly spaced. */
function charWords(text: string, start: number, step: number): RawWord[] {
  return Array.from(text).map((ch, i) => ({ word: ch, start: start + i * step, end: start + (i + 1) * step, probability: 0.9 }))
}

/** Whisper-style English words: each carries its leading space. */
function enWords(text: string, start: number, step: number): RawWord[] {
  return (text.match(/\s*\S+/g) ?? []).map((w, i) => ({ word: w, start: start + i * step, end: start + i * step + step * 0.8, probability: 0.9 }))
}

function seg(words: RawWord[], text?: string): RawSegment {
  return {
    start: words[0]?.start ?? 0,
    end: words[words.length - 1]?.end ?? 0,
    text: text ?? words.map(w => w.word).join(''),
    words,
  }
}

function expectWellFormed(drafts: SegmentDraft[]) {
  for (const [k, d] of drafts.entries()) {
    expect(d.text.trim()).toBe(d.text)
    expect(d.text.length).toBeGreaterThan(0)
    expect(Number.isFinite(d.start) && Number.isFinite(d.end)).toBe(true)
    expect(d.end).toBeGreaterThan(d.start) // every line gets some time on screen
    const prev = drafts[k - 1]
    if (prev) {
      expect(d.start).toBeGreaterThanOrEqual(prev.start)
      expect(d.start).toBeGreaterThanOrEqual(prev.end)
    }
  }
}

describe('buildTranscriptSegments: zh', () => {
  it('converts a Simplified transcript to Taiwan Traditional', () => {
    const words = charWords('这个游戏太厉害了', 1, 0.25)
    const out = buildTranscriptSegments(raw([seg(words)]), 'zh')
    expect(out).toEqual([{ start: 1, end: 3, text: '這個遊戲太厲害了' }])
  })

  it('converts Taiwan phrases that span words (软|件 → 軟體)', () => {
    const words = charWords('这个软件很好用', 0, 0.2)
    expect(buildTranscriptSegments(raw([seg(words)]), 'zh')[0]!.text).toBe('這個軟體很好用')
  })

  it('handles phrases whose length changes across words (内|存 → 記憶體)', () => {
    const words: RawWord[] = [
      { word: '这个', start: 0.5, end: 0.9, probability: 1 },
      { word: '内', start: 0.9, end: 1.1, probability: 1 },
      { word: '存', start: 1.1, end: 1.3, probability: 1 },
      { word: '不够', start: 1.3, end: 1.8, probability: 1 },
      { word: '用', start: 1.8, end: 2.0, probability: 1 },
    ]
    expect(buildTranscriptSegments(raw([seg(words)]), 'zh')).toEqual([{ start: 0.5, end: 2, text: '這個記憶體不夠用' }])
  })

  it('drops the spaces Whisper puts between CJK words', () => {
    const words: RawWord[] = [
      { word: ' 大家', start: 0, end: 0.4, probability: 1 },
      { word: ' 好', start: 0.4, end: 0.6, probability: 1 },
      { word: ' 我', start: 0.7, end: 0.8, probability: 1 },
      { word: '用', start: 0.8, end: 0.9, probability: 1 },
      { word: ' iPhone', start: 0.9, end: 1.4, probability: 1 },
      { word: ' 拍', start: 1.4, end: 1.6, probability: 1 },
    ]
    expect(buildTranscriptSegments(raw([seg(words)]), 'zh')[0]!.text).toBe('大家好我用 iPhone 拍')
  })

  it('cleans punctuation the Taiwanese subtitle way', () => {
    const out = buildTranscriptSegments(raw([
      seg(charWords('好，我们走吧。', 0, 0.2)),
      seg(charWords('真的吗？', 3, 0.2)),
      seg(charWords('太扯了吧！', 5, 0.2)),
      seg(charWords('苹果、香蕉；橘子：', 7, 0.2)),
    ]), 'zh')
    expect(out.map(s => s.text)).toEqual(['好 我們走吧', '真的嗎？', '太扯了吧！', '蘋果 香蕉 橘子'])
  })

  it('drops segments that are only punctuation', () => {
    const out = buildTranscriptSegments(raw([
      seg(charWords('。', 0, 0.2)),
      seg(charWords('嗯', 1, 0.3)),
      seg([{ word: ' …', start: 2, end: 2.5, probability: 0.5 }]),
    ]), 'zh')
    expect(out).toEqual([{ start: 1, end: 1.3, text: '嗯' }])
  })

  it('splits a long segment at clause punctuation', () => {
    const text = '我们今天要来玩一款全新的游戏，这款游戏是最近非常热门的生存游戏，大家一起来看看吧'
    const out = buildTranscriptSegments(raw([seg(charWords(text, 0, 0.12))]), 'zh')
    expectWellFormed(out)
    expect(out.map(s => s.text)).toEqual([
      '我們今天要來玩一款全新的遊戲',
      '這款遊戲是最近非常熱門的生存遊戲 大家一起來看看吧',
    ])
    expect(out[0]!.start).toBe(0)
    expect(out[0]!.end).toBeCloseTo(14 * 0.12)
    expect(out[1]!.start).toBeCloseTo(15 * 0.12)
  })

  it('prefers sentence ends over clause punctuation', () => {
    // Either cut fits; the one after 。 wins.
    const text = '今天天气很好，我们去公园散步吧。然后再去吃一顿好吃的晚餐，好不好'
    const out = buildTranscriptSegments(raw([seg(charWords(text, 0, 0.1))]), 'zh')
    expect(out.map(s => s.text)).toEqual(['今天天氣很好 我們去公園散步吧', '然後再去吃一頓好吃的晚餐 好不好'])
  })

  it('splits at a pause when there is no punctuation', () => {
    const first = charWords('这一波我们一定要拿下来', 0, 0.15)
    const second = charWords('不然等一下对面就会直接推进来了啦', first[first.length - 1]!.end + 0.6, 0.15)
    const out = buildTranscriptSegments(raw([seg([...first, ...second])]), 'zh')
    expect(out.map(s => s.text)).toEqual(['這一波我們一定要拿下來', '不然等一下對面就會直接推進來了啦'])
    expect(out[0]!.end).toBeCloseTo(first[first.length - 1]!.end)
    expect(out[1]!.start).toBeCloseTo(second[0]!.start)
  })

  it('splits evenly when there is nothing better than a word boundary', () => {
    const text = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十'
    const out = buildTranscriptSegments(raw([seg(charWords(text, 0, 0.1))]), 'zh')
    expectWellFormed(out)
    expect(out).toHaveLength(2)
    expect(out.map(s => textUnits(s.text))).toEqual([20, 20])
  })

  it('keeps every piece within the unit and duration limits', () => {
    const text = '大家好欢迎回到我的直播今天我们要玩的是一款非常好玩的游戏而且这款游戏最近真的非常非常热门所以我们赶快开始吧'.repeat(3)
    const out = buildTranscriptSegments(raw([seg(charWords(text, 10, 0.3))]), 'zh')
    expectWellFormed(out)
    expect(out.length).toBeGreaterThan(3)
    for (const s of out) {
      expect(textUnits(s.text)).toBeLessThanOrEqual(MAX_SEGMENT_UNITS)
      expect(s.end - s.start).toBeLessThanOrEqual(MAX_SEGMENT_SECONDS)
    }
    expect(out.map(s => s.text).join('')).toBe(toTaiwanTraditional(text))
  })

  it('always ends a segment at a long silence', () => {
    const first = charWords('好', 0, 0.3)
    const second = charWords('走吧', 0.3 + HARD_PAUSE_SECONDS + 0.5, 0.3)
    const out = buildTranscriptSegments(raw([seg([...first, ...second])]), 'zh')
    expect(out.map(s => s.text)).toEqual(['好', '走吧'])
  })

  it('splits text proportionally over time when a segment has no words', () => {
    const out = buildTranscriptSegments(raw([{ start: 0, end: 8, text: '这个游戏 真的太好玩了', words: [] }]), 'zh')
    expectWellFormed(out)
    expect(out.map(s => s.text)).toEqual(['這個遊戲', '真的太好玩了'])
    expect(out[0]!.start).toBe(0)
    expect(out[0]!.end).toBeCloseTo(8 * 4 / 10, 2)
    expect(out[1]!.end).toBe(8)
  })

  it('keeps a short segment without words whole', () => {
    const out = buildTranscriptSegments(raw([{ start: 2, end: 4, text: ' 这个游戏，真好玩。', words: [] }]), 'zh')
    expect(out).toEqual([{ start: 2, end: 4, text: '這個遊戲 真好玩' }])
  })
})

describe('buildTranscriptSegments: realistic faster-whisper output', () => {
  // Shape of transcript.raw.json: multi-character words, punctuation merged into the word before.
  const transcript: RawTranscript = {
    language: 'zh',
    durationSec: 20,
    model: 'SoybeanMilk/faster-whisper-Breeze-ASR-25',
    device: 'cuda',
    segments: [
      {
        start: 0.0,
        end: 3.4,
        text: '这个游戏太厉害了，我们再来一局吧！',
        words: [
          { word: '这个', start: 0.0, end: 0.32, probability: 0.98 },
          { word: '游戏', start: 0.32, end: 0.7, probability: 0.97 },
          { word: '太', start: 0.7, end: 0.9, probability: 0.99 },
          { word: '厉害', start: 0.9, end: 1.3, probability: 0.95 },
          { word: '了，', start: 1.3, end: 1.52, probability: 0.9 },
          { word: '我们', start: 1.8, end: 2.1, probability: 0.96 },
          { word: '再来', start: 2.1, end: 2.5, probability: 0.94 },
          { word: '一局', start: 2.5, end: 2.9, probability: 0.93 },
          { word: '吧！', start: 2.9, end: 3.2, probability: 0.9 },
        ],
      },
      {
        start: 4.0,
        end: 12.0,
        text: '刚刚那个软件是不是有问题，为什么画面一直卡住，然后声音也跟着断掉了，真的很烦',
        words: [
          ['刚刚', 4.0, 4.3], ['那个', 4.3, 4.6], ['软件', 4.6, 5.0], ['是不是', 5.0, 5.4], ['有', 5.4, 5.5],
          ['问题，', 5.5, 5.9], ['为什么', 6.1, 6.5], ['画面', 6.5, 6.8], ['一直', 6.8, 7.1], ['卡住，', 7.1, 7.6],
          ['然后', 7.9, 8.2], ['声音', 8.2, 8.5], ['也', 8.5, 8.6], ['跟着', 8.6, 8.9], ['断掉', 8.9, 9.3],
          ['了，', 9.3, 9.5], ['真的', 9.9, 10.2], ['很', 10.2, 10.4], ['烦', 10.4, 10.8],
        ].map(([word, start, end]) => ({ word: word as string, start: start as number, end: end as number, probability: 0.9 })),
      },
    ],
  }

  it('produces clean Taiwan Traditional segments split at clauses', () => {
    const out = buildTranscriptSegments(transcript, 'zh')
    expectWellFormed(out)
    expect(out).toEqual([
      { start: 0, end: 3.2, text: '這個遊戲太厲害了 我們再來一局吧！' },
      { start: 4, end: 7.6, text: '剛剛那個軟體是不是有問題 為什麼畫面一直卡住' },
      { start: 7.9, end: 10.8, text: '然後聲音也跟著斷掉了 真的很煩' },
    ])
  })
})

describe('buildTranscriptSegments: en', () => {
  it('joins Whisper words and keeps punctuation', () => {
    const words = enWords(' Hello everyone, welcome back!', 0.5, 0.4)
    expect(buildTranscriptSegments(raw([seg(words)], 'en'), 'en')).toEqual([
      { start: 0.5, end: 0.5 + 3 * 0.4 + 0.32, text: 'Hello everyone, welcome back!' },
    ])
  })

  it('does not insert spaces Whisper did not produce', () => {
    const words: RawWord[] = [
      { word: ' It', start: 0, end: 0.2, probability: 1 },
      { word: ' is', start: 0.2, end: 0.4, probability: 1 },
      { word: ' well', start: 0.4, end: 0.6, probability: 1 },
      { word: '-known', start: 0.6, end: 0.9, probability: 1 },
      { word: '.', start: 0.9, end: 0.9, probability: 1 },
    ]
    expect(buildTranscriptSegments(raw([seg(words)], 'en'), 'en')[0]!.text).toBe('It is well-known.')
  })

  it('splits long speech at sentence ends', () => {
    const text = ' Hello everyone, welcome back to the stream. Today we are going to play a brand new game and it is going to be amazing, trust me.'
    const out = buildTranscriptSegments(raw([seg(enWords(text, 0, 0.3))], 'en'), 'en')
    expectWellFormed(out)
    expect(out[0]!.text).toBe('Hello everyone, welcome back to the stream.')
    for (const s of out) expect(textUnits(s.text)).toBeLessThanOrEqual(MAX_SEGMENT_UNITS)
    expect(out.map(s => s.text).join(' ')).toBe(text.trim())
  })

  it('splits slow speech by duration', () => {
    const out = buildTranscriptSegments(raw([seg(enWords(' So we just wait here and then we go', 0, 1))], 'en'), 'en')
    expectWellFormed(out)
    expect(out.length).toBeGreaterThan(1)
    for (const s of out) expect(s.end - s.start).toBeLessThanOrEqual(MAX_SEGMENT_SECONDS)
    expect(out.map(s => s.text).join(' ')).toBe('So we just wait here and then we go')
  })

  it('splits text by word width when a segment has no words', () => {
    const out = buildTranscriptSegments(raw([{ start: 0, end: 4, text: ' Good game, well played.', words: [] }], 'en'), 'en')
    expect(out).toEqual([{ start: 0, end: 4, text: 'Good game, well played.' }])
  })
})

describe('buildTranscriptSegments: edge cases', () => {
  it('returns nothing for an empty transcript', () => {
    expect(buildTranscriptSegments(raw([]), 'zh')).toEqual([])
    expect(buildTranscriptSegments(raw([{ start: 0, end: 1, text: '', words: [] }]), 'en')).toEqual([])
    expect(buildTranscriptSegments(raw([{ start: 0, end: 1, text: '   ', words: [] }]), 'zh')).toEqual([])
  })

  it('gives zero-length words some screen time', () => {
    const words: RawWord[] = [
      { word: '好', start: 3, end: 3, probability: 1 },
      { word: '啊', start: 3, end: 3, probability: 1 },
    ]
    const out = buildTranscriptSegments(raw([{ start: 2.5, end: 5, text: '好啊', words }]), 'zh')
    expect(out).toEqual([{ start: 3, end: 4, text: '好啊' }])
  })

  it('copes with a segment end and an audio length that are not numbers', () => {
    const words: RawWord[] = [{ word: '好', start: 3, end: 3, probability: 1 }]
    const out = buildTranscriptSegments(raw([{ start: 3, end: Number.NaN, text: '好', words }]), 'zh')
    expect(out).toEqual([{ start: 3, end: 4, text: '好' }])
  })

  it('shows zero-length words for a second, until the next segment or the end of the audio at most', () => {
    const words: RawWord[] = [{ word: ' Yes', start: 2, end: 2, probability: 1 }]
    const yes: RawSegment = { start: 1.5, end: 2, text: ' Yes', words }
    expect(buildTranscriptSegments({ ...raw([yes], 'en'), durationSec: 900 }, 'en')).toEqual([{ start: 2, end: 3, text: 'Yes' }])
    expect(buildTranscriptSegments({ ...raw([yes], 'en'), durationSec: 2.4 }, 'en')).toEqual([{ start: 2, end: 2.4, text: 'Yes' }])
    const next = seg(enWords(' Okay', 2.6, 0.3))
    expect(buildTranscriptSegments(raw([yes, next], 'en'), 'en')[0]).toEqual({ start: 2, end: 2.6, text: 'Yes' })
  })

  it('a loop collapsed onto its segment end (segment end = last word end) still gets a second', () => {
    const loop = (text: string): RawSegment => ({ start: 143.2, end: 143.2, text, words: Array.from(text).map(word => ({ word, start: 143.2, end: 143.2, probability: 0.3 })) })
    const out = buildTranscriptSegments({ ...raw([loop('快快快快'), loop('快快快快走吧')]), durationSec: 900 }, 'zh')
    expectWellFormed(out)
    expect(out).toEqual([
      { start: 143.2, end: 144.2, text: '快快快快' },
      { start: 144.2, end: 145.2, text: '快快快快走吧' },
    ])
  })

  it('collapsed pieces of one segment are shown one after the other', () => {
    const text = '我們先過去那邊然後再回來這裡看看有沒有東西可以拿走吧好不好'
    const words = Array.from(text).map(word => ({ word, start: 50, end: 50, probability: 0.3 }))
    const out = buildTranscriptSegments({ ...raw([{ start: 50, end: 50, text, words }]), durationSec: 900 }, 'zh')
    expect(out.length).toBeGreaterThan(1)
    expectWellFormed(out)
    expect(out[0]!.start).toBe(50)
  })

  it('ignores words with invalid times and fixes reversed ones', () => {
    const words: RawWord[] = [
      { word: '你', start: Number.NaN, end: 1, probability: 1 },
      { word: '好', start: 1, end: 1.5, probability: 1 },
      { word: '啊', start: 2, end: 1.8, probability: 1 },
    ]
    const out = buildTranscriptSegments(raw([{ start: 0, end: 2.5, text: '你好啊', words }]), 'zh')
    expect(out).toEqual([{ start: 1, end: 2, text: '好啊' }])
  })

  it('sorts segments and removes overlaps', () => {
    const out = buildTranscriptSegments(raw([
      seg(charWords('第二句话', 5, 0.3)),
      seg(charWords('第一句话说完', 1, 0.8)),
      seg(charWords('重复', 5, 0.2)),
    ]), 'zh')
    expectWellFormed(out)
    expect(out.map(s => s.text)).toEqual(['第一句話說完', '重複', '第二句話'])
    expect(out[0]!.end).toBe(5)
  })

  it('keeps all text over a random transcript and respects every limit', () => {
    let seed = 42
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const vocab = ['我们', '这个', '游戏', '真的', '太', '厉害', '了', '，', '。', '？', '大家', '一起', '来', 'GG', ' iPhone', '吧']
    const segments: RawSegment[] = []
    let t = 0
    for (let s = 0; s < 40; s++) {
      const words: RawWord[] = []
      const count = 1 + Math.floor(rand() * 60)
      for (let w = 0; w < count; w++) {
        const gap = rand() < 0.1 ? 0.5 + rand() : rand() * 0.1
        const len = 0.05 + rand() * 0.4
        t += gap
        words.push({ word: vocab[Math.floor(rand() * vocab.length)]!, start: t, end: t + len, probability: 1 })
        t += len
      }
      segments.push(seg(words))
      t += 0.5
    }
    const out = buildTranscriptSegments(raw(segments), 'zh')
    expectWellFormed(out)
    for (const s of out) {
      expect(textUnits(s.text)).toBeLessThanOrEqual(MAX_SEGMENT_UNITS)
      expect(s.end - s.start).toBeLessThanOrEqual(MAX_SEGMENT_SECONDS)
    }
    // No spoken text gets lost: compare the letters and digits only.
    const letters = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '')
    const expected = segments.map(s => letters(toTaiwanTraditional(s.words.map(w => w.word).join('')))).join('')
    expect(letters(out.map(s => s.text).join(''))).toBe(expected)
  })
})
