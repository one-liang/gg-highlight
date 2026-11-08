import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MediaToolError, STDERR_TAIL_CHARS, appendTail, createProgressParser, runFfmpeg, runTool } from './process'
import { makeTmpDir, tools } from './test-utils'

describe('appendTail', () => {
  it('keeps only the last N characters', () => {
    expect(appendTail('abc', 'def', 4)).toBe('cdef')
    expect(appendTail('', 'xy', 4)).toBe('xy')
    expect(appendTail('a'.repeat(10), 'b'.repeat(10)).length).toBe(20)
  })
})

describe('createProgressParser', () => {
  it('parses out_time_us / out_time_ms (both microseconds) into a clamped, monotonic fraction', () => {
    const seen: number[] = []
    const p = createProgressParser(10, v => seen.push(v))
    p.push('frame=1\nout_time_us=N/A\nout_time_us=-5\nout_time_us=2500')
    expect(seen).toEqual([]) // last line not complete yet
    p.push('000\nprogress=continue\nout_time_ms=5000000\r\nout_time_us=4000000\n')
    expect(seen).toEqual([0.25, 0.5]) // 4 s after 5 s is ignored (monotonic)
    p.push('out_time=00:00:20.000000\nout_time_us=20000000\n')
    expect(seen).toEqual([0.25, 0.5, 1])
    p.finish()
    expect(seen).toEqual([0.25, 0.5, 1]) // already 1, not repeated
  })

  it('finish() reports 1 and survives a throwing listener', () => {
    const seen: number[] = []
    const p = createProgressParser(4, (v) => {
      seen.push(v)
      throw new Error('listener bug')
    })
    p.push('out_time_us=1000000\n')
    p.finish()
    expect(seen).toEqual([0.25, 1])
    expect(p.value).toBe(1)
  })
})

describe('runTool', () => {
  it('rejects with the stderr tail (at most 4 KB) and the exit code', async () => {
    const script = 'process.stderr.write("x".repeat(10000) + "THE-END"); process.exit(3)'
    const err = await runTool(process.execPath, ['-e', script]).catch(e => e) as MediaToolError
    expect(err).toBeInstanceOf(MediaToolError)
    expect(err.exitCode).toBe(3)
    expect(err.stderr.length).toBeLessThanOrEqual(STDERR_TAIL_CHARS)
    expect(err.stderr.endsWith('THE-END')).toBe(true)
    expect(err.message).toContain('THE-END')
  })

  it('collects stdout', async () => {
    await expect(runTool(process.execPath, ['-e', 'process.stdout.write("中文 ok")'], { collectStdout: true })).resolves.toBe('中文 ok')
  })
})

describe('runFfmpeg', () => {
  it('runs ffmpeg and reports monotonic progress that ends at 1', async () => {
    const seen: number[] = []
    await runFfmpeg(tools, ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=3', '-f', 'null', '-'], {
      durationSec: 3,
      onProgress: v => seen.push(v),
    })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.at(-1)).toBe(1)
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!)
    for (const v of seen) {
      expect(v).toBeGreaterThan(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('rejects with an Error that includes ffmpeg\'s stderr', async () => {
    const err = await runFfmpeg(tools, ['-i', '/definitely/not/here.mkv', '-f', 'null', '-']).catch(e => e) as Error
    expect(err).toBeInstanceOf(MediaToolError)
    expect(err.message).toMatch(/No such file or directory/)
    expect((err as MediaToolError).exitCode).not.toBe(0)
  })

  it('reports a missing ffmpeg binary in Chinese', async () => {
    const err = await runFfmpeg({ ...tools, ffmpegPath: '/no/such/ffmpeg' }, ['-version']).catch(e => e) as Error
    expect(err.message).toContain('無法執行 /no/such/ffmpeg')
  })

  it('honours cwd for relative output paths', async () => {
    const dir = await makeTmpDir()
    await runFfmpeg(tools, ['-f', 'lavfi', '-i', 'sine=duration=0.2', 'out.wav'], { cwd: dir })
    expect(fs.existsSync(path.join(dir, 'out.wav'))).toBe(true)
  })

  it('kills ffmpeg and rejects with AbortError when the signal aborts', async () => {
    const controller = new AbortController()
    const started = Date.now()
    // -re paces the 60 s input in real time, so it would run for a minute without the abort.
    const run = runFfmpeg(tools, ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=60', '-f', 'null', '-'], {
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 300)
    const err = await run.catch(e => e) as Error
    expect(err.name).toBe('AbortError')
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('rejects at once when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const err = await runFfmpeg(tools, ['-version'], { signal: controller.signal }).catch(e => e) as Error
    expect(err.name).toBe('AbortError')
  })
})
