// runYtdlp: both streams line by line, WARNING / ERROR handling, raw stdout, start failures, abort.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCli, SPAWN_NOT_FOUND_MESSAGE } from '../transcription/process'
import { logFailure, runYtdlp, YTDLP_CLI_MESSAGES } from './run'
import { YtdlpError } from './types'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-ytdlp-run-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/** A tiny script standing in for yt-dlp. */
function script(body: string): string[] {
  const file = path.join(dir, `s${fs.readdirSync(dir).length}.mjs`)
  fs.writeFileSync(file, body)
  return [process.execPath, file]
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  }
  catch (err) {
    return err
  }
  throw new Error('expected a rejection')
}

describe('runYtdlp', () => {
  it('reads both streams line by line, logs WARNING lines and collects ERROR lines', async () => {
    const command = script(`
      process.stdout.write('GGDL 137 {"status":"downloading"}\\n[download] 中文 line\\r\\nGGFILE "a.mp4"\\n')
      process.stderr.write('WARNING: [youtube] something odd\\nERROR: first\\n  ERROR: second  \\nnot an error\\n')
      process.exitCode = 1`)
    const lines: string[] = []
    const logs: string[] = []
    const result = await runYtdlp({ command }, [], { onLine: l => lines.push(l), log: m => logs.push(m) })
    expect(result.code).toBe(1)
    expect(result.signal).toBeNull()
    expect(lines).toEqual(expect.arrayContaining([
      'GGDL 137 {"status":"downloading"}', '[download] 中文 line', 'GGFILE "a.mp4"',
      'WARNING: [youtube] something odd', 'ERROR: first', '  ERROR: second  ', 'not an error',
    ]))
    expect(result.errorLines).toEqual(['ERROR: first', 'ERROR: second'])
    expect(logs).toEqual(['[yt-dlp] WARNING: [youtube] something odd'])
    // Progress lines stay out of the tail.
    expect(result.tail).not.toContain('GGDL 137 {"status":"downloading"}')
    expect(result.tail).toEqual(expect.arrayContaining(['[download] 中文 line', 'ERROR: first', 'not an error']))
    expect(result.stdout).toBe('')
  })

  it('splits stderr only at \\n / \\r\\n: a lone \\r inside an ERROR line becomes a space (yt-dlp\'s retry errors)', async () => {
    const command = script(`
      process.stdout.write('[download]  10.0%\\r[download]  20.0%\\n')
      process.stderr.write('ERROR: \\r[download] Got error: HTTP Error 403: Forbidden. Giving up after 10 retries\\r\\nERROR: plain\\n')
      process.exitCode = 1`)
    const lines: string[] = []
    const result = await runYtdlp({ command }, [], { onLine: l => lines.push(l) })
    expect(result.errorLines).toEqual(['ERROR: [download] Got error: HTTP Error 403: Forbidden. Giving up after 10 retries', 'ERROR: plain'])
    expect(result.tail).toContain('ERROR: [download] Got error: HTTP Error 403: Forbidden. Giving up after 10 retries')
    // stdout still splits at a lone \r (progress redraws without --newline).
    expect(lines).toEqual(expect.arrayContaining(['[download]  10.0%', '[download]  20.0%']))
  })

  it('passes the arguments as an array and sets PYTHONUTF8=1', async () => {
    const command = script(`console.log(JSON.stringify({ argv: process.argv.slice(2), utf8: process.env.PYTHONUTF8 }))`)
    const lines: string[] = []
    await runYtdlp({ command }, ['--', '-starts with a dash', 'a b"c'], { onLine: l => lines.push(l) })
    expect(JSON.parse(lines[0]!)).toEqual({ argv: ['--', '-starts with a dash', 'a b"c'], utf8: '1' })
  })

  it('keeps stdout whole when collecting it raw (a -J line longer than the line splitter takes)', async () => {
    const command = script(`
      process.stdout.write(JSON.stringify({ big: 'x'.repeat(2 * 1024 * 1024) }) + '\\n')
      process.stderr.write('WARNING: still logged\\n')`)
    const lines: string[] = []
    const logs: string[] = []
    const result = await runYtdlp({ command }, [], { collectStdout: true, onLine: l => lines.push(l), log: m => logs.push(m) })
    expect(JSON.parse(result.stdout).big).toHaveLength(2 * 1024 * 1024)
    expect(lines).toEqual(['WARNING: still logged'])
    expect(logs).toEqual(['[yt-dlp] WARNING: still logged'])
  })

  it('a throwing line handler does not stop the error accounting', async () => {
    const command = script(`process.stderr.write('ERROR: kept\\n')`)
    const result = await runYtdlp({ command }, [], {
      onLine: () => {
        throw new Error('handler bug')
      },
    })
    expect(result.errorLines).toEqual(['ERROR: kept'])
  })

  it('a missing executable → YtdlpError not-installed', async () => {
    const error = await caught(runYtdlp({ command: [path.join(dir, 'no-such-yt-dlp')] }, ['--version']))
    expect(error).toBeInstanceOf(YtdlpError)
    expect((error as YtdlpError).kind).toBe('not-installed')
    expect((error as YtdlpError).message).toBe('找不到 yt-dlp，請重新執行 setup.bat')
    expect((error as YtdlpError).detail).toContain('ENOENT')
  })

  it('an empty command is a start failure too', async () => {
    const error = await caught(runYtdlp({ command: [] }, []))
    expect((error as YtdlpError).kind).toBe('not-installed')
    expect((error as YtdlpError).detail).toBe(YTDLP_CLI_MESSAGES.emptyCommand)
  })

  it('an abort rejects with AbortError (yt-dlp 已取消), not a YtdlpError', async () => {
    const controller = new AbortController()
    const command = script(`console.log('started'); setTimeout(() => {}, 60000)`)
    const promise = runYtdlp({ command }, [], {
      signal: controller.signal,
      onLine: () => controller.abort(),
    })
    const error = await caught(promise)
    expect(error).not.toBeInstanceOf(YtdlpError)
    expect((error as Error).name).toBe('AbortError')
    expect((error as Error).message).toBe('yt-dlp 已取消')
  })
})

describe('runCli messages', () => {
  it('defaults stay the transcriber texts', async () => {
    await expect(runCli([path.join(dir, 'missing')], [])).rejects.toThrow(SPAWN_NOT_FOUND_MESSAGE)
    await expect(runCli([], [])).rejects.toThrow('GG_TRANSCRIBER_CMD')
    const controller = new AbortController()
    controller.abort()
    await expect(runCli([process.execPath], [], { signal: controller.signal })).rejects.toThrow('語音辨識已取消')
  })

  it('can be replaced per call', async () => {
    await expect(runCli([path.join(dir, 'missing')], [], { messages: { notFound: '自訂' } })).rejects.toThrow('自訂')
  })
})

describe('logFailure', () => {
  it('writes the exit status and the output tail', () => {
    const logs: string[] = []
    logFailure(m => logs.push(m), '下載影片', { code: 1, signal: null, errorLines: [], tail: ['a', 'ERROR: b'], stdout: '' })
    expect(logs).toEqual(['[yt-dlp] 下載影片失敗（結束碼 1），輸出：\na\nERROR: b'])
    logFailure(m => logs.push(m), '讀取影片資訊', { code: null, signal: 'SIGKILL', errorLines: [], tail: [], stdout: '' })
    expect(logs[1]).toBe('[yt-dlp] 讀取影片資訊失敗（被訊號 SIGKILL 終止），輸出：\n（沒有輸出）')
    expect(() => logFailure(undefined, 'x', { code: 1, signal: null, errorLines: [], tail: [], stdout: '' })).not.toThrow()
  })
})
