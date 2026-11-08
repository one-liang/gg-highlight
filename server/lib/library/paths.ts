// Path helpers shared by the library functions.
import fs from 'node:fs/promises'
import path from 'node:path'
import { isInside } from '../config'

export const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.mov', '.flv', '.webm', '.ts', '.m4v', '.avi']

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
export const UPLOAD_ID_RE = new RegExp(`^${UUID}$`)
/** <uploadId><ext>[.part] or the <uploadId>.json sidecar. */
const UPLOAD_NAME_RE = new RegExp(`^(${UUID})(\\.[A-Za-z0-9]+)(\\.part)?$`)

export function isVideoFile(name: string): boolean {
  return VIDEO_EXTENSIONS.includes(path.extname(name).toLowerCase())
}

/** Key for comparing paths: resolved, and lower-cased on Windows where paths are case-insensitive. */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? path.win32.resolve(p).toLowerCase() : path.posix.resolve(p)
}

/** True if target is inside dir and not dir itself. */
export function isStrictlyInside(dir: string, target: string): boolean {
  return path.relative(path.resolve(dir), path.resolve(target)) !== '' && isInside(dir, target)
}

/** Configured folders that can be used: non-blank absolute paths. */
export function usableFolders(folders: string[]): string[] {
  return folders.filter(f => typeof f === 'string' && f.trim() !== '' && path.isAbsolute(f.trim())).map(f => path.resolve(f.trim()))
}

export function parseUploadName(name: string): { id: string, ext: string, part: boolean } | null {
  const match = UPLOAD_NAME_RE.exec(name)
  if (!match) return null
  return { id: match[1]!, ext: match[2]!.toLowerCase(), part: match[3] !== undefined }
}

export async function isExistingFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile()
  }
  catch {
    return false
  }
}
