import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  checkTranscriber,
  downloadTranscriberModel,
  parseTranscriberLine,
  readRawTranscript,
  runTranscriber,
  SPAWN_NOT_FOUND_MESSAGE,
  type TranscribeRequest,
} from './index'
import { LineSplitter, summarizeStderr, TailBuffer } from './process'

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-helpers', 'fake-transcriber.mjs')
const fake = (scenario: string, ...extra: string[]) => [process.execPath, FAKE, `--scenario=${scenario}`, ...extra]

let tmp: string
beforeAll(() => {
  // Spaces and CJK in paths: arguments must reach the CLI untouched (no shell).
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg 轉錄 '))
})
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

let n = 0
function request(overrides: Partial<TranscribeRequest> = {}): TranscribeRequest {
  n += 1
  return {
    audioPath: path.join(tmp, `音訊 ${n}.wav`),
    language: 'en',
    outPath: path.join(tmp, `out ${n}.json`),
    model: 'Systran/faster-whisper-tiny',
    device: 'cpu',
    ...overrides,
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  }
  catch {
    return false
  }
  // A killed process can linger as a zombie until it is reaped; that counts as dead.
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z'
  }
  catch {
    return process.platform !== 'linux'
  }
}

/** The rejection of `promise`; fails the test if it resolves. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  }
  catch (err) {
    return err as Error
  }
  throw new Error('expected a rejection')
}

async function waitUntil(cond: () => boolean, timeoutMs = 5000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return true
}

describe('parseTranscriberLine', () => {
  it('parses every event type', () => {
    expect(parseTranscriberLine('{"type": "progress", "progress": 0.42}')).toEqual({ type: 'progress', progress: 0.42 })
    expect(parseTranscriberLine('{"type":"log","message":"找不到可用的 CUDA，改用 CPU 執行"}')).toEqual({ type: 'log', message: '找不到可用的 CUDA，改用 CPU 執行' })
    expect(parseTranscriberLine('{"type":"done","output":"C:\\\\data\\\\raw.json"}')).toEqual({ type: 'done', output: 'C:\\data\\raw.json' })
    expect(parseTranscriberLine('{"type":"error","message":"壞了"}')).toEqual({ type: 'error', message: '壞了' })
  })

  it('tolerates whitespace, \\r, a BOM, extra fields and junk before the object', () => {
    expect(parseTranscriberLine('  {"type":"progress","progress":1}\r')).toEqual({ type: 'progress', progress: 1 })
    expect(parseTranscriberLine('\uFEFF{"type":"log","message":"a"}')).toEqual({ type: 'log', message: 'a' })
    expect(parseTranscriberLine('{"type":"log","message":"a","level":"info"}')).toEqual({ type: 'log', message: 'a' })
    expect(parseTranscriberLine('Downloading... {"type": "progress", "progress": 0.5}')).toEqual({ type: 'progress', progress: 0.5 })
  })

  it('returns null for anything that is not a protocol event', () => {
    for (const line of [
      '',
      '   ',
      'hello',
      '{',
      '{"type":"progress"',
      '[1,2]',
      'null',
      '42',
      '"text"',
      '{}',
      '{"type":"check","python":"3.12"}',
      '{"type":"progress","progress":"0.5"}',
      '{"type":"progress"}',
      '{"type":"log","message":3}',
      '{"type":"done"}',
      '{"type":"error","message":null}',
      '{"message":"no type"}',
    ]) {
      expect(parseTranscriberLine(line), line).toBeNull()
    }
  })
})

describe('LineSplitter', () => {
  const collect = () => {
    const lines: string[] = []
    return { lines, splitter: new LineSplitter(l => lines.push(l)) }
  }

  it('reassembles lines and multi-byte characters split across chunks', () => {
    const { lines, splitter } = collect()
    const bytes = Buffer.from('第一行\r\n第二行\nthird')
    for (let i = 0; i < bytes.length; i++) splitter.push(bytes.subarray(i, i + 1))
    expect(lines).toEqual(['第一行', '第二行'])
    splitter.end()
    expect(lines).toEqual(['第一行', '第二行', 'third'])
  })

  it('treats \\r\\n split across chunks as one line break and accepts lone \\r', () => {
    const { lines, splitter } = collect()
    splitter.push('a\r')
    splitter.push('\nb\rc\n\n')
    splitter.push('d\r')
    splitter.end()
    expect(lines).toEqual(['a', 'b', 'c', '', 'd'])
  })

  it('drops an endless line instead of buffering it forever', () => {
    const { lines, splitter } = collect()
    splitter.push('x'.repeat(2 * 1024 * 1024))
    splitter.push('tail\nnext\n')
    expect(lines).toEqual(['tail', 'next'])
  })
})

describe('stderr tail', () => {
  it('keeps only the end of the stream', () => {
    const tail = new TailBuffer(10)
    tail.push('0123456789')
    tail.push(Buffer.from('abc'))
    expect(tail.value).toBe('3456789abc')
  })

  it('summarizes to the last non-empty lines', () => {
    const text = 'Loading: 10%\rLoading: 90%\r\n\nTraceback\n  File "x"\nRuntimeError: boom\n\n'
    expect(summarizeStderr(text, 3)).toBe('Traceback\n  File "x"\nRuntimeError: boom')
    expect(summarizeStderr('')).toBe('')
    expect(summarizeStderr('y'.repeat(50), 12, 10)).toBe(`…${'y'.repeat(10)}`)
  })
})

describe('runTranscriber (fake CLI)', () => {
  it('forwards progress and logs, passes the arguments and resolves with the transcript', async () => {
    const req = request({ language: 'zh', device: 'auto' })
    const progress: number[] = []
    const logs: string[] = []
    const raw = await runTranscriber(fake('ok'), req, { onProgress: p => progress.push(p), onLog: m => logs.push(m) })

    expect(raw.language).toBe('en')
    expect(raw.segments[0]!.words.map(w => w.word)).toEqual([' Hello', ' welcome', ' 直播'])
    expect(progress).toEqual([0.25, 0.5, 0.75, 1])
    expect(logs).toEqual(['載入模型中…'])

    const seen = JSON.parse(fs.readFileSync(`${req.outPath}.args.json`, 'utf8'))
    expect(seen.argv).toEqual([
      '--scenario=ok',
      'transcribe',
      '--audio', req.audioPath,
      '--language', 'zh',
      '--model', 'Systran/faster-whisper-tiny',
      '--device', 'auto',
      '--out', req.outPath,
    ])
    expect(seen.env).toEqual({ PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' })
  })

  it('passes an initial prompt that starts with a dash', async () => {
    const req = request({ initialPrompt: '-Valorant 直播' })
    await runTranscriber(fake('ok'), req)
    const seen = JSON.parse(fs.readFileSync(`${req.outPath}.args.json`, 'utf8'))
    expect(seen.argv.at(-1)).toBe('--initial-prompt=-Valorant 直播')
  })

  it('handles a last event without a trailing newline', async () => {
    const progress: number[] = []
    await runTranscriber(fake('no-trailing-newline'), request(), { onProgress: p => progress.push(p) })
    expect(progress).toEqual([0.5])
  })

  it('survives listeners that throw', async () => {
    const raw = await runTranscriber(fake('ok'), request(), {
      onProgress: () => {
        throw new Error('listener bug')
      },
      onLog: () => {
        throw new Error('listener bug')
      },
    })
    expect(raw.segments).toHaveLength(1)
  })

  it('rejects with the last error event', async () => {
    await expect(runTranscriber(fake('error'), request())).rejects.toThrow(/^語音辨識失敗：找不到音訊檔：x\.wav$/)
  })

  it('rejects with the stderr tail when the CLI dies without an error event', async () => {
    const err = await failure(runTranscriber(fake('crash'), request()))
    expect(err).toBeInstanceOf(Error)
    expect(err.message.startsWith('語音辨識失敗：')).toBe(true)
    expect(err.message).toContain('RuntimeError: CUDA failed')
    expect(err.message).toContain('Traceback')
  })

  it('reports the exit code when there is nothing else to say', async () => {
    await expect(runTranscriber(fake('silent-crash'), request())).rejects.toThrow('語音辨識失敗：轉錄程式異常結束（結束碼 4）')
  })

  it.skipIf(process.platform === 'win32')('reports a process killed by a signal', async () => {
    await expect(runTranscriber(fake('kill-self'), request())).rejects.toThrow('語音辨識失敗：轉錄程式被終止（SIGKILL）')
  })

  it('rejects when exit 0 left no transcript file', async () => {
    await expect(runTranscriber(fake('no-output'), request())).rejects.toThrow('語音辨識失敗：轉錄程式沒有產生逐字稿檔案')
  })

  it('rejects an invalid transcript file', async () => {
    await expect(runTranscriber(fake('bad-output'), request())).rejects.toThrow(/^語音辨識失敗：逐字稿檔案格式不正確（segments/)
    await expect(runTranscriber(fake('invalid-json-output'), request())).rejects.toThrow('語音辨識失敗：逐字稿檔案不是正確的 JSON')
  })

  it('explains a missing transcriber program', async () => {
    await expect(runTranscriber(['gg-definitely-not-installed-xyz', 'run'], request())).rejects.toThrow(SPAWN_NOT_FOUND_MESSAGE)
    await expect(runTranscriber([], request())).rejects.toThrow('GG_TRANSCRIBER_CMD')
  })

  it('aborts: kills the whole process tree and rejects with AbortError', async () => {
    const pidFile = path.join(tmp, 'pids.json')
    const controller = new AbortController()
    let started!: () => void
    const firstProgress = new Promise<void>((resolve) => {
      started = resolve
    })
    const run = runTranscriber(fake('slow', `--pid-file=${pidFile}`), request(), {
      signal: controller.signal,
      onProgress: () => started(),
    })
    const outcome = failure(run)
    await firstProgress
    const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8')) as { pid: number, grandchild: number }
    expect(isAlive(pids.pid)).toBe(true)
    expect(isAlive(pids.grandchild)).toBe(true)

    const t0 = Date.now()
    controller.abort()
    const err = await outcome
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('AbortError')
    expect(Date.now() - t0).toBeLessThan(4000)
    expect(await waitUntil(() => !isAlive(pids.pid))).toBe(true)
    expect(await waitUntil(() => !isAlive(pids.grandchild))).toBe(true)
  })

  it('rejects at once when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const req = request()
    const err = await failure(runTranscriber(fake('ok'), req, { signal: controller.signal }))
    expect(err.name).toBe('AbortError')
    expect(fs.existsSync(`${req.outPath}.args.json`)).toBe(false)
  })
})

describe('readRawTranscript', () => {
  it('reads a UTF-8 file with a BOM', async () => {
    const file = path.join(tmp, 'bom.json')
    fs.writeFileSync(file, `\uFEFF${JSON.stringify({ language: 'zh', durationSec: 1, model: 'm', device: 'cuda', segments: [] })}`)
    expect(await readRawTranscript(file)).toEqual({ language: 'zh', durationSec: 1, model: 'm', device: 'cuda', segments: [] })
  })
})

describe('checkTranscriber (fake CLI)', () => {
  it('returns the versions without the event type', async () => {
    expect(await checkTranscriber(fake('ok'))).toEqual({ python: '3.12.3', fasterWhisper: '1.2.1', ctranslate2: '4.8.3', cudaDevices: 1 })
  })

  it('rejects with the error event or a missing check line', async () => {
    await expect(checkTranscriber(fake('error'))).rejects.toThrow('轉錄程式檢查失敗：No module named faster_whisper')
    await expect(checkTranscriber(fake('no-check'))).rejects.toThrow('轉錄程式檢查失敗：沒有輸出檢查結果')
    await expect(checkTranscriber(['gg-definitely-not-installed-xyz'])).rejects.toThrow(SPAWN_NOT_FOUND_MESSAGE)
  })
})

describe('downloadTranscriberModel (fake CLI)', () => {
  it('forwards progress and resolves with the model folder', async () => {
    const progress: number[] = []
    const logs: string[] = []
    const folder = await downloadTranscriberModel(fake('ok'), 'a/b', { onProgress: p => progress.push(p), onLog: m => logs.push(m) })
    expect(folder).toBe('/cache/a/b')
    expect(progress).toEqual([0.5, 1])
    expect(logs).toEqual(['正在下載語音辨識模型 a/b…'])
  })

  it('rejects with the error event', async () => {
    await expect(downloadTranscriberModel(fake('error'), 'x/y')).rejects.toThrow('下載語音辨識模型失敗：無法下載語音辨識模型 x/y，請檢查網路連線')
  })
})
