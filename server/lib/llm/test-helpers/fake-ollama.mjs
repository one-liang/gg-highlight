// Fake Ollama HTTP server for unit, integration and e2e tests (no dependencies, plain ESM).
// The real Ollama cannot run in the cloud test environment (design.md「測試」).
//
//   import { startFakeOllama } from './fake-ollama.mjs'
//   const ollama = await startFakeOllama({ scenario: 'ok' })   // → { url, requests, setScenario, close }
//
//   node fake-ollama.mjs --port 0 --scenario ok   # prints {"url": "..."} and runs until killed
//
// Endpoints: GET /api/version, GET /api/tags, POST /api/show, GET /api/ps, POST /api/chat
// (streaming NDJSON split over several writes, or one JSON object with stream:false; empty messages
// with keep_alive 0 → unload reply). Test control: POST /__scenario {scenario}, GET /__requests.
// Anything else → 404 JSON.
//
// Scenarios:
//   ok             deterministic highlights from the 'n|text' lines of the last user message
//   empty          {"highlights": []}
//   invalid-json   content that is not JSON
//   length         truncated JSON with done_reason 'length'
//   http500        chat → 500 {"error"}
//   hang           chat never answers until the client aborts (version/tags/unload still answer)
//   model-missing  tags without the model; chat (and unload) → 404 "model 'X' not found"
//   old-version    /api/version → 0.20.0
import http from 'node:http'
import { pathToFileURL } from 'node:url'

export const SCENARIOS = Object.freeze(['ok', 'empty', 'invalid-json', 'length', 'http500', 'hang', 'model-missing', 'old-version'])
export const OLD_VERSION = '0.20.0'

/** Lines whose text contains one of these become highlights in the 'ok' scenario. */
const EXCITING = /哈|笑|扯|快|啊|wow|amazing|nice|shot|game/i
/** Simplified Chinese on purpose, so the client's OpenCC conversion and reason cleanup are exercised. */
const OK_REASONS = ['大家笑成一团的反应', '「这波操作太扯了」！后面还有']

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Ollama's names default to the ':latest' tag. */
function withTag(name) {
  const last = name.slice(name.lastIndexOf('/') + 1)
  return last.includes(':') ? name : `${name}:latest`
}

function assertScenario(scenario) {
  if (!SCENARIOS.includes(scenario)) throw new Error(`unknown fake Ollama scenario: ${scenario}`)
  return scenario
}

/** The 'n|text' lines of the last user message, as [{ n, text }]. */
export function transcriptLinesOf(messages) {
  const user = [...(Array.isArray(messages) ? messages : [])].reverse().find(m => m?.role === 'user')
  if (!user || typeof user.content !== 'string') return []
  const lines = []
  for (const line of user.content.split('\n')) {
    const m = /^(\d+)\|(.*)$/.exec(line.trim())
    if (m) lines.push({ n: Number(m[1]), text: m[2] })
  }
  return lines
}

/** The 'ok' answer: up to 2 non-overlapping highlights of 1–2 lines each, score 8. */
export function okHighlights(lines) {
  if (lines.length === 0) return []
  const last = lines[lines.length - 1].n
  const picks = lines.filter(l => EXCITING.test(l.text)).map(l => l.n)
  if (picks.length === 0) picks.push(lines[0].n)
  const highlights = []
  let taken = 0
  for (const n of picks) {
    if (highlights.length === 2) break
    if (n <= taken) continue
    const endLine = Math.min(n + 1, last)
    highlights.push({ startLine: n, endLine, reason: OK_REASONS[highlights.length], score: 8 })
    taken = endLine
  }
  return highlights
}

function chatContent(scenario, body) {
  switch (scenario) {
    case 'empty':
      return { content: JSON.stringify({ highlights: [] }), doneReason: 'stop' }
    case 'invalid-json':
      return { content: '好的，以下是精彩片段：第 1 行到第 2 行', doneReason: 'stop' }
    case 'length':
      return { content: '{"highlights":[{"startLine":1,"endLine":2,"reason":"大家笑成一团', doneReason: 'length' }
    default:
      return { content: JSON.stringify({ highlights: okHighlights(transcriptLinesOf(body?.messages)) }), doneReason: 'stop' }
  }
}

function isUnload(body) {
  const keepAlive = body?.keep_alive
  return (!Array.isArray(body?.messages) || body.messages.length === 0)
    && (keepAlive === 0 || keepAlive === '0' || keepAlive === '0s')
}

/** Splits text into `parts` pieces at code point boundaries. */
function splitText(text, parts) {
  const chars = Array.from(text)
  const size = Math.max(1, Math.ceil(chars.length / parts))
  const pieces = []
  for (let i = 0; i < chars.length; i += size) pieces.push(chars.slice(i, i + size).join(''))
  return pieces.length ? pieces : ['']
}

export async function startFakeOllama({ port = 0, scenario = 'ok', version = '0.40.15', models = ['qwen3.5:9b'], delayMs = 0 } = {}) {
  let current = assertScenario(scenario)
  const requests = []
  const loaded = new Set()
  const sockets = new Set()

  const listedModels = () => (current === 'model-missing' ? [] : models.map(withTag))
  const hasModel = name => typeof name === 'string' && listedModels().includes(withTag(name))

  function sendJson(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }

  const modelEntry = name => ({
    name,
    model: name,
    modified_at: '2026-10-01T12:00:00Z',
    size: 6_600_000_000,
    digest: 'fake0000000000000000000000000000000000000000000000000000000000000',
    details: { format: 'gguf', family: 'qwen35', families: ['qwen35'], parameter_size: '9.7B', quantization_level: 'Q4_K_M' },
  })

  function chatLine(model, content, extra = {}) {
    return `${JSON.stringify({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content }, done: false, ...extra })}\n`
  }

  async function streamReply(res, model, content, doneReason) {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    const lines = splitText(content, 4).map(piece => chatLine(model, piece))
    lines.push(chatLine(model, '', { done: true, done_reason: doneReason, total_duration: 1_000_000, eval_count: 42 }))
    for (const line of lines) {
      // Write each line in two halves so clients must buffer partial lines.
      const half = Math.ceil(line.length / 2)
      for (const part of [line.slice(0, half), line.slice(half)]) {
        if (res.destroyed) return
        res.write(part)
        await sleep(2)
      }
    }
    res.end()
  }

  async function handleChat(req, res, body) {
    const model = body?.model
    if (!hasModel(model)) return sendJson(res, 404, { error: `model '${model}' not found` })
    if (isUnload(body)) {
      loaded.delete(withTag(model))
      return sendJson(res, 200, { model, created_at: new Date().toISOString(), message: { role: 'assistant', content: '' }, done_reason: 'unload', done: true })
    }
    loaded.add(withTag(model))
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return sendJson(res, 200, { model, created_at: new Date().toISOString(), message: { role: 'assistant', content: '' }, done_reason: 'load', done: true })
    }
    if (current === 'hang') return // never answer; the socket closes when the client aborts or on close()
    if (delayMs > 0) await sleep(delayMs)
    if (res.destroyed) return
    if (current === 'http500') return sendJson(res, 500, { error: 'llama runner process has terminated: exit status 2' })
    const { content, doneReason } = chatContent(current, body)
    if (body.stream === false) {
      return sendJson(res, 200, { model, created_at: new Date().toISOString(), message: { role: 'assistant', content }, done_reason: doneReason, done: true })
    }
    await streamReply(res, model, content, doneReason)
  }

  async function route(req, res, path, body) {
    const method = req.method ?? 'GET'
    if (method === 'GET' && path === '/api/version') return sendJson(res, 200, { version: current === 'old-version' ? OLD_VERSION : version })
    if (method === 'GET' && path === '/api/tags') return sendJson(res, 200, { models: listedModels().map(modelEntry) })
    if (method === 'GET' && path === '/api/ps') {
      return sendJson(res, 200, { models: [...loaded].map(name => ({ ...modelEntry(name), expires_at: '2026-10-01T12:10:00Z', size_vram: 6_000_000_000 })) })
    }
    if (method === 'POST' && path === '/api/show') {
      const name = body?.model ?? body?.name
      if (!hasModel(name)) return sendJson(res, 404, { error: `model '${name}' not found` })
      return sendJson(res, 200, {
        modelfile: '', parameters: 'temperature 1\npresence_penalty 1.5', template: '{{ .Prompt }}',
        details: modelEntry(withTag(name)).details, capabilities: ['completion', 'vision', 'tools', 'thinking'],
        model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 262144 },
      })
    }
    if (method === 'POST' && path === '/api/chat') return handleChat(req, res, body)
    if (method === 'POST' && path === '/__scenario') {
      try {
        current = assertScenario(body?.scenario)
      }
      catch (err) {
        return sendJson(res, 400, { error: err.message })
      }
      return sendJson(res, 200, { ok: true, scenario: current })
    }
    if (method === 'GET' && path === '/__requests') return sendJson(res, 200, { requests })
    return sendJson(res, 404, { error: `404 page not found: ${method} ${path}` })
  }

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://fake').pathname
      const text = Buffer.concat(chunks).toString('utf8')
      let body = null
      if (text) {
        try {
          body = JSON.parse(text)
        }
        catch {
          sendJson(res, 400, { error: 'invalid JSON body' })
          return
        }
      }
      if (!path.startsWith('/__')) requests.push({ method: req.method ?? 'GET', path, body })
      route(req, res, path, body).catch((err) => {
        if (!res.headersSent) sendJson(res, 500, { error: String(err?.message ?? err) })
        else res.destroy()
      })
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}`

  return {
    url,
    requests,
    setScenario(next) {
      current = assertScenario(next)
    },
    close() {
      return new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
    },
  }
}

function parseCliArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const eq = token.indexOf('=')
    const key = eq > 0 ? token.slice(2, eq) : token.slice(2)
    options[key] = eq > 0 ? token.slice(eq + 1) : argv[++i]
  }
  return {
    port: options.port !== undefined ? Number(options.port) : 0,
    scenario: options.scenario ?? 'ok',
    version: options.version ?? '0.40.15',
    models: options.models ? options.models.split(',').filter(Boolean) : ['qwen3.5:9b'],
    delayMs: options['delay-ms'] !== undefined ? Number(options['delay-ms']) : 0,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fake = await startFakeOllama(parseCliArgs(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify({ url: fake.url })}\n`)
  const stop = () => fake.close().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
