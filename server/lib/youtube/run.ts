// Running yt-dlp: argv array (no shell), windowsHide, PYTHONUTF8=1, process-tree kill on abort (runCli),
// both output streams read line by line.
import { isAbortError, runCli } from '../transcription/process'
import { errorLinesOf, exitStatusText, YTDLP_NOT_FOUND_MESSAGE } from './errors'
import { type YtdlpConfig, YtdlpError } from './types'

/** Output lines kept for the log of a failed run. */
const TAIL_LINES = 200

export const YTDLP_CLI_MESSAGES = {
  notFound: YTDLP_NOT_FOUND_MESSAGE,
  emptyCommand: 'yt-dlp 的指令是空的，請檢查 GG_YTDLP_CMD 設定',
  startFailed: '無法啟動 yt-dlp：',
  aborted: 'yt-dlp 已取消',
}

export interface YtdlpRunResult {
  code: number | null
  signal: NodeJS.Signals | null
  /** Lines starting with `ERROR:` from either stream, in order. */
  errorLines: string[]
  /** The last output lines of both streams (stdout lines only when not collected raw). */
  tail: string[]
  /** Whole stdout when `collectStdout` was set, else ''. */
  stdout: string
}

export interface RunYtdlpOptions {
  signal?: AbortSignal
  /** WARNING lines as they come, and the output of a failed run. */
  log?: (message: string) => void
  /** Every stdout line (not called when `collectStdout` is set). */
  onStdoutLine?: (line: string) => void
  /** Keep stdout as one string instead of lines (`-J` prints one possibly multi-megabyte line). */
  collectStdout?: boolean
}

/**
 * Runs `[...config.command, ...args]` to its end (any exit code). Rejects with AbortError after an abort,
 * or YtdlpError('not-installed') when yt-dlp cannot be started.
 */
export async function runYtdlp(config: Pick<YtdlpConfig, 'command'>, args: string[], opts: RunYtdlpOptions = {}): Promise<YtdlpRunResult> {
  const tail: string[] = []
  const errorLines: string[] = []
  const chunks: Buffer[] = []
  const keep = (line: string) => {
    tail.push(line)
    if (tail.length > TAIL_LINES) tail.shift()
  }
  const onLine = (line: string) => {
    const trimmed = line.trim()
    // Progress lines (one per second for hours) would push everything useful out of the tail.
    if (trimmed === '' || trimmed.startsWith('GGDL ')) return
    keep(line)
    if (trimmed.startsWith('WARNING:')) opts.log?.(`[yt-dlp] ${trimmed}`)
    else errorLines.push(...errorLinesOf([trimmed]))
  }

  try {
    const result = await runCli(config.command, args, {
      signal: opts.signal,
      messages: YTDLP_CLI_MESSAGES,
      onLine: opts.collectStdout
        ? undefined
        : (line) => {
            onLine(line)
            opts.onStdoutLine?.(line)
          },
      onStdoutData: opts.collectStdout ? chunk => chunks.push(chunk) : undefined,
      onStderrLine: onLine,
    })
    return {
      code: result.code,
      signal: result.signal,
      errorLines,
      tail,
      stdout: opts.collectStdout ? Buffer.concat(chunks).toString('utf8') : '',
    }
  }
  catch (err) {
    if (isAbortError(err)) throw err
    const message = err instanceof Error ? err.message : String(err)
    const code = (err as { cause?: NodeJS.ErrnoException }).cause?.code
    throw new YtdlpError('not-installed', YTDLP_NOT_FOUND_MESSAGE, code ? `${code}: ${message}` : message)
  }
}

/** Writes the output of a failed run to the log ("完整輸出寫進 log"). */
export function logFailure(log: ((message: string) => void) | undefined, what: string, result: YtdlpRunResult): void {
  if (!log) return
  log(`[yt-dlp] ${what}失敗（${exitStatusText(result)}），輸出：\n${result.tail.join('\n') || '（沒有輸出）'}`)
}
