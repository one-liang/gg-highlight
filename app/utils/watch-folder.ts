// Watch Folder helpers for the settings page and the "加入影片" picker.
import type { WatchFolderFile } from '../../shared/types/domain'

/** Newest first, filtered by file name or folder (case-insensitive). */
export function filterWatchFolderFiles(files: readonly WatchFolderFile[], query: string): WatchFolderFile[] {
  const q = query.trim().toLowerCase()
  const matched = q
    ? files.filter(f => f.name.toLowerCase().includes(q) || f.folder.toLowerCase().includes(q))
    : files.slice()
  return matched.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt) || a.name.localeCompare(b.name))
}

/**
 * Cleans a typed / pasted folder path: trims, drops the quotes Windows "複製路徑" adds,
 * and removes trailing separators (but keeps a drive root like "C:\").
 */
export function normalizeFolderInput(text: string): string {
  let p = text.trim()
  if (p.length >= 2 && ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith('\'') && p.endsWith('\'')))) {
    p = p.slice(1, -1).trim()
  }
  while (p.length > 1 && /[\\/]$/.test(p) && !/^[a-zA-Z]:[\\/]$/.test(p)) p = p.slice(0, -1)
  return p
}

/** Absolute on Windows ("C:\…", "\\server\share") or POSIX ("/…"). */
export function isAbsoluteFolderPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/')
}

function comparable(p: string): string {
  return normalizeFolderInput(p).replace(/\\/g, '/').toLowerCase()
}

/** Same folder ignoring case and separator style (Windows paths are case-insensitive). */
export function sameFolderPath(a: string, b: string): boolean {
  return comparable(a) === comparable(b)
}

/** Client-side check before PUT /api/settings; the server still validates existence. */
export function validateFolderInput(input: string, existing: readonly string[]): string | null {
  const p = normalizeFolderInput(input)
  if (!p) return '請輸入資料夾路徑'
  if (!isAbsoluteFolderPath(p)) return '請輸入完整的資料夾路徑，例如 C:\\Users\\你的名稱\\Videos'
  if (existing.some(e => sameFolderPath(e, p))) return '這個資料夾已經在清單裡了'
  return null
}
