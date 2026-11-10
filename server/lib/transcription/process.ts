// Spawning a CLI (the transcriber, also yt-dlp): line splitting, stderr tail, abort with process-tree kill.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export const STDERR_TAIL_CHARS = 8192
/** A protocol line is tiny; anything longer without a newline is junk and gets dropped. */
const MAX_LINE_CHARS = 1 << 20
/** If the killed process does not report its exit, give up waiting after this long. */
const ABORT_GRACE_MS = 5000

export const SPAWN_NOT_FOUND_MESSAGE = '找不到轉錄程式，請先執行安裝腳本'

/** zh-TW texts for failures to start the CLI, and for an abort. */
export interface CliMessages {
  /** The executable does not exist (ENOENT). */
  notFound: string
  /** The command array is empty. */
  emptyCommand: string
  /** Put before the OS message of any other start failure. */
  startFailed: string
  /** Message of the AbortError after an abort. */
  aborted: string
}

/** Defaults of runCli: the transcriber's texts. */
export const TRANSCRIBER_CLI_MESSAGES: CliMessages = {
  notFound: SPAWN_NOT_FOUND_MESSAGE,
  emptyCommand: '轉錄程式的指令是空的，請檢查 GG_TRANSCRIBER_CMD 設定',
  startFailed: '無法啟動轉錄程式：',
  aborted: '語音辨識已取消',
}

export function abortError(cause?: unknown, message = TRANSCRIBER_CLI_MESSAGES.aborted): Error {
  const err = new Error(message, cause === undefined ? undefined : { cause })
  err.name = 'AbortError'
  return err
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/** Splits a byte stream into lines; UTF-8 safe across chunks; accepts \n, \r\n and lone \r. */
export class LineSplitter {
  private readonly decoder = new StringDecoder('utf8')
  private pending = ''

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer | string): void {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    // A trailing \r may be the first half of \r\n, so it stays pending.
    const parts = this.pending.split(/\r\n|\n|\r(?!$)/)
    this.pending = parts.pop() ?? ''
    if (this.pending.length > MAX_LINE_CHARS) this.pending = ''
    for (const part of parts) this.onLine(part)
  }

  end(): void {
    this.push(this.decoder.end())
    const rest = this.pending.replace(/\r$/, '')
    this.pending = ''
    if (rest) this.onLine(rest)
  }
}

/** Keeps the last `max` characters of a decoded stream. */
export class TailBuffer {
  private readonly decoder = new StringDecoder('utf8')
  private text = ''

  constructor(private readonly max = STDERR_TAIL_CHARS) {}

  push(chunk: Buffer | string): void {
    const next = this.text + (typeof chunk === 'string' ? chunk : this.decoder.write(chunk))
    this.text = next.length > this.max ? next.slice(next.length - this.max) : next
  }

  get value(): string {
    return this.text + this.decoder.end()
  }
}

/** Last meaningful lines of stderr, for an error message (tqdm's \r redraws become lines). */
export function summarizeStderr(stderr: string, maxLines = 12, maxChars = 1500): string {
  const lines = stderr
    .split(/\r\n|\n|\r/)
    .map(l => l.trimEnd())
    .filter(l => l.trim() !== '')
  let text = lines.slice(-maxLines).join('\n')
  if (text.length > maxChars) text = `…${text.slice(text.length - maxChars)}`
  return text
}

const running = new Set<ChildProcess>()
let exitHookInstalled = false

function killTreeSync(child: ChildProcess) {
  const pid = child.pid
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else process.kill(-pid, 'SIGKILL')
  }
  catch {
    // already gone
  }
}

/** A dying server must not leave Python holding the GPU (a restarted Analysis would compete with it). */
function installExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const child of running) killTreeSync(child)
  })
}

/**
 * Kills the child and everything it started. `uv run` starts Python as a grandchild (on Windows via
 * the gg-transcribe.exe launcher), so killing only the direct child would leave Python running.
 */
export function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.on('error', () => child.kill())
    return
  }
  try {
    // The child leads its own process group (spawned detached), so -pid reaches the whole tree.
    process.kill(-pid, 'SIGKILL')
  }
  catch {
    child.kill('SIGKILL')
  }
}

export interface CliResult {
  code: number | null
  signal: NodeJS.Signals | null
  /** Message of the last `error` event, if any. */
  lastError: string | null
  stderr: string
}

export interface CliRunOptions {
  signal?: AbortSignal
  /** Every complete stdout line. */
  onLine?: (line: string) => void
  /** Pulls the error message out of a line (keeps the last one). */
  errorOf?: (line: string) => string | null
  /** Every complete stderr line (stderr is still kept as CliResult.stderr's tail). */
  onStderrLine?: (line: string) => void
  /** Raw stdout chunks, e.g. one JSON document too long for the line splitter. */
  onStdoutData?: (chunk: Buffer) => void
  /** Start-failure and abort texts; missing ones are the transcriber's (TRANSCRIBER_CLI_MESSAGES). */
  messages?: Partial<CliMessages>
}

/**
 * Runs `[...command, ...args]` and resolves once it has exited (any exit code). Rejects only when it
 * cannot be started, or with an AbortError after an abort killed it.
 */
export function runCli(command: string[], args: string[], opts: CliRunOptions = {}): Promise<CliResult> {
  const { signal } = opts
  const messages: CliMessages = { ...TRANSCRIBER_CLI_MESSAGES, ...opts.messages }
  const abortErr = (cause?: unknown) => abortError(cause, messages.aborted)
  if (signal?.aborted) return Promise.reject(abortErr(signal.reason))
  const [file, ...prefix] = command
  if (!file) return Promise.reject(new Error(messages.emptyCommand))

  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(file, [...prefix, ...args], {
        windowsHide: true,
        // POSIX: own process group, so an abort can kill uv and the Python it started together.
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
    }
    catch (err) {
      reject(spawnError(err as NodeJS.ErrnoException, messages))
      return
    }

    let settled = false
    let aborted = false
    let lastError: string | null = null
    const stderr = new TailBuffer()
    const lines = new LineSplitter((line) => {
      const message = opts.errorOf?.(line)
      if (message != null) lastError = message
      try {
        opts.onLine?.(line)
      }
      catch (err) {
        console.warn('[transcription] line handler failed:', err)
      }
    })
    const stderrLines = opts.onStderrLine
      ? new LineSplitter((line) => {
          try {
            opts.onStderrLine?.(line)
          }
          catch (err) {
            console.warn('[cli] stderr line handler failed:', err)
          }
        })
      : null
    // Raw-stdout callers that want no lines skip the splitter (it drops lines longer than 1 MiB anyway).
    const splitStdout = !opts.onStdoutData || !!opts.onLine || !!opts.errorOf

    const finish = (err: Error | null, result?: CliResult) => {
      if (settled) return
      settled = true
      running.delete(child)
      signal?.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve(result!)
    }
    const onAbort = () => {
      aborted = true
      killTree(child)
      setTimeout(() => finish(abortErr(signal?.reason)), ABORT_GRACE_MS).unref()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (child.pid !== undefined) {
      running.add(child)
      installExitHook()
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      opts.onStdoutData?.(chunk)
      if (splitStdout) lines.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk)
      stderrLines?.push(chunk)
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (aborted) return finish(abortErr(signal?.reason))
      // Spawn failures (ENOENT, EACCES) have no pid; other errors are followed by 'close'.
      if (child.pid === undefined) finish(spawnError(err, messages))
    })
    child.on('exit', () => {
      if (aborted) finish(abortErr(signal?.reason))
    })
    child.on('close', (code, sig) => {
      if (aborted) return finish(abortErr(signal?.reason))
      lines.end()
      stderrLines?.end()
      finish(null, { code, signal: sig, lastError, stderr: stderr.value })
    })
  })
}

function spawnError(err: NodeJS.ErrnoException, messages: CliMessages): Error {
  if (err.code === 'ENOENT') return new Error(messages.notFound, { cause: err })
  return new Error(`${messages.startFailed}${err.message}`, { cause: err })
}

/** Why a run failed, for the user: the CLI's error event, else the stderr tail, else the exit status. */
export function failureReason(result: CliResult): string {
  if (result.lastError) return result.lastError
  const tail = summarizeStderr(result.stderr)
  if (tail) return tail
  if (result.code !== null) return `轉錄程式異常結束（結束碼 ${result.code}）`
  return `轉錄程式被終止（${result.signal ?? '未知訊號'}）`
}
