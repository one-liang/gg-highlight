import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkDataDir,
  checkFfmpeg,
  checkFonts,
  checkLaterTools,
  checkNode,
  checkNvenc,
  checkNvidiaSmi,
  checkPnpm,
  checkTranscriber,
  checkUv,
  createContext,
  exitCodeFor,
  formatReport,
  hasLibass,
  parseFfmpegVersion,
  parseNvidiaSmi,
  parseTranscriberCheck,
  runChecks,
  summarizeFfmpegError,
  transcriberCommand,
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

function ctx(overrides: Record<string, unknown> = {}) {
  return createContext({
    env: {},
    root: tmp,
    fontsDir: path.join(tmp, 'fonts'),
    dataDir: path.join(tmp, 'data'),
    run: fakeRun({}),
    hasSqlite: async () => true,
    ...overrides,
  })
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

describe('checkLaterTools', () => {
  it('lists Ollama and Deno as not needed yet', async () => {
    const results = await checkLaterTools(ctx({ run: fakeRun({ deno: ok('deno 2.5.0 (stable)\nv8 13\ntypescript 5.9\n') }) }))
    expect(results.map(r => [r.id, r.status, r.required])).toEqual([['ollama', 'later', false], ['deno', 'later', false]])
    expect(results[0].detail).toMatch(/尚未需要/)
    expect(results[1].detail).toMatch(/已安裝/)
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
    expect(results.map(r => r.id)).toEqual(['node', 'pnpm', 'ffmpeg', 'ffprobe', 'libass', 'nvenc', 'uv', 'transcriber', 'fonts', 'data', 'nvidia-smi', 'ollama', 'deno'])
    expect(exitCodeFor(results)).toBe(0)
    const report = formatReport(results)
    expect(report).toMatch(/✅ Node\.js：v/)
    expect(report).toMatch(/⚠️ NVENC 硬體編碼/)
    expect(report).toMatch(/➖ Ollama：尚未需要/)
    expect(report).toMatch(/必要項目都通過了/)
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
      },
    })
    const parsed = JSON.parse(r.stdout)
    expect(parsed.ok).toBe(false) // no fonts in the temp folder
    expect(r.status).toBe(1)
    const byId = Object.fromEntries(parsed.results.map((x: { id: string }) => [x.id, x]))
    expect(byId.fonts.status).toBe('fail')
    expect(byId.transcriber).toMatchObject({ status: 'warn', detail: expect.stringMatching(/CUDA 裝置 0 個/) })
    expect(byId.data.status).toBe('ok')
    expect(r.stderr).not.toMatch(/ExperimentalWarning/)
  })
})
