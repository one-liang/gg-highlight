// Downloading the video file and the live chat replay (design.md「YouTube」→「下載」).
import fs from 'node:fs/promises'
import path from 'node:path'
import { isInside } from '../config'
import { chatDownloadArgs, chatFilePath, chatPartPath, videoDownloadArgs } from './command'
import { exitStatusText, mapYtdlpError, noteUpdateHint } from './errors'
import { DownloadProgress, parseFileLine } from './progress'
import { logFailure, runYtdlp } from './run'
import { type DownloadChatOptions, type DownloadVideoOptions, type YtdlpConfig, YtdlpError } from './types'

export const CHAT_FAILED_PREFIX = '聊天室重播下載失敗'
/** How often the chat .part is read for progress. */
export const CHAT_POLL_MS = 1000
/** Bytes read from the end of the chat .part to find the last complete line (lines are ~2 KB). */
const CHAT_TAIL_BYTES = 256 * 1024

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile()
  }
  catch {
    return false
  }
}

function report(onProgress: ((fraction: number) => void) | undefined, fraction: number): void {
  try {
    onProgress?.(fraction)
  }
  catch (err) {
    console.warn('[yt-dlp] progress handler failed:', err)
  }
}

/**
 * Downloads the video into <downloadsDir>/<videoId>.<ext> and resolves with its absolute path.
 * Success = exit code 0, a GGFILE line, and that file existing inside downloadsDir. Throws YtdlpError
 * or AbortError (partial files stay for yt-dlp to resume).
 */
export async function downloadVideo(config: YtdlpConfig, options: DownloadVideoOptions): Promise<string> {
  const { url, videoId, signal, log, onProgress } = options
  try {
    await fs.mkdir(config.downloadsDir, { recursive: true })
    const progress = new DownloadProgress()
    let reported: string | null = null
    const result = await runYtdlp(config, videoDownloadArgs(config, url, videoId), {
      signal,
      log,
      onStdoutLine: (line) => {
        const fraction = progress.push(line)
        if (fraction !== null) report(onProgress, fraction)
        const file = parseFileLine(line)
        if (file !== null) reported = file
      },
    })

    const filePath = reported === null ? null : path.resolve(config.downloadsDir, reported)
    if (result.code === 0 && filePath && isInside(config.downloadsDir, filePath) && await isFile(filePath)) {
      report(onProgress, 1)
      return filePath
    }
    logFailure(log, '下載影片', result)
    let fallback: string | undefined
    if (result.code === 0) {
      fallback = filePath
        ? `下載失敗：yt-dlp 回報的影片檔不存在或不在下載資料夾裡（${filePath}）`
        : '下載失敗：yt-dlp 沒有回報下載完成的影片檔'
    }
    throw mapYtdlpError(result.errorLines, result, fallback)
  }
  catch (err) {
    await noteUpdateHint(err, config)
    throw err
  }
}

/** videoOffsetTimeMsec of one chat line (inside replayChatItemAction, else at the top level), or null. */
export function chatLineOffsetMs(line: string): number | null {
  let data: unknown
  try {
    data = JSON.parse(line)
  }
  catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const d = data as { replayChatItemAction?: { videoOffsetTimeMsec?: unknown }, videoOffsetTimeMsec?: unknown }
  const raw = d.replayChatItemAction?.videoOffsetTimeMsec ?? d.videoOffsetTimeMsec
  const value = typeof raw === 'string' ? Number(raw) : raw
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Video time (ms) of the last complete line of a chat file being written, or null (no file yet, no
 * complete line, or none of the last lines has a time). Reads only the end of the file.
 */
export async function lastChatOffsetMs(file: string): Promise<number | null> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(file, 'r')
    const { size } = await handle.stat()
    const length = Math.min(size, CHAT_TAIL_BYTES)
    if (length === 0) return null
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const text = buffer.toString('utf8')
    const end = text.lastIndexOf('\n')
    if (end < 0) return null
    // The first piece may be cut by the read window; it is tried last and simply fails to parse.
    const lines = text.slice(0, end).split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const offset = chatLineOffsetMs(lines[i]!)
      if (offset !== null) return offset
    }
    return null
  }
  catch {
    return null
  }
  finally {
    await handle?.close().catch(() => {})
  }
}

export interface ChatDownloadInternals {
  /** Interval of the progress reads of the .part (tests use a short one). */
  pollMs?: number
}

/**
 * Downloads the live chat replay to <downloadsDir>/<videoId>.live_chat.json, deleting a stale .part
 * first (yt-dlp would append a second copy to it). Success = the final file exists, whatever the exit
 * code. Progress = last written videoOffsetTimeMsec ÷ duration, read from the .part about every second.
 */
export async function downloadChat(config: YtdlpConfig, options: DownloadChatOptions, internals: ChatDownloadInternals = {}): Promise<string> {
  const { url, videoId, durationSec, signal, log, onProgress } = options
  const finalPath = chatFilePath(config.downloadsDir, videoId)
  const partPath = chatPartPath(config.downloadsDir, videoId)
  let poller: NodeJS.Timeout | undefined
  try {
    await fs.mkdir(config.downloadsDir, { recursive: true })
    await fs.rm(partPath, { force: true })

    let last = 0
    let reading = false
    poller = setInterval(() => {
      if (reading || !(durationSec > 0)) return
      reading = true
      lastChatOffsetMs(partPath)
        .then((ms) => {
          if (ms === null || poller === undefined) return
          const fraction = Math.min(1, Math.max(0, ms / 1000 / durationSec))
          if (fraction > last) {
            last = fraction
            report(onProgress, fraction)
          }
        })
        .finally(() => {
          reading = false
        })
    }, internals.pollMs ?? CHAT_POLL_MS)
    poller.unref?.()

    const result = await runYtdlp(config, chatDownloadArgs(config, url, videoId), { signal, log })
    clearInterval(poller)
    poller = undefined

    if (await isFile(finalPath)) {
      if (result.code !== 0) log?.(`[yt-dlp] 聊天室重播已下載，但 yt-dlp ${exitStatusText(result)}`)
      report(onProgress, 1)
      return finalPath
    }
    logFailure(log, '下載聊天室重播', result)
    if (result.errorLines.length > 0) throw mapYtdlpError(result.errorLines, result)
    throw new YtdlpError('unknown', `${CHAT_FAILED_PREFIX}：yt-dlp 沒有寫出聊天室檔案（${exitStatusText(result)}）`, exitStatusText(result))
  }
  catch (err) {
    await noteUpdateHint(err, config)
    throw err
  }
  finally {
    if (poller !== undefined) clearInterval(poller)
  }
}
