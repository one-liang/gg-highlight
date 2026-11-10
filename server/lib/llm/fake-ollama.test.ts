import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { okHighlights, startFakeOllama, transcriptLinesOf } from './test-helpers/fake-ollama.mjs'
import type { FakeOllama } from './test-helpers/fake-ollama.mjs'

const FAKE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-helpers', 'fake-ollama.mjs')
let fake: FakeOllama | null = null
let child: ChildProcess | null = null

afterEach(async () => {
  await fake?.close()
  fake = null
  child?.kill()
  child = null
})

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', body: JSON.stringify(body) })
const userMessage = (content: string) => [{ role: 'system', content: 'x' }, { role: 'user', content }]

describe('fake Ollama helpers', () => {
  it('reads n|text lines from the last user message', () => {
    expect(transcriptLinesOf(userMessage('以下是逐字稿：\n1|大家好\n2|a|b\nnot a line'))).toEqual([
      { n: 1, text: '大家好' }, { n: 2, text: 'a|b' },
    ])
    expect(transcriptLinesOf([])).toEqual([])
  })

  it('picks up to two non-overlapping exciting lines, or else the first line', () => {
    const lines = ['平常', '哈哈', '好快', '平常', 'nice shot', 'game over'].map((text, i) => ({ n: i + 1, text }))
    expect(okHighlights(lines).map(h => [h.startLine, h.endLine, h.score])).toEqual([[2, 3, 8], [5, 6, 8]])
    expect(okHighlights([{ n: 1, text: '平常' }, { n: 2, text: '還是平常' }]).map(h => [h.startLine, h.endLine])).toEqual([[1, 2]])
    expect(okHighlights([{ n: 1, text: 'WOW' }]).map(h => [h.startLine, h.endLine])).toEqual([[1, 1]])
    expect(okHighlights([])).toEqual([])
  })
})

describe('startFakeOllama', () => {
  it('answers a non-streaming chat with one JSON object', async () => {
    fake = await startFakeOllama()
    const res = await post(`${fake.url}/api/chat`, { model: 'qwen3.5:9b', stream: false, messages: userMessage('1|哈哈') })
    const body = await res.json()
    expect(body).toMatchObject({ done: true, done_reason: 'stop', message: { role: 'assistant' } })
    expect(JSON.parse(body.message.content).highlights).toHaveLength(1)
  })

  it('switches scenarios at runtime over HTTP and rejects unknown ones', async () => {
    fake = await startFakeOllama()
    expect((await post(`${fake.url}/__scenario`, { scenario: 'old-version' })).status).toBe(200)
    expect(await (await fetch(`${fake.url}/api/version`)).json()).toEqual({ version: '0.20.0' })
    expect((await post(`${fake.url}/__scenario`, { scenario: 'nope' })).status).toBe(400)
    expect(() => fake!.setScenario('nope' as never)).toThrow('unknown fake Ollama scenario')
    const { requests } = await (await fetch(`${fake.url}/__requests`)).json()
    expect(requests).toEqual([{ method: 'GET', path: '/api/version', body: null }])
  })

  it('serves /api/show and /api/ps, tracks load and unload, and 404s anything else', async () => {
    fake = await startFakeOllama({ models: ['qwen3'] })
    expect((await post(`${fake.url}/api/show`, { model: 'qwen3' })).status).toBe(200)
    expect((await post(`${fake.url}/api/show`, { model: 'llama3' })).status).toBe(404)
    await (await post(`${fake.url}/api/chat`, { model: 'qwen3', messages: userMessage('1|x') })).text()
    expect((await (await fetch(`${fake.url}/api/ps`)).json()).models.map((m: { name: string }) => m.name)).toEqual(['qwen3:latest'])
    const unload = await (await post(`${fake.url}/api/chat`, { model: 'qwen3', messages: [], keep_alive: 0 })).json()
    expect(unload).toMatchObject({ done: true, done_reason: 'unload' })
    expect((await (await fetch(`${fake.url}/api/ps`)).json()).models).toEqual([])
    const missing = await fetch(`${fake.url}/api/generate`)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toHaveProperty('error')
  })

  it('runs as a CLI that prints its URL', async () => {
    child = spawn(process.execPath, [FAKE_PATH, '--port', '0', '--scenario', 'model-missing'], { stdio: ['ignore', 'pipe', 'inherit'] })
    const first = await new Promise<string>((resolve, reject) => {
      readline.createInterface({ input: child!.stdout! }).once('line', resolve)
      child!.once('exit', code => reject(new Error(`fake exited with ${code}`)))
    })
    const { url } = JSON.parse(first) as { url: string }
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(await (await fetch(`${url}/api/tags`)).json()).toEqual({ models: [] })
  })
})
