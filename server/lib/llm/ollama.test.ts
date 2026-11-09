import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  chatStream, describeOllamaProbe, isOlderVersion, normalizeModelName, OllamaError, OllamaStreamError, OllamaTimeoutError,
  parseVersion, probeOllama, unloadModel,
} from './ollama'
import { startFakeOllama } from './test-helpers/fake-ollama.mjs'
import type { FakeOllama, FakeOllamaOptions } from './test-helpers/fake-ollama.mjs'
import type { OllamaConfig } from './types'

const MODEL = 'qwen3.5:9b'
let fake: FakeOllama | null = null
const servers: http.Server[] = []

afterEach(async () => {
  await fake?.close()
  fake = null
  await Promise.all(servers.splice(0).map(s => new Promise(resolve => s.close(resolve))))
})

async function startFake(opts: FakeOllamaOptions = {}): Promise<OllamaConfig> {
  fake = await startFakeOllama(opts)
  return { url: fake.url, model: MODEL }
}

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  server.on('connection', socket => server.once('close', () => socket.destroy()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function closedPortUrl(): Promise<string> {
  const server = http.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise(resolve => server.close(resolve))
  return `http://127.0.0.1:${port}`
}

/** A fetch whose response body arrives in the given byte pieces. */
function streamingFetch(pieces: Uint8Array[], status = 200): typeof fetch {
  return (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(piece)
      controller.close()
    },
  }), { status })) as typeof fetch
}

describe('version and model helpers', () => {
  it('parses and compares versions', () => {
    expect(parseVersion('0.31.2')).toEqual([0, 31, 2])
    expect(parseVersion('v0.40.15-rc1')).toEqual([0, 40, 15])
    expect(parseVersion('0.32')).toEqual([0, 32, 0])
    expect(parseVersion('dev')).toBeNull()
    expect(isOlderVersion('0.20.0', '0.31.2')).toBe(true)
    expect(isOlderVersion('0.31.1', '0.31.2')).toBe(true)
    expect(isOlderVersion('0.31.2', '0.31.2')).toBe(false)
    expect(isOlderVersion('0.40.15', '0.31.2')).toBe(false)
    expect(isOlderVersion('1.0.0', '0.31.2')).toBe(false)
    expect(isOlderVersion('weird', '0.31.2')).toBe(false)
  })

  it('treats a name without a tag as :latest', () => {
    expect(normalizeModelName('qwen3.5')).toBe('qwen3.5:latest')
    expect(normalizeModelName('Qwen3.5:9B')).toBe('qwen3.5:9b')
    expect(normalizeModelName('localhost:5000/team/model')).toBe('localhost:5000/team/model:latest')
    expect(normalizeModelName('hf.co/user/repo:Q4_K_M')).toBe('hf.co/user/repo:q4_k_m')
  })
})

describe('probeOllama', () => {
  it('is ready when the version is new enough and the model is pulled', async () => {
    const config = await startFake()
    expect(await probeOllama(config)).toEqual({ status: 'ready', version: '0.40.15' })
    expect(fake!.requests.map(r => `${r.method} ${r.path}`)).toEqual(['GET /api/version', 'GET /api/tags'])
  })

  it('treats x and x:latest as the same model', async () => {
    fake = await startFakeOllama({ models: ['qwen3', 'gemma3:latest'] })
    expect((await probeOllama({ url: fake.url, model: 'qwen3:latest' })).status).toBe('ready')
    expect((await probeOllama({ url: fake.url, model: 'gemma3' })).status).toBe('ready')
    expect((await probeOllama({ url: fake.url, model: 'qwen3:8b' })).status).toBe('model-missing')
  })

  it('reports disabled without any request', async () => {
    let called = false
    const result = await probeOllama({ url: null, model: MODEL }, { fetch: (async () => { called = true }) as unknown as typeof fetch })
    expect(result).toEqual({ status: 'disabled', version: null })
    expect(called).toBe(false)
  })

  it('reports unreachable for a closed port', async () => {
    expect(await probeOllama({ url: await closedPortUrl(), model: MODEL })).toEqual({ status: 'unreachable', version: null })
  })

  it('reports unreachable within the timeout when nothing answers', async () => {
    const url = await listen(() => {}) // accepts, never answers
    const started = Date.now()
    expect(await probeOllama({ url, model: MODEL }, { timeoutMs: 200 })).toEqual({ status: 'unreachable', version: null })
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('reports unreachable for a server that is not Ollama', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html></html>')
    })
    expect((await probeOllama({ url, model: MODEL })).status).toBe('unreachable')
  })

  it('reports outdated with the version', async () => {
    const config = await startFake({ scenario: 'old-version' })
    expect(await probeOllama(config)).toEqual({ status: 'outdated', version: '0.20.0' })
  })

  it('reports model-missing with the version', async () => {
    const config = await startFake({ scenario: 'model-missing' })
    expect(await probeOllama(config)).toEqual({ status: 'model-missing', version: '0.40.15' })
  })

  it('never throws, even when the caller aborts', async () => {
    const config = await startFake()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    expect((await probeOllama(config, { signal: controller.signal })).status).toBe('unreachable')
  })
})

describe('describeOllamaProbe', () => {
  const config = { url: 'http://127.0.0.1:11434', model: MODEL }
  it('says what to do for each status', () => {
    expect(describeOllamaProbe(config, { status: 'ready', version: '0.40.15' })).toBeNull()
    expect(describeOllamaProbe({ url: null, model: MODEL }, { status: 'disabled', version: null }))
      .toBe('已關閉 AI 讀逐字稿（GG_OLLAMA_URL=off）')
    expect(describeOllamaProbe(config, { status: 'unreachable', version: null }))
      .toBe('連不到 Ollama（http://127.0.0.1:11434），請確認 Ollama 已啟動')
    expect(describeOllamaProbe(config, { status: 'outdated', version: '0.20.0' }))
      .toBe('Ollama 版本 0.20.0 太舊，需要 0.31.2 以上，請更新 Ollama')
    expect(describeOllamaProbe(config, { status: 'model-missing', version: '0.40.15' }))
      .toBe('Ollama 裡還沒有 qwen3.5:9b 模型，請執行 ollama pull qwen3.5:9b')
  })
})

describe('chatStream', () => {
  const messages = [{ role: 'user' as const, content: '1|哈哈哈\n2|好扯' }]

  it('posts stream:true with the model and joins the NDJSON content split over many writes', async () => {
    const config = await startFake()
    const result = await chatStream(config, { messages, think: false, keep_alive: '10m' })
    expect(result.doneReason).toBe('stop')
    expect(JSON.parse(result.content)).toEqual({
      highlights: [{ startLine: 1, endLine: 2, reason: '大家笑成一团的反应', score: 8 }],
    })
    const body = fake!.requests[0]!.body
    expect(body).toMatchObject({ model: MODEL, messages, think: false, keep_alive: '10m', stream: true })
  })

  it('decodes lines and multi-byte characters split at any byte', async () => {
    const text = [
      JSON.stringify({ message: { content: '大家' }, done: false }),
      JSON.stringify({ message: { content: '笑了' }, done: false }),
      JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop' }),
    ].join('\n')
    const bytes = new TextEncoder().encode(text) // no trailing newline on the last line
    const pieces = Array.from(bytes, b => Uint8Array.of(b))
    const result = await chatStream({ url: 'http://x', model: MODEL }, { messages }, { fetch: streamingFetch(pieces) })
    expect(result).toEqual({ content: '大家笑了', doneReason: 'stop' })
  })

  it('maps HTTP errors to OllamaError with the server message', async () => {
    const config = await startFake({ scenario: 'http500' })
    const err = await chatStream(config, { messages }).catch(e => e)
    expect(err).toBeInstanceOf(OllamaError)
    expect(err).toMatchObject({ status: 500, message: 'llama runner process has terminated: exit status 2' })

    fake!.setScenario('model-missing')
    await expect(chatStream(config, { messages })).rejects.toMatchObject({ status: 404, message: `model '${MODEL}' not found` })
  })

  it('maps an {"error"} line inside a 200 stream to OllamaError', async () => {
    const lines = new TextEncoder().encode(`${JSON.stringify({ message: { content: 'x' }, done: false })}\n{"error":"boom"}\n`)
    await expect(chatStream({ url: 'http://x', model: MODEL }, { messages }, { fetch: streamingFetch([lines]) }))
      .rejects.toMatchObject({ name: 'OllamaError', status: 200, message: 'boom' })
  })

  it('rejects with OllamaStreamError when the stream ends without done or has a broken line', async () => {
    const noDone = new TextEncoder().encode(`${JSON.stringify({ message: { content: 'x' }, done: false })}\n`)
    await expect(chatStream({ url: 'http://x', model: MODEL }, { messages }, { fetch: streamingFetch([noDone]) }))
      .rejects.toBeInstanceOf(OllamaStreamError)
    const broken = new TextEncoder().encode('{"message":\n')
    await expect(chatStream({ url: 'http://x', model: MODEL }, { messages }, { fetch: streamingFetch([broken]) }))
      .rejects.toBeInstanceOf(OllamaStreamError)
  })

  it('times out with OllamaTimeoutError', async () => {
    const config = await startFake({ scenario: 'hang' })
    const started = Date.now()
    const err = await chatStream(config, { messages }, { timeoutMs: 150 }).catch(e => e)
    expect(err).toBeInstanceOf(OllamaTimeoutError)
    expect(err.timeoutMs).toBe(150)
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('rejects with the abort reason (not a timeout) when the caller aborts', async () => {
    const config = await startFake({ scenario: 'hang' })
    const controller = new AbortController()
    const reason = new Error('cancelled by user')
    setTimeout(() => controller.abort(reason), 50)
    await expect(chatStream(config, { messages }, { signal: controller.signal, timeoutMs: 60_000 })).rejects.toBe(reason)
  })

  it('rejects with the abort reason while the body is streaming', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled mid-stream')
    const fetchMock = (async (_url: string, init: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(`${JSON.stringify({ message: { content: 'x' }, done: false })}\n`))
        init.signal!.addEventListener('abort', () => c.error(init.signal!.reason))
        setTimeout(() => controller.abort(reason), 20)
      },
    }))) as unknown as typeof fetch
    await expect(chatStream({ url: 'http://x', model: MODEL }, { messages }, { signal: controller.signal, fetch: fetchMock }))
      .rejects.toBe(reason)
  })
})

describe('unloadModel', () => {
  it('sends { model, messages: [], keep_alive: 0 } and resolves true', async () => {
    const config = await startFake()
    expect(await unloadModel(config)).toBe(true)
    expect(fake!.requests).toEqual([{ method: 'POST', path: '/api/chat', body: { model: MODEL, messages: [], keep_alive: 0 } }])
  })

  it('still answers while generation would hang', async () => {
    const config = await startFake({ scenario: 'hang' })
    expect(await unloadModel(config)).toBe(true)
  })

  it('never throws: closed port, HTTP error, no answer, disabled', async () => {
    const logs: string[] = []
    expect(await unloadModel({ url: await closedPortUrl(), model: MODEL }, { log: m => logs.push(m) })).toBe(false)
    const config = await startFake({ scenario: 'model-missing' })
    expect(await unloadModel(config, { log: m => logs.push(m) })).toBe(false)
    const silent = await listen(() => {})
    const started = Date.now()
    expect(await unloadModel({ url: silent, model: MODEL }, { timeoutMs: 100 })).toBe(false)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(await unloadModel({ url: null, model: MODEL })).toBe(false)
    expect(logs).toHaveLength(2)
    expect(logs[1]).toContain('404')
  })
})
