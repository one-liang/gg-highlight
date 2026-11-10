import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isOlderVersion, normalizeModelName } from '../server/lib/llm/ollama'
import * as llmTypes from '../server/lib/llm/types'
import {
  checkDataDir,
  checkFfmpeg,
  checkFonts,
  checkNode,
  checkNvenc,
  checkNvidiaSmi,
  checkOllama,
  checkPnpm,
  checkTranscriber,
  checkUv,
  checkYtdlp,
  createContext,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  exitCodeFor,
  formatReport,
  hasLibass,
  MIN_OLLAMA_VERSION,
  normalizeOllamaModel,
  ollamaConfig,
  ollamaHasModel,
  ollamaVersionTooOld,
  parseFfmpegVersion,
  parseNvidiaSmi,
  parseTranscriberCheck,
  runChecks,
  summarizeFfmpegError,
  transcriberCommand,
  ytdlpCommand,
} from './doctor.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const ffmpeg = process.env.GG_FFMPEG ?? 'ffmpeg'
const hasFfmpeg = spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status === 0

interface RunResult { ok: boolean, code: number | null, stdout: string, stderr: string, notFound: boolean, timedOut: boolean, error: string | null }
type Call = { command: string, args: string[] }

function ok(stdout = '', stderr = ''): RunResult {
  return { ok: true, code: 0, stdout, stderr, notFound: false, timedOut: false, error: null }
}
function failed(stderr = '', code = 1): RunResult {
  return { ok: false, code, stdout: '', stderr, notFound: false, timedOut: false, error: null }
}
function missing(): RunResult {
  return { ok: false, code: null, stdout: '', stderr: '', notFound: true, timedOut: false, error: 'spawn ENOENT' }
}

/** Fake runner: answers by the longest matching "command arg0 arg1 …" prefix, else `missing`. */
function fakeRun(table: Record<string, RunResult>, calls: Call[] = []) {
  return async (command: string, args: string[] = []) => {
    calls.push({ command, args })
    for (let n = args.length; n >= 0; n--) {
      const key = [command, ...args.slice(0, n)].join(' ')
      if (table[key]) return table[key]
    }
    return missing()
  }
}

let tmp: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gg-doctor-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

/** No Ollama answers: like a closed port. */
const unreachableFetch = async () => {
  throw new TypeError('fetch failed')
}

function ctx(overrides: Record<string, unknown> = {}) {
  return createContext({
    env: {},
    root: tmp,
    fontsDir: path.join(tmp, 'fonts'),
    dataDir: path.join(tmp, 'data'),
    run: fakeRun({}),
    fetch: unreachableFetch,
    hasSqlite: async () => true,
    ...overrides,
  })
}

interface FakeOllamaOptions {
  /** Body of GET /api/version; null → 404. */
  version?: unknown
  /** Model names in GET /api/tags; null → 500. */
  models?: string[] | null
  /** Never answer (to test the timeout). */
  hang?: boolean
}

/** Tiny stand-in for Ollama's GET /api/version and /api/tags. */
async function startFakeOllama(opts: FakeOllamaOptions = {}) {
  const requests: string[] = []
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    if (opts.hang) return
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.url === '/api/version' && opts.version !== null) {
      send(200, opts.version ?? { version: '0.40.15' })
    }
    else if (req.url === '/api/tags' && opts.models !== null) {
      const models = (opts.models ?? ['qwen3.5:9b']).map(name => ({ name, model: name, size: 6_600_000_000 }))
      send(200, { models })
    }
    else if (req.url === '/api/tags') {
      send(500, { error: 'boom' })
    }
    else {
      send(404, { error: 'not found' })
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

describe('parsing', () => {
  it('reads ffmpeg versions from Ubuntu and gyan.dev builds', () => {
    expect(parseFfmpegVersion('ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023')).toBe('6.1.1-3ubuntu5')
    expect(parseFfmpegVersion('ffmpeg version 7.1.1-full_build-www.gyan.dev Copyright')).toBe('7.1.1-full_build-www.gyan.dev')
    expect(parseFfmpegVersion('ffprobe version 2025-01-27-git-959b799c8d-full_build-www.gyan.dev')).toBe('2025-01-27-git-959b799c8d-full_build-www.gyan.dev')
    expect(parseFfmpegVersion('hello')).toBeNull()
  })

  it('detects libass in -buildconf output', () => {
    const conf = 'configuration:\n    --prefix=/usr\n    --enable-gpl\n    --enable-libass\n    --enable-libx264\n'
    expect(hasLibass(conf)).toBe(true)
    expect(hasLibass('  --enable-libx264\n  --disable-libass\n')).toBe(false)
    expect(hasLibass('  --enable-libass-foo\n')).toBe(false)
    expect(hasLibass('')).toBe(false)
  })

  it('reads the check event among noise and errors', () => {
    const out = [
      'Resolved 20 packages',
      '{"type":"log","message":"hello"}',
      '{"type":"check","python":"3.12.7","fasterWhisper":"1.2.1","ctranslate2":"4.8.3","cudaDevices":1}',
      '{broken json',
    ].join('\r\n')
    expect(parseTranscriberCheck(out)).toEqual({
      check: { type: 'check', python: '3.12.7', fasterWhisper: '1.2.1', ctranslate2: '4.8.3', cudaDevices: 1 },
      error: null,
    })
    expect(parseTranscriberCheck('{"type":"error","message":"缺少 ctranslate2"}')).toEqual({ check: null, error: '缺少 ctranslate2' })
    expect(parseTranscriberCheck('{"type":"check","cudaDevices":"x"}').check?.cudaDevices).toBe(0)
    expect(parseTranscriberCheck('')).toEqual({ check: null, error: null })
  })

  it('reads nvidia-smi csv', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 3060 Ti, 560.94\r\n')).toEqual([{ name: 'NVIDIA GeForce RTX 3060 Ti', driver: '560.94' }])
    expect(parseNvidiaSmi('A, 1\nB, 2\n')).toHaveLength(2)
    expect(parseNvidiaSmi('')).toEqual([])
  })

  it('summarises a failed NVENC encode', () => {
    const stderr = [
      '[h264_nvenc @ 0x55b5] Cannot load libcuda.so.1',
      '[vost#0:0/h264_nvenc @ 0x55b5] Error while opening encoder',
      '[out#0/null @ 0x55b5] Nothing was written into output file',
    ].join('\n')
    expect(summarizeFfmpegError(stderr)).toBe('Cannot load libcuda.so.1')
    expect(summarizeFfmpegError('[h264_nvenc @ 0x1] OpenEncodeSessionEx failed: unsupported device (2): (no details)')).toMatch(/^OpenEncodeSessionEx/)
    expect(summarizeFfmpegError('something else\nmore')).toBe('something else')
    expect(summarizeFfmpegError('')).toBe('')
  })

  it('builds the transcriber command like server/lib/config.ts', () => {
    expect(transcriberCommand({}, '/app')).toEqual(['uv', 'run', '--project', path.join('/app', 'transcriber'), 'gg-transcribe'])
    expect(transcriberCommand({ GG_TRANSCRIBER_CMD: 'python -m gg_transcriber' }, '/app')).toEqual(['python', '-m', 'gg_transcriber'])
    expect(transcriberCommand({ GG_TRANSCRIBER_CMD: '["C:\\\\py dir\\\\python.exe","-m","x"]' }, '/app')).toEqual(['C:\\py dir\\python.exe', '-m', 'x'])
  })
})

describe('checkNode', () => {
  it('fails below 22.12', async () => {
    const r = await checkNode(ctx({ nodeVersion: '22.11.0' }))
    expect(r).toMatchObject({ status: 'fail', required: true })
    expect(r.fix).toMatch(/nodejs\.org/)
  })
  it('passes at 22.12 and above', async () => {
    expect((await checkNode(ctx({ nodeVersion: '22.12.0' }))).status).toBe('ok')
    expect((await checkNode(ctx({ nodeVersion: '24.3.0' }))).status).toBe('ok')
  })
  it('fails when node:sqlite cannot load', async () => {
    const r = await checkNode(ctx({ nodeVersion: '22.12.0', hasSqlite: async () => false }))
    expect(r.status).toBe('fail')
    expect(r.detail).toMatch(/node:sqlite/)
  })
})

describe('checkPnpm / checkUv', () => {
  it('reports versions', async () => {
    const run = fakeRun({ 'pnpm --version': ok('10.28.0\n'), 'uv --version': ok('uv 0.9.5\n') })
    expect(await checkPnpm(ctx({ run }))).toMatchObject({ status: 'ok', detail: '10.28.0', fix: null })
    expect(await checkUv(ctx({ run }))).toMatchObject({ status: 'ok', detail: 'uv 0.9.5' })
  })
  it('fails with a fix when missing', async () => {
    const pnpm = await checkPnpm(ctx())
    expect(pnpm).toMatchObject({ status: 'fail', required: true, detail: '找不到 pnpm' })
    expect(pnpm.fix).toMatch(/setup\.bat/)
    expect(pnpm.fix).toMatch(/npm install -g pnpm@10/)
    expect((await checkUv(ctx())).fix).toMatch(/astral-sh\.uv/)
  })
  it('fails a pnpm older than 10.5, which does not read the build approvals in pnpm-workspace.yaml', async () => {
    for (const version of ['9.15.9', '10.0.0', '10.4.1']) {
      const r = await checkPnpm(ctx({ run: fakeRun({ 'pnpm --version': ok(`${version}\n`) }) }))
      expect(r).toMatchObject({ status: 'fail', required: true, detail: `${version}，需要 10.5.0 以上（10、11、12 都可以）` })
      expect(r.fix).toMatch(/重新執行 setup\.bat（會安裝或更新 pnpm）/)
    }
  })
  it('accepts pnpm 10.5 and later, including 11 and 12', async () => {
    for (const version of ['10.5.0', '10.34.9', '11.28.11', '12.18.0']) {
      expect(await checkPnpm(ctx({ run: fakeRun({ 'pnpm --version': ok(`${version}\n`) }) }))).toMatchObject({ status: 'ok', detail: version })
    }
  })
  it('reports a pnpm that cannot run', async () => {
    const r = await checkPnpm(ctx({ run: fakeRun({ 'pnpm --version': failed('Error: boom\n') }) }))
    expect(r).toMatchObject({ status: 'fail', detail: '無法執行：Error: boom' })
  })
})

describe('checkFfmpeg', () => {
  const version = ok('ffmpeg version 7.1-full_build-www.gyan.dev Copyright\n')
  const probeVersion = ok('ffprobe version 7.1-full_build-www.gyan.dev Copyright\n')

  it('passes with libass', async () => {
    const run = fakeRun({ 'ffmpeg -version': version, 'ffprobe -version': probeVersion, 'ffmpeg -hide_banner -buildconf': ok('  --enable-libass\n') })
    const results = await checkFfmpeg(ctx({ run }))
    expect(results.map(r => [r.id, r.status])).toEqual([['ffmpeg', 'ok'], ['ffprobe', 'ok'], ['libass', 'ok']])
    expect(results[0].detail).toBe('7.1-full_build-www.gyan.dev')
  })

  it('fails libass when the build lacks it', async () => {
    const run = fakeRun({ 'ffmpeg -version': version, 'ffprobe -version': probeVersion, 'ffmpeg -hide_banner -buildconf': ok('  --enable-gpl\n') })
    const [, , libass] = await checkFfmpeg(ctx({ run }))
    expect(libass).toMatchObject({ status: 'fail', required: true })
  })

  it('fails everything when ffmpeg is missing and honours GG_FFMPEG/GG_FFPROBE', async () => {
    const calls: Call[] = []
    const env = { GG_FFMPEG: 'C:\\ff\\ffmpeg.exe', GG_FFPROBE: 'C:\\ff\\ffprobe.exe' }
    const results = await checkFfmpeg(createContext({ env, root: tmp, run: fakeRun({ 'C:\\ff\\ffprobe.exe -version': probeVersion }, calls) }))
    expect(results.map(r => r.status)).toEqual(['fail', 'ok', 'fail'])
    expect(results[0].detail).toContain('C:\\ff\\ffmpeg.exe')
    expect(results[1].detail).toContain('C:\\ff\\ffprobe.exe')
    expect(calls.map(c => c.command)).toEqual(['C:\\ff\\ffmpeg.exe', 'C:\\ff\\ffprobe.exe'])
  })

  it.skipIf(!hasFfmpeg)('passes with the real ffmpeg on this machine', async () => {
    const results = await checkFfmpeg(createContext({ env: process.env, root }))
    expect(results.map(r => r.status)).toEqual(['ok', 'ok', 'ok'])
  })
})

describe('checkNvenc', () => {
  it('is only a warning when the test encode fails', async () => {
    const run = fakeRun({ ffmpeg: failed('[h264_nvenc @ 0x1] Cannot load nvcuda.dll\n[out#0] Nothing was written') })
    const r = await checkNvenc(ctx({ run }))
    expect(r).toMatchObject({ status: 'warn', required: false, detail: '無法使用：Cannot load nvcuda.dll' })
    expect(r.fix).toMatch(/CPU（libx264）/)
    expect(exitCodeFor([r])).toBe(0)
  })
  it('passes when the encode works', async () => {
    const calls: Call[] = []
    const r = await checkNvenc(ctx({ run: fakeRun({ ffmpeg: ok() }, calls) }))
    expect(r.status).toBe('ok')
    expect(calls[0].args).toEqual(expect.arrayContaining(['-c:v', 'h264_nvenc', '-f', 'null']))
  })
  it('respects GG_VIDEO_ENCODER=libx264 and a missing ffmpeg', async () => {
    expect((await checkNvenc(ctx({ env: { GG_VIDEO_ENCODER: 'libx264' } }))).status).toBe('ok')
    expect((await checkNvenc(ctx(), false)).status).toBe('warn')
  })
  it.skipIf(!hasFfmpeg)('runs a real test encode', async () => {
    const r = await checkNvenc(createContext({ env: {}, root }))
    expect(['ok', 'warn']).toContain(r.status)
  })
})

describe('checkTranscriber', () => {
  const checkLine = (devices: number) => `{"type":"check","python":"3.12.7","fasterWhisper":"1.2.1","ctranslate2":"4.8.3","cudaDevices":${devices}}\n`

  it('runs `<prefix> check` from the project root', async () => {
    const calls: Call[] = []
    const r = await checkTranscriber(ctx({ run: fakeRun({ uv: ok(checkLine(1)) }, calls) }))
    expect(r).toMatchObject({ status: 'ok', detail: 'Python 3.12.7、faster-whisper 1.2.1、ctranslate2 4.8.3、CUDA 裝置 1 個' })
    expect(calls[0]).toEqual({ command: 'uv', args: ['run', '--project', path.join(tmp, 'transcriber'), 'gg-transcribe', 'check'] })
  })

  it('warns that 0 CUDA devices means slow CPU recognition', async () => {
    const r = await checkTranscriber(ctx({ run: fakeRun({ uv: ok(checkLine(0)) }) }))
    expect(r.status).toBe('warn')
    expect(r.detail).toMatch(/語音辨識會用 CPU，很慢/)
    expect(exitCodeFor([r])).toBe(0)
  })

  it('fails with the CLI error message', async () => {
    const run = fakeRun({ uv: { ...failed('Traceback…'), stdout: '{"type":"error","message":"找不到 faster_whisper"}\n' } })
    const r = await checkTranscriber(ctx({ run }))
    expect(r).toMatchObject({ status: 'fail', required: true })
    expect(r.detail).toMatch(/找不到 faster_whisper/)
    expect(r.fix).toMatch(/uv sync --project transcriber/)
  })

  it('fails early without uv', async () => {
    const calls: Call[] = []
    const r = await checkTranscriber(ctx({ run: fakeRun({}, calls) }), false)
    expect(r.status).toBe('fail')
    expect(calls).toEqual([])
  })

  it('uses GG_TRANSCRIBER_CMD when set', async () => {
    const calls: Call[] = []
    const r = await checkTranscriber(ctx({ env: { GG_TRANSCRIBER_CMD: 'python -m gg' }, run: fakeRun({ python: ok(checkLine(2)) }, calls) }), false)
    expect(r.status).toBe('ok')
    expect(calls[0]).toEqual({ command: 'python', args: ['-m', 'gg', 'check'] })
  })

  it('rejects a malformed GG_TRANSCRIBER_CMD', async () => {
    expect((await checkTranscriber(ctx({ env: { GG_TRANSCRIBER_CMD: '[broken' } }))).status).toBe('fail')
  })
})

describe('checkFonts', () => {
  const big = (magic: string) => {
    const buf = Buffer.alloc(1024 * 1024 + 10)
    buf.write(magic, 0, 'latin1')
    return buf
  }

  it('fails when the folder is missing or empty', async () => {
    const r = await checkFonts(ctx())
    expect(r).toMatchObject({ status: 'fail', required: true })
    expect(r.fix).toMatch(/fetch-fonts\.mjs/)
  })
  it('warns when only other fonts are there', async () => {
    await fs.mkdir(path.join(tmp, 'fonts'))
    await fs.writeFile(path.join(tmp, 'fonts', 'Arial.ttf'), big('true'))
    expect((await checkFonts(ctx())).status).toBe('warn')
  })
  it('passes with a valid Noto Sans CJK file', async () => {
    await fs.mkdir(path.join(tmp, 'fonts'))
    await fs.writeFile(path.join(tmp, 'fonts', 'NotoSansCJKtc-Bold.otf'), big('OTTO'))
    expect(await checkFonts(ctx())).toMatchObject({ status: 'ok', detail: 'NotoSansCJKtc-Bold.otf' })
  })
})

describe('checkDataDir', () => {
  it('creates the folder and leaves no probe file behind', async () => {
    const r = await checkDataDir(ctx())
    expect(r.status).toBe('ok')
    expect(await fs.readdir(path.join(tmp, 'data'))).toEqual([])
  })
  it('fails when the data path is a file', async () => {
    await fs.writeFile(path.join(tmp, 'data'), 'x')
    const r = await checkDataDir(ctx())
    expect(r).toMatchObject({ status: 'fail', required: true })
    expect(r.fix).toMatch(/GG_DATA_DIR/)
  })
})

describe('checkNvidiaSmi', () => {
  it('lists the GPU', async () => {
    const r = await checkNvidiaSmi(ctx({ run: fakeRun({ 'nvidia-smi': ok('NVIDIA GeForce RTX 3060 Ti, 560.94\n') }) }))
    expect(r).toMatchObject({ status: 'ok', detail: 'NVIDIA GeForce RTX 3060 Ti（驅動 560.94）' })
  })
  it('only warns when missing', async () => {
    const r = await checkNvidiaSmi(ctx())
    expect(r).toMatchObject({ status: 'warn', required: false, detail: '找不到 nvidia-smi' })
  })
})

describe('Ollama settings', () => {
  it('keeps the defaults in sync with server/lib/llm/types.ts', () => {
    expect(DEFAULT_OLLAMA_URL).toBe(llmTypes.DEFAULT_OLLAMA_URL)
    expect(DEFAULT_OLLAMA_MODEL).toBe(llmTypes.DEFAULT_OLLAMA_MODEL)
    expect(MIN_OLLAMA_VERSION).toBe(llmTypes.MIN_OLLAMA_VERSION)
  })

  it('reads GG_OLLAMA_URL / GG_OLLAMA_MODEL with defaults and off', () => {
    expect(ollamaConfig({})).toEqual({ url: 'http://127.0.0.1:11434', model: 'qwen3.5:9b' })
    expect(ollamaConfig({ GG_OLLAMA_URL: '  ', GG_OLLAMA_MODEL: '' })).toEqual({ url: 'http://127.0.0.1:11434', model: 'qwen3.5:9b' })
    expect(ollamaConfig({ GG_OLLAMA_URL: 'off' }).url).toBeNull()
    expect(ollamaConfig({ GG_OLLAMA_URL: 'OFF' }).url).toBeNull()
    expect(ollamaConfig({ GG_OLLAMA_URL: 'http://192.168.1.5:11434/', GG_OLLAMA_MODEL: ' qwen3.5:4b ' }))
      .toEqual({ url: 'http://192.168.1.5:11434', model: 'qwen3.5:4b' })
  })

  it('matches model names and versions the same way as the server', () => {
    for (const name of ['qwen3.5:9b', 'Qwen3', 'qwen3:latest', 'library/qwen3', 'host:5000/me/model', 'me/model:q4']) {
      expect(normalizeOllamaModel(name), name).toBe(normalizeModelName(name))
    }
    for (const version of ['0.31.2', '0.31.1', '0.30.9', '0.40.15', 'v0.31.2', '0.31.2-rc1', '1.0', '0.9.0', 'garbage', '']) {
      expect(ollamaVersionTooOld(version), version).toBe(isOlderVersion(version, MIN_OLLAMA_VERSION))
    }
  })

  it('finds the model in /api/tags by name or model, with the :latest default', () => {
    expect(ollamaHasModel({ models: [{ name: 'qwen3.5:9b' }] }, 'qwen3.5:9b')).toBe(true)
    expect(ollamaHasModel({ models: [{ model: 'qwen3:latest' }] }, 'qwen3')).toBe(true)
    expect(ollamaHasModel({ models: [{ name: 'qwen3.5:4b' }] }, 'qwen3.5:9b')).toBe(false)
    expect(ollamaHasModel({ models: [] }, 'qwen3.5:9b')).toBe(false)
    expect(ollamaHasModel({}, 'qwen3.5:9b')).toBe(false)
  })
})

describe('checkOllama', () => {
  const servers: Array<{ close: () => Promise<void> }> = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(s => s.close()))
  })
  async function fake(opts: FakeOllamaOptions = {}) {
    const server = await startFakeOllama(opts)
    servers.push(server)
    return server
  }
  const realFetch = (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init)
  const withServer = (url: string, env: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
    ctx({ env: { GG_OLLAMA_URL: url, ...env }, fetch: realFetch, ...extra })

  it('passes with a recent Ollama that has the model', async () => {
    const ollama = await fake()
    const r = await checkOllama(withServer(ollama.url))
    expect(r).toMatchObject({ id: 'ollama', status: 'ok', required: false, detail: 'Ollama 0.40.15，模型 qwen3.5:9b', fix: null })
    expect(ollama.requests).toEqual(['GET /api/version', 'GET /api/tags'])
  })

  it('honours GG_OLLAMA_MODEL and the :latest default tag', async () => {
    const ollama = await fake({ models: ['qwen3:latest'] })
    expect((await checkOllama(withServer(ollama.url, { GG_OLLAMA_MODEL: 'qwen3' }))).status).toBe('ok')
    expect(await checkOllama(withServer(ollama.url))).toMatchObject({ status: 'warn', detail: 'Ollama 0.40.15，還沒有 qwen3.5:9b 模型' })
  })

  it('warns with the pull command when the model is missing', async () => {
    const ollama = await fake({ models: ['llama3.2:3b'] })
    const r = await checkOllama(withServer(ollama.url))
    expect(r).toMatchObject({ status: 'warn', required: false })
    expect(r.fix).toContain('ollama pull qwen3.5:9b（約 6.6 GB）')
    expect(r.fix).toMatch(/自動找精華只會用音量/)
    const custom = await checkOllama(withServer(ollama.url, { GG_OLLAMA_MODEL: 'qwen3.5:4b' }))
    expect(custom.fix).toContain('ollama pull qwen3.5:4b，')
  })

  it('warns that an Ollama older than 0.31.2 must be updated', async () => {
    const ollama = await fake({ version: { version: '0.31.1' } })
    const r = await checkOllama(withServer(ollama.url))
    expect(r).toMatchObject({ status: 'warn', detail: 'Ollama 0.31.1，需要 0.31.2 以上' })
    expect(r.fix).toMatch(/更新 Ollama/)
    expect(r.fix).toContain('winget upgrade --id Ollama.Ollama')
    expect(ollama.requests).toEqual(['GET /api/version'])
  })

  it('treats a server without a version as unreachable, and a broken tag list as a warning', async () => {
    const notOllama = await fake({ version: { hello: 'world' } })
    expect((await checkOllama(withServer(notOllama.url))).detail).toBe(`連不到 Ollama（${notOllama.url}）`)
    const brokenTags = await fake({ models: null })
    expect((await checkOllama(withServer(brokenTags.url))).detail).toMatch(/讀不到模型清單/)
  })

  it('warns when nothing listens at a custom GG_OLLAMA_URL', async () => {
    const closed = await startFakeOllama()
    await closed.close()
    const calls: Call[] = []
    const r = await checkOllama(withServer(closed.url, {}, { run: fakeRun({}, calls) }))
    expect(r).toMatchObject({ status: 'warn', required: false, detail: `連不到 Ollama（${closed.url}）` })
    expect(r.fix).toMatch(/GG_OLLAMA_URL/)
    expect(calls).toEqual([])
    expect(exitCodeFor([r])).toBe(0)
  })

  it('tells apart a missing and a stopped Ollama at the default address', async () => {
    const missingOllama = await checkOllama(ctx())
    expect(missingOllama).toMatchObject({ status: 'warn', detail: '找不到 Ollama' })
    expect(missingOllama.fix).toMatch(/setup\.bat/)
    const stopped = await checkOllama(ctx({ run: fakeRun({ 'ollama --version': ok('Warning: could not connect to a running Ollama instance\nWarning: client version is 0.40.15\n') }) }))
    expect(stopped).toMatchObject({ status: 'warn', detail: '連不到 Ollama（http://127.0.0.1:11434）' })
    expect(stopped.fix).toMatch(/^啟動 Ollama/)
  })

  it('gives up quickly when Ollama does not answer', async () => {
    const ollama = await fake({ hang: true })
    const started = Date.now()
    const r = await checkOllama(withServer(ollama.url, {}, { ollamaTimeoutMs: 200 }))
    expect(r.status).toBe('warn')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('reports GG_OLLAMA_URL=off as switched off, without a request', async () => {
    const calls: unknown[] = []
    const r = await checkOllama(ctx({ env: { GG_OLLAMA_URL: 'off' }, fetch: async (...args: unknown[]) => { calls.push(args); throw new Error('no') } }))
    expect(r).toMatchObject({ status: 'later', required: false, fix: null })
    expect(r.detail).toMatch(/^已關閉/)
    expect(calls).toEqual([])
  })

  it('rejects a GG_OLLAMA_URL that is not a URL', async () => {
    const r = await checkOllama(ctx({ env: { GG_OLLAMA_URL: '127.0.0.1:11434 x' } }))
    expect(r).toMatchObject({ status: 'warn', detail: 'GG_OLLAMA_URL 格式不正確：127.0.0.1:11434 x' })
  })
})

describe('checkYtdlp', () => {
  const managedExe = () => path.join(tmp, 'tools', 'bin', 'yt-dlp')
  async function installManaged() {
    await fs.mkdir(path.dirname(managedExe()), { recursive: true })
    await fs.writeFile(managedExe(), '')
  }

  it('builds the command like the server: GG_YTDLP_CMD, else tools/bin/yt-dlp(.exe)', () => {
    expect(ytdlpCommand({}, '/gg', 'linux')).toEqual([path.join('/gg', 'tools', 'bin', 'yt-dlp')])
    expect(ytdlpCommand({ GG_YTDLP_CMD: '   ' }, '/gg', 'win32')).toEqual([path.join('/gg', 'tools', 'bin', 'yt-dlp.exe')])
    expect(ytdlpCommand({ GG_YTDLP_CMD: 'node  fake.mjs' }, '/gg')).toEqual(['node', 'fake.mjs'])
    const argv = ['C:\\Program Files\\nodejs\\node.exe', 'fake.mjs']
    expect(ytdlpCommand({ GG_YTDLP_CMD: JSON.stringify(argv) }, '/gg')).toEqual(argv)
  })

  it('warns, without running anything, when the managed copy is not installed yet', async () => {
    const calls: Call[] = []
    const r = await checkYtdlp(ctx({ run: fakeRun({}, calls), platform: 'linux' }))
    expect(r).toMatchObject({ id: 'yt-dlp', status: 'warn', required: false, detail: '還沒有安裝' })
    expect(r.fix).toMatch(/start\.bat.*setup\.bat.*不能加入 YouTube 影片/)
    expect(calls).toEqual([])
  })

  it('reports the version of the managed copy', async () => {
    await installManaged()
    const calls: Call[] = []
    const r = await checkYtdlp(ctx({ run: fakeRun({ [`${managedExe()} --version`]: ok('2026.10.26\n') }, calls), platform: 'linux' }))
    expect(r).toMatchObject({ status: 'ok', required: false, detail: '2026.10.26', fix: null })
    expect(calls).toEqual([{ command: managedExe(), args: ['--version'] }])
  })

  it('warns when the managed copy cannot run or hangs', async () => {
    await installManaged()
    const broken = await checkYtdlp(ctx({ run: fakeRun({ [managedExe()]: failed('ModuleNotFoundError: No module named yt_dlp') }), platform: 'linux' }))
    expect(broken).toMatchObject({ status: 'warn', required: false, detail: '無法執行：ModuleNotFoundError: No module named yt_dlp' })
    expect(broken.fix).toMatch(/刪掉專案裡的 tools 資料夾/)
    const hung = { ok: false, code: null, stdout: '', stderr: '', notFound: false, timedOut: true, error: 'timeout' }
    const slow = await checkYtdlp(ctx({ run: fakeRun({ [managedExe()]: hung }), platform: 'linux' }))
    expect(slow).toMatchObject({ status: 'warn', detail: '無法執行：15 秒內沒有回應' })
  })

  it('runs GG_YTDLP_CMD instead, and warns when it fails', async () => {
    const calls: Call[] = []
    const good = await checkYtdlp(ctx({ env: { GG_YTDLP_CMD: 'node fake-yt-dlp.mjs' }, run: fakeRun({ 'node fake-yt-dlp.mjs --version': ok('2099.01.01') }, calls) }))
    expect(good).toMatchObject({ status: 'ok', detail: '2099.01.01（GG_YTDLP_CMD）' })
    expect(calls).toEqual([{ command: 'node', args: ['fake-yt-dlp.mjs', '--version'] }])
    const bad = await checkYtdlp(ctx({ env: { GG_YTDLP_CMD: 'nope' } }))
    expect(bad).toMatchObject({ status: 'warn', required: false, detail: '無法執行 GG_YTDLP_CMD：找不到 nope' })
    const malformed = await checkYtdlp(ctx({ env: { GG_YTDLP_CMD: '["unterminated' } }))
    expect(malformed).toMatchObject({ status: 'warn', detail: 'GG_YTDLP_CMD 格式不正確' })
  })
})

describe('runChecks / report', () => {
  const everythingOk = fakeRun({
    'pnpm --version': ok('10.34.9'),
    'ffmpeg -version': ok('ffmpeg version 7.1 x'),
    'ffprobe -version': ok('ffprobe version 7.1 x'),
    'ffmpeg -hide_banner -buildconf': ok('--enable-libass'),
    'uv --version': ok('uv 0.9.0'),
    'uv run': ok('{"type":"check","python":"3.12.7","fasterWhisper":"1.2.1","ctranslate2":"4.8.3","cudaDevices":0}'),
  })

  it('orders results and exits 0 when only warnings remain', async () => {
    await fs.mkdir(path.join(tmp, 'fonts'))
    const font = Buffer.alloc(1024 * 1024 + 10)
    font.write('OTTO', 0, 'latin1')
    await fs.writeFile(path.join(tmp, 'fonts', 'NotoSansCJKtc-Bold.otf'), font)
    const results = await runChecks(ctx({ run: everythingOk }))
    expect(results.map(r => r.id)).toEqual(['node', 'pnpm', 'ffmpeg', 'ffprobe', 'libass', 'nvenc', 'uv', 'transcriber', 'fonts', 'data', 'nvidia-smi', 'ollama', 'yt-dlp'])
    expect(exitCodeFor(results)).toBe(0)
    const report = formatReport(results)
    expect(report).toMatch(/✅ Node\.js：v/)
    expect(report).toMatch(/⚠️ NVENC 硬體編碼/)
    expect(report).toMatch(/⚠️ Ollama（自動找精華）：找不到 Ollama/)
    expect(report).toMatch(/⚠️ yt-dlp（YouTube 下載）：還沒有安裝/)
    expect(report).toMatch(/必要項目都通過了（另有 \d+ 個提醒）/)
  })

  it('exits 1 and explains when a required item fails', async () => {
    const results = await runChecks(ctx())
    expect(exitCodeFor(results)).toBe(1)
    const report = formatReport(results)
    expect(report).toMatch(/❌ pnpm：找不到 pnpm/)
    expect(report).toMatch(/ {3}→ 重新執行 setup\.bat（會安裝或更新 pnpm），或執行 npm install -g pnpm@10/)
    expect(report).toMatch(/個必要項目沒有通過/)
  })
})

describe('CLI', () => {
  it('prints machine-readable results with --json', async () => {
    const fake = path.join(tmp, 'fake-transcriber.mjs')
    await fs.writeFile(fake, 'if (process.argv[2] === "check") console.log(JSON.stringify({ type: "check", python: "3.12.0", fasterWhisper: "1.2.1", ctranslate2: "4.8.3", cudaDevices: 0 }))\n')
    const fakeYtdlp = path.join(tmp, 'fake-yt-dlp.mjs')
    await fs.writeFile(fakeYtdlp, 'if (process.argv[2] === "--version") console.log("2026.10.26")\n')
    const r = spawnSync(process.execPath, [path.join(here, 'doctor.mjs'), '--json'], {
      cwd: tmp,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
      env: {
        ...process.env,
        GG_TRANSCRIBER_CMD: JSON.stringify([process.execPath, fake]),
        GG_DATA_DIR: path.join(tmp, 'data'),
        GG_FONTS_DIR: path.join(tmp, 'fonts'),
        GG_OLLAMA_URL: 'off',
        GG_YTDLP_CMD: JSON.stringify([process.execPath, fakeYtdlp]),
      },
    })
    const parsed = JSON.parse(r.stdout)
    expect(parsed.ok).toBe(false) // no fonts in the temp folder
    expect(r.status).toBe(1)
    const byId = Object.fromEntries(parsed.results.map((x: { id: string }) => [x.id, x]))
    expect(byId.fonts.status).toBe('fail')
    expect(byId.transcriber).toMatchObject({ status: 'warn', detail: expect.stringMatching(/CUDA 裝置 0 個/) })
    expect(byId.data.status).toBe('ok')
    expect(byId.ollama).toMatchObject({ status: 'later', detail: expect.stringMatching(/^已關閉/) })
    expect(byId['yt-dlp']).toMatchObject({ status: 'ok', required: false, detail: '2026.10.26（GG_YTDLP_CMD）' })
    expect(r.stderr).not.toMatch(/ExperimentalWarning/)
  })
})
