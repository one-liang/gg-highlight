import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { TranscriptMoment } from '../signals/types'
import { momentsTrack } from '../signals/tracks'
import { startFakeOllama } from './test-helpers/fake-ollama.mjs'
import type { FakeOllama, FakeOllamaOptions } from './test-helpers/fake-ollama.mjs'
import {
  buildChunkMessages, CHAT_OPTIONS, chunkSchema, chunkTranscript, cleanReason, dedupeMoments, parseChunkResponse, subtractSpans,
  readTranscriptWithLlm,
} from './transcript-signal'
import type { TranscriptChunk } from './transcript-signal'
import type { OllamaConfig, ReadTranscriptOptions, TranscriptLine } from './types'

const MODEL = 'qwen3.5:9b'
let fake: FakeOllama | null = null

afterEach(async () => {
  await fake?.close()
  fake = null
})

async function startFake(opts: FakeOllamaOptions = {}): Promise<OllamaConfig> {
  fake = await startFakeOllama(opts)
  return { url: fake.url, model: MODEL }
}

const chatRequests = () => fake!.requests.filter(r => r.path === '/api/chat' && r.body.messages.length > 0)
const unloadRequests = () => fake!.requests.filter(r => r.path === '/api/chat' && r.body.messages.length === 0)

function run(config: OllamaConfig, lines: TranscriptLine[], opts: Partial<ReadTranscriptOptions> = {}) {
  const logs: string[] = []
  const progress: number[] = []
  const promise = readTranscriptWithLlm(config, lines, {
    signal: new AbortController().signal,
    log: m => logs.push(m),
    onProgress: f => progress.push(f),
    ...opts,
  })
  return { promise, logs, progress }
}

/** 25 minutes, one 4 s line every 5 s; three lines contain words the fake finds exciting. */
function longTranscript(): TranscriptLine[] {
  const exciting: Record<number, string> = { 20: '哈哈哈太好笑了', 112: 'wow nice shot', 250: '這也太扯了吧' }
  return Array.from({ length: 300 }, (_, i) => ({ start: i * 5, end: i * 5 + 4, text: exciting[i] ?? `第${i}句平常的對話` }))
}

const shortTranscript: TranscriptLine[] = [
  { start: 0, end: 2.5, text: '大家好歡迎回來' },
  { start: 3, end: 5, text: '今天要打的是最終頭目' },
  { start: 6, end: 8.2, text: '哈哈哈 我又死了' },
  { start: 9, end: 11, text: '好啦 再來一次' },
]

function chunkOf(texts: string[], step = 2): TranscriptChunk {
  return { firstLine: 0, lines: texts.map((text, i) => ({ start: i * step, end: i * step + 1.5, text })) }
}

async function closedPortUrl(): Promise<string> {
  const server = http.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise(resolve => server.close(resolve))
  return `http://127.0.0.1:${port}`
}

async function waitFor(check: () => boolean, ms = 2000) {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('chunkTranscript', () => {
  it('splits 25 minutes into three 10-minute chunks overlapping by 60 s', () => {
    const chunks = chunkTranscript(longTranscript())
    expect(chunks.map(c => [c.firstLine, c.lines.length])).toEqual([[0, 120], [108, 120], [216, 84]])
    expect(chunks.map(c => [c.lines[0]!.start, c.lines.at(-1)!.start])).toEqual([[0, 595], [540, 1135], [1080, 1495]])
  })

  it('keeps a short Transcript in one chunk and skips blank lines', () => {
    const lines = [...shortTranscript, { start: 12, end: 13, text: '   ' }]
    expect(chunkTranscript(lines)).toEqual([{ firstLine: 0, lines: shortTranscript }])
    expect(chunkTranscript([])).toEqual([])
    expect(chunkTranscript([{ start: 0, end: 1, text: ' ' }])).toEqual([])
  })

  it('starts the next chunk at the next line after a long silence', () => {
    const lines = [{ start: 0, end: 2, text: 'a' }, { start: 1, end: 3, text: 'b' }, { start: 2000, end: 2002, text: 'c' }]
    expect(chunkTranscript(lines).map(c => c.lines.map(l => l.text))).toEqual([['a', 'b'], ['c']])
  })

  it('ends a chunk early when the text is too long, still overlapping and moving forward', () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({ start: i * 10, end: i * 10 + 5, text: 'x'.repeat(100) }))
    const chunks = chunkTranscript(lines, { maxChars: 350, overlapSec: 15 })
    expect(chunks.map(c => [c.firstLine, c.lines.length])).toEqual([[0, 3], [2, 3], [4, 3], [6, 3], [8, 2]])
    // A single line longer than the cap still forms a chunk.
    expect(chunkTranscript(lines.slice(0, 2), { maxChars: 50 }).map(c => c.lines.length)).toEqual([1, 1])
  })
})

describe('buildChunkMessages', () => {
  it('sends a zh-TW system prompt and numbered n|text lines', () => {
    const [system, user] = buildChunkMessages(chunkOf(['大家好', '哈哈\n哈  好扯']))
    expect(system!.role).toBe('system')
    expect(system!.content).toContain('遊戲實況')
    expect(system!.content).toContain('「行號|文字」')
    // 以下 includes the number in Taiwan usage: the prompt must not tell the model to drop the 6 the code keeps
    expect(system!.content).toContain('3. score 是 1 到 10 的整數：9–10 是整場最精彩，7–8 值得剪，6 是可以考慮；5 分以下（含 5 分）不要回傳。')
    expect(system!.content).not.toContain('6 分以下')
    expect(system!.content).toContain('20 字以內')
    expect(system!.content).toContain('{"highlights":[{"startLine"')
    expect(user).toEqual({ role: 'user', content: '以下是逐字稿，共 2 行（行號 1 到 2）：\n1|大家好\n2|哈哈 哈 好扯' })
  })

  it('keeps the system prompt identical across chunks and notes English transcripts', () => {
    const a = buildChunkMessages(chunkOf(['a']))[0]!.content
    expect(buildChunkMessages(chunkOf(['b', 'c', 'd']), 'zh')[0]!.content).toBe(a)
    const en = buildChunkMessages(chunkOf(['nice shot']), 'en')[0]!.content
    expect(en.startsWith(a)).toBe(true)
    expect(en).toContain('英文')
  })
})

describe('chunkSchema', () => {
  it('limits line numbers to the chunk, reason length, score and count; reason comes before score', () => {
    const schema = chunkSchema(37)
    const item = schema.properties.highlights.items
    expect(schema.required).toEqual(['highlights'])
    expect(schema.properties.highlights.maxItems).toBe(5)
    expect(item.properties.startLine).toEqual({ type: 'integer', minimum: 1, maximum: 37 })
    expect(item.properties.endLine).toEqual({ type: 'integer', minimum: 1, maximum: 37 })
    expect(item.properties.reason).toEqual({ type: 'string', maxLength: 40 })
    expect(item.properties.score).toEqual({ type: 'integer', minimum: 1, maximum: 10 })
    expect(Object.keys(item.properties)).toEqual(['startLine', 'endLine', 'reason', 'score'])
    expect(item.required).toEqual(['startLine', 'endLine', 'reason', 'score'])
  })
})

describe('cleanReason', () => {
  it('converts to Taiwan Traditional and strips quotes, brackets and extra sentences', () => {
    expect(cleanReason('大家笑成一团的反应')).toBe('大家笑成一團的反應')
    expect(cleanReason('「这波操作太扯了」！后面还有')).toBe('這波操作太扯了')
    expect(cleanReason('"主播被队友坑了"。然后又死了')).toBe('主播被隊友坑了')
    expect(cleanReason('（尖叫）超级大逆转，')).toBe('尖叫超級大逆轉')
    expect(cleanReason('Nice shot. Then more')).toBe('Nice shot')
    expect(cleanReason('打到 1.5 倍速')).toBe('打到 1.5 倍速')
  })

  it('caps at 40 characters and never returns an empty reason', () => {
    expect(Array.from(cleanReason('哈'.repeat(60)))).toHaveLength(40)
    expect(cleanReason('「」！')).toBe('AI 判斷這段很精彩')
  })
})

describe('parseChunkResponse', () => {
  const chunk = chunkOf(['a', 'b', 'c', 'd', 'e'])
  const answer = (highlights: unknown[]) => JSON.stringify({ highlights })

  it('maps line ranges to seconds and scores to (s - 1) / 9', () => {
    const moments = parseChunkResponse(answer([{ startLine: 2, endLine: 3, reason: '好笑', score: 10 }]), chunk)
    expect(moments).toEqual([{ start: 2, end: 5.5, score: 1, reason: '好笑' }])
    const [m] = parseChunkResponse(answer([{ startLine: 4, endLine: 4, reason: 'x', score: 6 }]), chunk)
    expect(m).toMatchObject({ start: 6, end: 7.5 })
    expect(m!.score).toBeCloseTo(5 / 9)
  })

  it('swaps reversed ranges, clamps out-of-range lines and drops scores below 6', () => {
    const moments = parseChunkResponse(answer([
      { startLine: 4, endLine: 2, reason: 'reversed', score: 8 },
      { startLine: 0, endLine: 99, reason: 'clamped', score: 7 },
      { startLine: 1, endLine: 1, reason: 'too low', score: 5 },
    ]), chunk)
    expect(moments.map(m => [m.start, m.end, m.reason])).toEqual([[2, 7.5, 'reversed'], [0, 9.5, 'clamped']])
  })

  it('throws on content that is not the expected JSON', () => {
    expect(() => parseChunkResponse('好的，第 1 行', chunk)).toThrow('回應不是正確的 JSON')
    expect(() => parseChunkResponse('{"highlights":[{"startLine":1', chunk)).toThrow('回應不是正確的 JSON')
    expect(() => parseChunkResponse('{"items":[]}', chunk)).toThrow('回應的 JSON 欄位不對')
    expect(() => parseChunkResponse(answer([{ startLine: '1', endLine: 2, reason: 'x', score: 8 }]), chunk)).toThrow('欄位不對')
  })

  it('accepts an empty list', () => {
    expect(parseChunkResponse(answer([]), chunk)).toEqual([])
  })
})

describe('dedupeMoments', () => {
  const m = (start: number, end: number, score: number, reason = `${start}`): TranscriptMoment => ({ start, end, score, reason })

  it('keeps overlapping moments: a partial and a full detection of one event cover the union', () => {
    // chunk 1 ends at 600 s and cuts the event off; chunk 2 (60 s overlap) sees all of it
    const partial = m(560, 600, (8 - 1) / 9, 'cut off')
    const full = m(555, 625, (7 - 1) / 9, 'whole')
    const moments = dedupeMoments([partial, full])
    expect(moments).toEqual([full, partial])
    const track = momentsTrack(moments, 700)
    expect(track[557]).toBeCloseTo(6 / 9, 5)
    expect(track[580]).toBeCloseTo(7 / 9, 5) // overlaps take the max
    expect(track[610]).toBeCloseTo(6 / 9, 5)
    // nested: the wider, lower one still counts outside the short, higher one
    const nested = momentsTrack(dedupeMoments([m(100, 140, 5 / 9), m(130, 135, 7 / 9)]), 200)
    expect(nested[110]).toBeCloseTo(5 / 9, 5)
    expect(nested[132]).toBeCloseTo(7 / 9, 5)
  })

  it('removes exact duplicates from overlapping chunks, keeping the higher score (the first on a tie), sorted by start', () => {
    expect(dedupeMoments([m(5, 9, 0.7, 'a'), m(5, 9, 0.7, 'b')])).toEqual([m(5, 9, 0.7, 'a')])
    expect(dedupeMoments([m(30, 40, 0.5), m(5, 9, 0.6, 'low'), m(5, 9, 0.9, 'high')])).toEqual([m(5, 9, 0.9, 'high'), m(30, 40, 0.5)])
  })
})

describe('subtractSpans', () => {
  it('keeps the parts outside every cut, sorted and merged', () => {
    expect(subtractSpans([{ start: 540, end: 1139 }, { start: 1080, end: 1499 }], [{ start: 0, end: 599 }])).toEqual([{ start: 599, end: 1499 }])
    expect(subtractSpans([{ start: 0, end: 100 }], [{ start: 20, end: 30 }, { start: 50, end: 60 }])).toEqual([
      { start: 0, end: 20 }, { start: 30, end: 50 }, { start: 60, end: 100 },
    ])
    expect(subtractSpans([{ start: 10, end: 20 }], [{ start: 0, end: 30 }])).toEqual([])
    expect(subtractSpans([], [{ start: 0, end: 30 }])).toEqual([])
  })
})

describe('readTranscriptWithLlm against the fake Ollama', () => {
  it('sends the documented request for each chunk and unloads the model afterwards', async () => {
    const config = await startFake()
    const { promise } = run(config, shortTranscript)
    const result = await promise
    expect(result.state).toEqual({ kind: 'transcript', status: 'used', reason: null })
    expect(result.model).toBe(MODEL)

    expect(fake!.requests.map(r => `${r.method} ${r.path}`)).toEqual(['GET /api/version', 'GET /api/tags', 'POST /api/chat', 'POST /api/chat'])
    const body = chatRequests()[0]!.body
    expect(body.model).toBe(MODEL)
    expect(body.think).toBe(false)
    expect(body.stream).toBe(true)
    expect(body.keep_alive).toBe('1m')
    expect(body.format).toEqual(chunkSchema(4))
    expect(body.options).toEqual({ num_ctx: 16384, temperature: 0.2, top_p: 0.8, top_k: 20, presence_penalty: 0, num_predict: 768, seed: 42 })
    expect(body.messages).toEqual(buildChunkMessages({ firstLine: 0, lines: shortTranscript }))
    expect(unloadRequests().map(r => r.body)).toEqual([{ model: MODEL, messages: [], keep_alive: 0 }])
    expect(fake!.requests.at(-1)!.body.keep_alive).toBe(0)
  })

  it('maps highlights to seconds with Traditional Chinese reasons', async () => {
    const config = await startFake()
    const result = await run(config, shortTranscript).promise
    // The fake picks line 3 (哈哈哈) and spans lines 3–4.
    expect(result.moments).toEqual([{ start: 6, end: 11, score: 7 / 9, reason: '大家笑成一團的反應' }])
  })

  it('reads a 25-minute Transcript in three chunks and merges duplicates from the overlap', async () => {
    const config = await startFake()
    const { promise, progress } = run(config, longTranscript())
    const result = await promise
    const chats = chatRequests()
    expect(chats).toHaveLength(3)
    expect(chats.map(r => r.body.format.properties.highlights.items.properties.endLine.maximum)).toEqual([120, 120, 84])
    expect(new Set(chats.map(r => r.body.options.num_ctx))).toEqual(new Set([16384]))
    expect(chats[1]!.body.messages[1].content.split('\n')[1]).toBe('1|第108句平常的對話')

    // Line 112 (560 s) lies in the overlap of chunks 1 and 2: reported twice, kept once.
    expect(result.moments).toEqual([
      { start: 100, end: 109, score: 7 / 9, reason: '大家笑成一團的反應' },
      { start: 560, end: 569, score: 7 / 9, reason: '這波操作太扯了' },
      { start: 1250, end: 1259, score: 7 / 9, reason: '大家笑成一團的反應' },
    ])
    expect(result.state.status).toBe('used')
    expect(progress).toEqual([0, 1 / 3, 2 / 3, 1])
    expect(unloadRequests()).toHaveLength(1)
  })

  it('is used with no moments when the model finds nothing', async () => {
    const config = await startFake({ scenario: 'empty' })
    const result = await run(config, shortTranscript).promise
    expect(result).toEqual({ state: { kind: 'transcript', status: 'used', reason: null }, moments: [], unread: [], model: MODEL })
  })

  it.each([
    ['invalid-json', 'AI 讀逐字稿失敗：回應不是正確的 JSON'],
    ['length', 'AI 讀逐字稿失敗：回應太長被截斷'],
    ['http500', 'AI 讀逐字稿失敗：Ollama 回應錯誤（HTTP 500）：llama runner process has terminated: exit status 2'],
  ] as const)('retries a failing chunk once at temperature 0, then is missing (%s)', async (scenario, reason) => {
    const config = await startFake({ scenario })
    const { promise, logs, progress } = run(config, shortTranscript)
    const result = await promise
    expect(result).toEqual({ state: { kind: 'transcript', status: 'missing', reason }, moments: [], unread: [], model: MODEL })
    expect(chatRequests().map(r => r.body.options.temperature)).toEqual([0.2, 0])
    expect(chatRequests()[1]!.body.options).toEqual({ ...CHAT_OPTIONS, temperature: 0 })
    expect(unloadRequests()).toHaveLength(1)
    expect(logs.some(l => l.includes('temperature 0 重試'))).toBe(true)
    expect(progress.at(-1)).toBe(1)
  })

  it('keeps the chunk when the retry succeeds', async () => {
    const config = await startFake({ scenario: 'invalid-json' })
    const { promise } = run(config, shortTranscript, {
      log: (m) => { if (m.includes('重試')) fake!.setScenario('ok') },
    })
    const result = await promise
    expect(result.state).toEqual({ kind: 'transcript', status: 'used', reason: null })
    expect(result.moments).toHaveLength(1)
    expect(chatRequests()).toHaveLength(2)
  })

  it('is used with a caveat when only some chunks fail', async () => {
    const config = await startFake()
    let done = 0
    const { promise } = run(config, longTranscript(), {
      onProgress: (f) => { if (f > 0 && ++done === 1) fake!.setScenario('http500') },
    })
    const result = await promise
    expect(result.state).toEqual({ kind: 'transcript', status: 'used', reason: '2 個區段讀取失敗' })
    expect(result.moments.map(m => m.start)).toEqual([100, 560])
    // chunks: [0, 599] read; [540, 1139] and [1080, 1499] skipped → the AI said nothing about 599–1499
    expect(result.unread).toEqual([{ start: 599, end: 1499 }])
    expect(chatRequests()).toHaveLength(1 + 2 * 2)
    expect(unloadRequests()).toHaveLength(1)
  })

  it('times out a hanging chunk, retries, then is missing', async () => {
    const config = await startFake({ scenario: 'hang' })
    const result = await run(config, shortTranscript, { chunkTimeoutMs: 100 }).promise
    expect(result.state).toEqual({ kind: 'transcript', status: 'missing', reason: 'AI 讀逐字稿失敗：回應逾時' })
    expect(chatRequests()).toHaveLength(2)
    expect(unloadRequests()).toHaveLength(1)
  })

  it.each([
    ['model-missing', 'Ollama 裡還沒有 qwen3.5:9b 模型，請執行 ollama pull qwen3.5:9b'],
    ['old-version', 'Ollama 版本 0.20.0 太舊，需要 0.31.2 以上，請更新 Ollama'],
  ] as const)('is missing without reading when the probe fails (%s)', async (scenario, reason) => {
    const config = await startFake({ scenario })
    const result = await run(config, shortTranscript).promise
    expect(result).toEqual({ state: { kind: 'transcript', status: 'missing', reason }, moments: [], unread: [], model: MODEL })
    expect(chatRequests()).toHaveLength(0)
  })

  it('is missing when nothing listens at the URL', async () => {
    const url = await closedPortUrl()
    const result = await run({ url, model: MODEL }, shortTranscript).promise
    expect(result.state).toEqual({ kind: 'transcript', status: 'missing', reason: `連不到 Ollama（${url}），請確認 Ollama 已啟動` })
  })

  it('is missing without any request when disabled or the Transcript is empty', async () => {
    let fetches = 0
    const countingFetch = (async () => { fetches++ }) as unknown as typeof fetch
    const disabled = await run({ url: null, model: MODEL }, shortTranscript, { fetch: countingFetch }).promise
    expect(disabled.state).toEqual({ kind: 'transcript', status: 'missing', reason: '已關閉 AI 讀逐字稿（GG_OLLAMA_URL=off）' })
    const empty = await run({ url: 'http://127.0.0.1:9', model: MODEL }, [{ start: 0, end: 1, text: ' ' }], { fetch: countingFetch }).promise
    expect(empty.state).toEqual({ kind: 'transcript', status: 'missing', reason: '逐字稿沒有內容' })
    expect(fetches).toBe(0)
  })

  it('rejects with the abort reason within a second during a hanging chunk, and still unloads', async () => {
    const config = await startFake({ scenario: 'hang' })
    const controller = new AbortController()
    const reason = new Error('使用者取消')
    const { promise } = run(config, shortTranscript, { signal: controller.signal })
    const settled = promise.then(() => 'resolved', e => e)
    await waitFor(() => chatRequests().length === 1)
    const abortedAt = Date.now()
    controller.abort(reason)
    expect(await settled).toBe(reason)
    expect(Date.now() - abortedAt).toBeLessThan(1000)
    expect(chatRequests()).toHaveLength(1) // no retry after a cancel
    expect(unloadRequests().map(r => r.body)).toEqual([{ model: MODEL, messages: [], keep_alive: 0 }])
  })

  it('rejects right away when the signal is already aborted', async () => {
    const config = await startFake()
    const controller = new AbortController()
    const reason = new Error('shutdown')
    controller.abort(reason)
    await expect(run(config, shortTranscript, { signal: controller.signal }).promise).rejects.toBe(reason)
    expect(fake!.requests).toHaveLength(0)
  })

  it('keeps going when a listener throws', async () => {
    const config = await startFake()
    const result = await run(config, shortTranscript, {
      onProgress: () => { throw new Error('listener bug') },
      log: () => { throw new Error('listener bug') },
    }).promise
    expect(result.state.status).toBe('used')
  })
})
