import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CHAT_AUTHOR_COOLDOWN_SEC, CHAT_BASELINE_HALF_WINDOW_SEC, CHAT_LAG_START_SEC, CHAT_MIN_AUTHORS, CHAT_MIN_COUNT,
  CHAT_MIN_PER_HOUR, CHAT_WINDOW_SEC, chatDensity, messageWeight, readChatMessages,
} from './chat'
import type { ChatMessage } from './types'

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-fixtures', 'small-stream.live_chat.json')

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'gg-chat-'))
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))
let fileCount = 0

function writeChat(lines: (string | object)[], eol = '\n'): string {
  const file = path.join(tmpDir, `chat-${++fileCount}.live_chat.json`)
  writeFileSync(file, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join(eol) + eol)
  return file
}

type Run = { text: string } | { emoji: Record<string, unknown> }

interface MessageSpec {
  id?: string
  author?: string
  text?: string
  runs?: Run[]
  renderer?: string
}

/** One addChatItemAction in yt-dlp's shape. */
function action({ id, author, text, runs, renderer = 'liveChatTextMessageRenderer' }: MessageSpec): object {
  const body: Record<string, unknown> = { timestampUsec: '1700000000000000' }
  if (id !== undefined) body.id = id
  if (author !== undefined) body.authorExternalChannelId = author
  if (runs || text !== undefined) body.message = { runs: runs ?? [{ text }] }
  return { clickTrackingParams: 'x', addChatItemAction: { item: { [renderer]: body }, clientId: 'c' } }
}

/** A replay line (offset inside replayChatItemAction) holding the given actions. */
function line(offsetMs: number, ...actions: object[]): object {
  return { clickTrackingParams: 'x', replayChatItemAction: { actions, videoOffsetTimeMsec: String(offsetMs) } }
}

const msg = (offsetMs: number, spec: MessageSpec) => line(offsetMs, action(spec))

describe('constants', () => {
  it('match design.md', () => {
    expect([CHAT_LAG_START_SEC, CHAT_WINDOW_SEC, CHAT_BASELINE_HALF_WINDOW_SEC]).toEqual([5, 20, 150])
    expect([CHAT_MIN_PER_HOUR, CHAT_MIN_COUNT, CHAT_MIN_AUTHORS, CHAT_AUTHOR_COOLDOWN_SEC]).toEqual([120, 3, 3, 5])
  })
})

describe('messageWeight', () => {
  it.each([
    // Greetings and farewells (≤ 12 characters without emoji shortcuts) → 0
    ['晚安', 0], ['東哥晚上好', 0], ['午安', 0], ['早安各位', 0], ['安安', 0], ['哈囉', 0], ['嗨東哥', 0], ['大家好', 0],
    ['主播好', 0], ['掰掰', 0], ['拜拜～', 0], ['要下播了嗎', 0], ['辛苦了', 0], ['報到', 0],
    ['hi', 0], ['Hi 東哥', 0], ['HELLO!', 0], ['bye bye', 0], ['88', 0], ['東哥888', 0], ['👋', 0], ['👋🏻', 0],
    [':hand-pink-waving:', 0], [':hand-pink-waving::hand-pink-waving::hand-pink-waving:', 0],
    ['主播好:hand-pink-waving:', 0],
    ['哈哈哈哈👋🏻', 0], // a greeting token wins over a reaction token
    ['大家好啊啊啊啊啊啊啊啊啊', 0], // 12 characters
    ['大家好啊啊啊啊啊啊啊啊啊啊', 1], // 13 characters
    [`晚安${':hand-pink-waving:'.repeat(5)}`, 0], // shortcuts do not count toward the 12
    ['晚安，今天這場打得真的很精彩喔', 1], // long: a real message
    ['晚安 今天真的笑死我了這場超好看', 2],
    // Reactions → 2
    ['笑死', 2], ['笑爛', 2], ['笑翻了', 2], ['哈哈', 2], ['哈哈哈哈哈', 2], ['草', 2], ['www', 2], ['WWWWW', 2],
    ['XD', 2], ['xDDD', 2], ['lol', 2], ['LMAO', 2], ['kekw', 2], ['🤣', 2], ['😂😂', 2], ['？？', 2], ['??', 2],
    ['？?', 2], ['！！', 2], ['!!', 2], ['好扯', 2], ['太扯了吧', 2], ['靠北', 2], ['救命啊', 2], ['嚇死我了', 2],
    ['太神了', 2], ['好猛', 2], ['神操作', 2], ['666', 2], ['66666', 2], ['nice', 2], ['Nice shot', 2], ['gg', 2],
    ['GG', 2], ['ㄏㄏ', 2], ['lol🤣', 2], ['這招好猛', 2],
    // Everything else → 1
    ['對啊', 1], ['這也行', 1], ['', 1], ['哈', 1], ['ww', 1], ['？', 1], ['!', 1], ['66', 1],
    // Latin tokens only match whole words
    ['this', 1], ['nothing', 1], ['egg', 1], ['eggs', 1], ['1688', 1], ['nicely', 1], ['maxdamage', 1], ['lolly', 1],
  ])('%s → %i', (text, weight) => {
    expect(messageWeight(text)).toBe(weight)
  })
})

describe('readChatMessages', () => {
  it('reads the small-stream fixture (engagement line ignored, emoji as text)', async () => {
    const messages = await readChatMessages(FIXTURE, 3654)
    expect(messages).toEqual([
      { offsetSec: 88.03, weight: 0, author: null }, // 哈哈哈哈👋🏻
      { offsetSec: 154.001, weight: 0, author: null }, // :hand-pink-waving: ×3
      { offsetSec: 172.03, weight: 0, author: null }, // 好扯:hand-pink-waving:
      { offsetSec: 923.141, weight: 1, author: null }, // 對啊
      { offsetSec: 966.939, weight: 2, author: null }, // lol🤣
      { offsetSec: 968.75, weight: 2, author: null }, // 這招好猛
      { offsetSec: 2036.024, weight: 2, author: null }, // ？？？
      { offsetSec: 3614.119, weight: 2, author: null }, // 🤣
      { offsetSec: 3646.218, weight: 1, author: null }, // 這也行
    ])
  })

  it('drops offsets past the duration', async () => {
    const messages = await readChatMessages(FIXTURE, 3600)
    expect(messages.map(m => m.offsetSec)).toEqual([88.03, 154.001, 172.03, 923.141, 966.939, 968.75, 2036.024])
  })

  it('drops negative offsets and keeps one exactly at the end', async () => {
    const file = writeChat([
      msg(-2000, { id: 'a', text: '開台前' }),
      msg(0, { id: 'b', text: '開始' }),
      msg(60000, { id: 'c', text: '結束' }),
      msg(60001, { id: 'd', text: '太晚' }),
    ])
    expect((await readChatMessages(file, 60)).map(m => m.offsetSec)).toEqual([0, 60])
  })

  it('reads every action of a line', async () => {
    const file = writeChat([
      line(1000, action({ id: 'a', author: 'UC1', text: '對啊' }), action({ id: 'b', author: 'UC2', text: '笑死' })),
    ])
    expect(await readChatMessages(file, 10)).toEqual([
      { offsetSec: 1, weight: 1, author: 'UC1' },
      { offsetSec: 1, weight: 2, author: 'UC2' },
    ])
  })

  it('falls back to the top-level videoOffsetTimeMsec (live downloads)', async () => {
    const file = writeChat([
      { replayChatItemAction: { actions: [action({ id: 'a', text: '對啊' })] }, videoOffsetTimeMsec: '5000', isLive: true },
      // replayChatItemAction's own offset wins when both exist
      { replayChatItemAction: { actions: [action({ id: 'b', text: '對啊' })], videoOffsetTimeMsec: '7000' }, videoOffsetTimeMsec: '9000' },
      // no usable offset: skipped (not read as 0)
      { replayChatItemAction: { actions: [action({ id: 'c', text: '對啊' })] } },
      { replayChatItemAction: { actions: [action({ id: 'd', text: '對啊' })], videoOffsetTimeMsec: null } },
      { replayChatItemAction: { actions: [action({ id: 'e', text: '對啊' })], videoOffsetTimeMsec: '' } },
      { replayChatItemAction: { actions: [action({ id: 'f', text: '對啊' })], videoOffsetTimeMsec: 'soon' } },
    ])
    expect((await readChatMessages(file, 60)).map(m => m.offsetSec)).toEqual([5, 7])
  })

  it('skips unparsable lines (a garbled line, a truncated last line) and blank lines, with CRLF too', async () => {
    const good = JSON.stringify(msg(2000, { id: 'b', text: '對啊' }))
    const file = writeChat([
      msg(1000, { id: 'a', text: '對啊' }),
      'not json',
      '',
      good,
      '[1, 2]',
      'null',
      good.slice(0, good.length / 2),
    ], '\r\n')
    expect((await readChatMessages(file, 60)).map(m => m.offsetSec)).toEqual([1, 2])
  })

  it('counts each message id once (yt-dlp re-fetches with a 5 s overlap)', async () => {
    const file = writeChat([
      msg(1000, { id: 'a', author: 'UC1', text: '對啊' }),
      msg(1000, { id: 'a', author: 'UC1', text: '對啊' }),
      msg(20000, { id: 'b', author: 'UC1', text: '笑死' }),
      msg(20000, { id: 'b', author: 'UC1', text: '笑死' }),
      msg(30000, { author: 'UC2', text: '沒有 id' }),
      msg(30000, { author: 'UC3', text: '沒有 id' }),
    ])
    expect(await readChatMessages(file, 60)).toEqual([
      { offsetSec: 1, weight: 1, author: 'UC1' },
      { offsetSec: 20, weight: 2, author: 'UC1' },
      { offsetSec: 30, weight: 1, author: 'UC2' },
      { offsetSec: 30, weight: 1, author: 'UC3' },
    ])
  })

  it('keeps only the first message of an author within 5 s', async () => {
    const at = (offsetMs: number, id: string, author = 'UCa') => msg(offsetMs, { id, author, text: '對啊' })
    const file = writeChat([
      at(0, 'a0'), at(3000, 'a1'), at(5500, 'a2'), at(6000, 'a3'), at(11000, 'a4'),
      at(20000, 'a5'), at(25000, 'a6'), // exactly 5 s later counts again
      at(1000, 'b0', 'UCb'), at(2000, 'b1', 'UCb'),
    ])
    expect((await readChatMessages(file, 60)).map(m => `${m.author}@${m.offsetSec}`)).toEqual([
      'UCa@0', 'UCb@1', 'UCa@5.5', 'UCa@11', 'UCa@20', 'UCa@25',
    ])
  })

  it('treats every message without an author id as its own author', async () => {
    const file = writeChat([
      msg(1000, { id: 'a', text: '對啊' }),
      msg(1000, { id: 'b', text: '對啊' }),
      msg(2000, { id: 'c', author: '', text: '對啊' }),
    ])
    expect(await readChatMessages(file, 60)).toEqual([
      { offsetSec: 1, weight: 1, author: null },
      { offsetSec: 1, weight: 1, author: null },
      { offsetSec: 2, weight: 1, author: null },
    ])
  })

  it('counts Super Chats and Super Stickers, ignores memberships, system messages and other actions', async () => {
    const file = writeChat([
      msg(1000, { id: 'paid', author: 'UC1', renderer: 'liveChatPaidMessageRenderer', text: 'nice' }),
      msg(2000, { id: 'paid-silent', author: 'UC2', renderer: 'liveChatPaidMessageRenderer' }),
      msg(3000, { id: 'sticker', author: 'UC3', renderer: 'liveChatPaidStickerRenderer' }),
      msg(4000, { id: 'member', author: 'UC4', renderer: 'liveChatMembershipItemRenderer', text: '新會員' }),
      msg(5000, { id: 'engage', renderer: 'liveChatViewerEngagementMessageRenderer', text: 'Live chat replay is on.' }),
      msg(6000, { id: 'gift', author: 'UC5', renderer: 'liveChatSponsorshipsGiftPurchaseAnnouncementRenderer' }),
      msg(7000, { id: 'placeholder', renderer: 'liveChatPlaceholderItemRenderer' }),
      line(8000, { addBannerToLiveChatCommand: { bannerRenderer: { liveChatBannerRenderer: {} } } }),
      line(9000, { markChatItemAsDeletedAction: { targetItemId: 'paid' } }),
      line(10000, { addLiveChatTickerItemAction: { item: { liveChatTickerPaidMessageItemRenderer: { id: 't' } } } }),
    ])
    expect(await readChatMessages(file, 60)).toEqual([
      { offsetSec: 1, weight: 2, author: 'UC1' },
      { offsetSec: 2, weight: 1, author: 'UC2' },
      { offsetSec: 3, weight: 1, author: 'UC3' },
    ])
  })

  it('builds the text from runs: standard emoji characters and custom emoji shortcuts', async () => {
    const custom = (shortcut: string) => ({ emoji: { emojiId: 'UCx/abc', shortcuts: [shortcut], isCustomEmoji: true } })
    const file = writeChat([
      msg(1000, { id: 'a', runs: [{ text: '主播好' }, custom(':hand-pink-waving:')] }), // greeting
      msg(2000, { id: 'b', runs: [{ text: '你看' }, { emoji: { emojiId: '😂', shortcuts: [':joy:'] } }] }), // reaction
      msg(3000, { id: 'c', runs: [custom(':face-blue-smiling:')] }), // plain
      msg(4000, { id: 'd', runs: [{ text: '這波' }, custom(':_kekw:')] }), // a channel's KEKW emote is a reaction
    ])
    expect((await readChatMessages(file, 60)).map(m => m.weight)).toEqual([0, 2, 1, 2])
  })

  it('returns messages sorted by time', async () => {
    const file = writeChat([
      msg(9000, { id: 'a', text: '對啊' }),
      msg(3000, { id: 'b', text: '笑死' }),
      msg(6000, { id: 'c', text: '對啊' }),
    ])
    expect((await readChatMessages(file, 60)).map(m => m.offsetSec)).toEqual([3, 6, 9])
  })

  it('returns nothing for an empty file and rejects for a missing one', async () => {
    const empty = path.join(tmpDir, 'empty.live_chat.json')
    writeFileSync(empty, '')
    expect(await readChatMessages(empty, 60)).toEqual([])
    await expect(readChatMessages(path.join(tmpDir, 'missing.live_chat.json'), 60)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

/** n messages spread evenly over [from, from + spanSec). */
function burst(from: number, spanSec: number, n: number, author: (i: number) => string | null, weight = 1): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({ offsetSec: from + (i * spanSec) / n, weight, author: author(i) }))
}

/** One message every `everySec` seconds, rotating through `authors` authors. */
function steady(durationSec: number, everySec: number, authors = 30): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let t = 0, i = 0; t < durationSec; t += everySec, i++) out.push({ offsetSec: t, weight: 1, author: `bg${i % authors}` })
  return out
}

const nonzeroSeconds = (values: Float32Array) => Array.from(values).flatMap((v, i) => (v > 0 ? [i] : []))

describe('chatDensity', () => {
  it('gives ceil(duration) values', () => {
    expect(chatDensity([], 100.2).values.length).toBe(101)
    expect(chatDensity([], 0)).toEqual({ values: new Float32Array(0), counted: 0, perHour: 0 })
    expect(chatDensity([], Number.NaN).values.length).toBe(0)
  })

  it('scores a steady chat 0 everywhere', () => {
    const density = chatDensity(steady(3600, 2), 3600)
    expect(nonzeroSeconds(density.values)).toEqual([])
  })

  it('scores a burst, shifted back by the lag: a message at t shows at s = t − 24 … t − 5', () => {
    // Background: 5 messages per 20 s window; burst: 40 messages from 40 viewers in 1000–1010 s.
    const messages = [...steady(3600, 4), ...burst(1000, 10, 40, i => `fan${i}`)]
    const { values } = chatDensity(messages, 3600)
    const nonzero = nonzeroSeconds(values)
    expect(nonzero.length).toBeGreaterThan(0)
    expect(nonzero[0]).toBeGreaterThanOrEqual(1000 - 24)
    expect(nonzero[nonzero.length - 1]).toBeLessThanOrEqual(1009 - 5)
    // Every burst message is inside [s + 5, s + 25) for s in 985–995: r = 45 against b = 5.
    for (let s = 985; s <= 995; s++) expect(values[s]).toBe(1)
    expect(values[975]).toBe(0)
    expect(values[1005]).toBe(0)
    expect(values[1009]).toBe(0)
  })

  it('needs both a 2× ratio and z ≥ 3: a small burst on a quiet chat stays low', () => {
    // b = 1 (floor): r = 7 is z ≈ 3.09 → barely above 0; r = 6 is z ≈ 2.8 → 0.
    const seven = chatDensity(burst(100, 5, 7, i => `v${i}`), 300).values
    expect(Math.max(...seven)).toBeGreaterThan(0)
    expect(Math.max(...seven)).toBeLessThan(0.05)
    const six = chatDensity(burst(100, 5, 6, i => `v${i}`), 300).values
    expect(Math.max(...six)).toBe(0)
  })

  it('scores 0 when one or two viewers spam the window', () => {
    for (const authors of [1, 2]) {
      const { values } = chatDensity(burst(500, 10, 30, i => `spam${i % authors}`), 1200)
      expect(nonzeroSeconds(values)).toEqual([])
    }
    const three = chatDensity(burst(500, 10, 30, i => `v${i % 3}`), 1200).values
    expect(Math.max(...three)).toBe(1)
  })

  it('counts each message without an author as its own author', () => {
    expect(Math.max(...chatDensity(burst(500, 10, 30, () => null), 1200).values)).toBe(1)
    // Two named viewers + one anonymous message is three authors.
    const mixed = [...burst(500, 10, 30, i => `spam${i % 2}`), { offsetSec: 505, weight: 1, author: null }]
    expect(Math.max(...chatDensity(mixed, 1200).values)).toBe(1)
  })

  it('ignores weight-0 messages (greetings) for the count and the authors; reactions count double', () => {
    const greetings = burst(500, 10, 40, i => `hi${i}`, 0)
    expect(nonzeroSeconds(chatDensity(greetings, 1200).values)).toEqual([])
    // 2 spammers + greetings from many viewers: still fewer than 3 authors of counted messages.
    const spam = burst(500, 10, 30, i => `spam${i % 2}`)
    expect(nonzeroSeconds(chatDensity([...spam, ...greetings], 1200).values)).toEqual([])
    // 4 reactions (weight 2, r = 8) score where 4 plain messages (r = 4) do not.
    expect(Math.max(...chatDensity(burst(500, 4, 4, i => `v${i}`, 2), 1200).values)).toBeGreaterThan(0)
    expect(Math.max(...chatDensity(burst(500, 4, 4, i => `v${i}`, 1), 1200).values)).toBe(0)
  })

  it('reports counted messages (weight > 0) and the hourly rate', () => {
    const messages = [...steady(3600, 12), ...burst(100, 10, 50, i => `hi${i}`, 0)]
    const density = chatDensity(messages, 3600)
    expect(density.counted).toBe(300)
    expect(density.perHour).toBe(300)
    const half = chatDensity(steady(1800, 20), 1800)
    expect(half.counted).toBe(90)
    expect(half.perHour).toBe(180)
    expect(half.perHour).toBeGreaterThanOrEqual(CHAT_MIN_PER_HOUR)
  })

  it('ignores messages outside [0, duration]', () => {
    const outside = [...burst(-50, 10, 30, i => `v${i}`), ...burst(700, 10, 30, i => `v${i}`)]
    const density = chatDensity(outside, 600)
    expect(density.counted).toBe(0)
    expect(nonzeroSeconds(density.values)).toEqual([])
  })

  it('counts messages exactly at the end of the video (integer and fractional durations)', () => {
    for (const duration of [600, 600.4]) {
      const atEnd = burst(duration - 10, 10, 30, i => `v${i}`).concat({ offsetSec: duration, weight: 1, author: 'last' })
      const density = chatDensity(atEnd, duration)
      expect(density.counted).toBe(31)
      expect(density.values.length).toBe(Math.ceil(duration))
      // The end-of-video burst shows 5–25 s earlier.
      expect(Math.max(...density.values.subarray(Math.floor(duration) - 25))).toBe(1)
    }
  })

  it('does not depend on the input order', () => {
    const messages = [...steady(3600, 4), ...burst(1000, 10, 40, i => `fan${i}`)]
    expect(chatDensity([...messages].reverse(), 3600)).toEqual(chatDensity(messages, 3600))
  })

  it('handles a 12 h stream quickly', () => {
    const duration = 43_200
    const messages = steady(duration, 0.5, 400) // 86,400 messages
    for (let t = 1000; t < duration; t += 3600) messages.push(...burst(t, 15, 60, i => `fan${i}`))
    const started = performance.now()
    const density = chatDensity(messages, duration)
    const elapsed = performance.now() - started
    expect(density.values.length).toBe(duration)
    expect(nonzeroSeconds(density.values).length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(1000)
  })
})
