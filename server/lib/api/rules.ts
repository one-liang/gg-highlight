// Business rules of the API: Highlight ranges, Watch Folder settings, titles and download names.
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Layout } from '../../../shared/types/domain'
import { pathKey } from '../library'
import { badRequest, unprocessable } from './errors'

export const MIN_HIGHLIGHT_SECONDS = 0.5
// Times from the UI come from a <video> element and text inputs; allow a millisecond of slack.
const EPS = 0.001

const round3 = (x: number) => Math.round(x * 1000) / 1000

/** m:ss for messages, e.g. 75.4 → "1:15". */
export function clock(sec: number): string {
  const total = Math.max(0, Math.floor(sec))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** 0 <= start < end <= duration and at least 0.5 s long; returns the range rounded to ms. Throws 422. */
export function checkHighlightRange(start: number, end: number, durationSec: number): { start: number, end: number } {
  if (start < 0) throw unprocessable('起點不能小於 0')
  if (end <= start) throw unprocessable('終點必須晚於起點')
  if (end > durationSec + EPS) throw unprocessable(`終點不能超過影片長度（${clock(durationSec)}）`)
  if (start >= durationSec) throw unprocessable(`起點必須在影片長度（${clock(durationSec)}）之內`)
  const range = { start: round3(start), end: round3(Math.min(end, durationSec)) }
  if (range.end - range.start < MIN_HIGHLIGHT_SECONDS - EPS) throw unprocessable(`精華片段至少要 ${MIN_HIGHLIGHT_SECONDS} 秒`)
  return range
}

/** Title of a new Source Video: the file name without its extension. */
export function titleFromFileName(fileName: string): string {
  const base = path.basename(fileName.replace(/\\/g, '/'))
  const title = path.parse(base).name.trim()
  return title || base || '未命名影片'
}

/**
 * Validates and normalises the Watch Folders: each must be an existing absolute directory
 * (a 400 names the bad one); blanks are dropped and duplicates removed (case-insensitive on Windows).
 */
export async function normalizeWatchFolders(input: string[]): Promise<string[]> {
  const result: string[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    let folder = raw.trim()
    if (folder.length >= 2 && /^(["']).*\1$/.test(folder)) folder = folder.slice(1, -1).trim()
    if (!folder) continue
    if (!path.isAbsolute(folder)) throw badRequest(`「${folder}」不是完整的資料夾路徑`)
    const resolved = path.resolve(folder)
    let isDir = false
    try {
      isDir = (await fs.stat(resolved)).isDirectory()
    }
    catch {
      throw badRequest(`找不到資料夾「${folder}」`)
    }
    if (!isDir) throw badRequest(`「${folder}」不是資料夾`)
    const key = pathKey(resolved)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(resolved)
  }
  return result
}

export const LAYOUT_LABELS: Record<Layout, string> = {
  'blurred-background': '模糊背景',
  'center-crop': '置中裁切',
  'original': '原比例',
}

/** Characters Windows does not allow in file names, plus control characters. */
const UNSAFE_FILE_CHARS = /[<>:"/\\|?*\p{Cc}]/gu

export function safeFileNamePart(text: string): string {
  const cleaned = text.replace(UNSAFE_FILE_CHARS, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '')
  return cleaned || '剪輯'
}

/** Clip start for file names: m-ss (minutes may exceed 59), e.g. 75.4 → "1-15". */
export function fileNameClock(sec: number): string {
  return clock(sec).replace(':', '-')
}

/** Download name 「影片標題_起點_版型.ext」, e.g. 我的直播_1-15_模糊背景.mp4. */
export function clipDownloadName(title: string, start: number, layout: Layout, ext: '.mp4' | '.srt'): string {
  return `${safeFileNamePart(title)}_${fileNameClock(start)}_${LAYOUT_LABELS[layout]}${ext}`
}
