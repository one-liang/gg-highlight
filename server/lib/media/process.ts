// Spawning ffmpeg/ffprobe: stderr tail, `-progress` parsing, abort (with process-tree kill on Windows).
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { MediaTools, RunOptions } from './types'

export const STDERR_TAIL_CHARS = 4096

/** Non-zero exit of ffmpeg/ffprobe. `stderr` holds the last few KB of its stderr. */
export class MediaToolError extends Error {
  readonly exitCode: number | null
  readonly stderr: string
  constructor(message: string, exitCode: number | null, stderr: string) {
    super(message)
    this.name = 'MediaToolError'
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

export function abortError(): Error {
  const err = new Error('工作已取消')
  err.name = 'AbortError'
  return err
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/** Appends to a string but keeps only its last `max` characters. */
export function appendTail(current: string, chunk: string, max = STDERR_TAIL_CHARS): string {
  const next = current + chunk
  return next.length > max ? next.slice(next.length - max) : next
}

/**
 * Turns `-progress pipe:1` output into a clamped, monotonic 0–1 fraction.
 * ffmpeg reports out_time_us and (despite the name) out_time_ms both in microseconds.
 */
export function createProgressParser(durationSec: number, onProgress: (progress: number) => void) {
  let last = 0
  let pending = ''
  const emit = (value: number) => {
    const clamped = Math.min(1, Math.max(0, value))
    if (clamped <= last) return
    last = clamped
    try {
      onProgress(clamped)
    }
    catch {
      // a broken listener must not break the encode
    }
  }
  const line = (text: string) => {
    const m = /^out_time_(?:us|ms)=(-?\d+)\s*$/.exec(text)
    if (!m) return
    const us = Number(m[1])
    if (Number.isFinite(us) && us >= 0) emit(us / 1e6 / durationSec)
  }
  return {
    push(chunk: string) {
      pending += chunk
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const l of lines) line(l)
    },
    /** Called after a successful exit: the work is complete. */
    finish() {
      if (pending) line(pending)
      pending = ''
      emit(1)
    },
    get value() {
      return last
    },
  }
}

function killTree(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') {
    // ffmpeg may be wrapped (e.g. by a shim); /T kills the whole tree, /F forces it.
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.on('error', () => child.kill())
    killer.on('exit', (code) => {
      if (code !== 0 && child.exitCode === null) child.kill()
    })
  }
  else {
    child.kill('SIGKILL')
  }
}

interface ProcessOptions {
  cwd?: string
  signal?: AbortSignal
  /** Collect stdout and return it (ffprobe JSON). */
  collectStdout?: boolean
  onStdout?: (chunk: string) => void
}

/** Spawns a tool and resolves with its stdout once it exits 0. Rejects only after the process is gone. */
export function runTool(command: string, args: string[], opts: ProcessOptions = {}): Promise<string> {
  const { cwd, signal } = opts
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const wantStdout = !!opts.collectStdout || !!opts.onStdout
    let child: ChildProcess
    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', wantStdout ? 'pipe' : 'ignore', 'pipe'],
      })
    }
    catch (err) {
      reject(new Error(`無法執行 ${command}：${(err as Error).message}`))
      return
    }
    let stdout = ''
    let stderr = ''
    let aborted = false
    let settled = false
    const onAbort = () => {
      aborted = true
      killTree(child)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (err: Error | null) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve(stdout)
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (opts.collectStdout) stdout += chunk
      opts.onStdout?.(chunk)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr = appendTail(stderr, chunk)
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (aborted) return finish(abortError())
      // Node reports a missing cwd as ENOENT of the command too.
      if (err.code === 'ENOENT' && cwd && !existsSync(cwd)) return finish(new Error(`無法執行 ${command}：工作資料夾不存在（${cwd}）`))
      const reason = err.code === 'ENOENT' ? '找不到執行檔' : err.message
      finish(new Error(`無法執行 ${command}：${reason}`))
    })
    child.on('close', (code, sig) => {
      if (aborted) return finish(abortError())
      if (code === 0) return finish(null)
      const tail = stderr.trim()
      const status = code !== null ? `結束碼 ${code}` : `訊號 ${sig}`
      finish(new MediaToolError(`${command} 執行失敗（${status}）${tail ? `：\n${tail}` : ''}`, code, tail))
    })
  })
}

/**
 * Runs ffmpeg with `-hide_banner -nostdin -y -v error` prepended. With onProgress + durationSec it
 * adds `-progress pipe:1 -nostats` and reports a monotonic 0–1 fraction. onProgress always gets 1 on success.
 */
export async function runFfmpeg(tools: MediaTools, args: string[], opts: RunOptions = {}): Promise<void> {
  const { onProgress, durationSec } = opts
  const progress = onProgress && durationSec && durationSec > 0
    ? createProgressParser(durationSec, onProgress)
    : null
  const argv = ['-hide_banner', '-nostdin', '-y', '-v', 'error']
  if (progress) argv.push('-progress', 'pipe:1', '-nostats')
  argv.push(...args)
  await runTool(tools.ffmpegPath, argv, {
    cwd: opts.cwd,
    signal: opts.signal,
    onStdout: progress ? chunk => progress.push(chunk) : undefined,
  })
  if (progress) progress.finish()
  else if (onProgress) createProgressParser(1, onProgress).finish()
}
