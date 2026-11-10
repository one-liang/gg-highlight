// Which files a Library removal may delete, and deleting them. Only paths inside dataDir are ever touched.
import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { type AppConfig, clipsDir, isInside, uploadsDir, videoWorkDir } from '../config'
import type { VideoRecord } from '../db'
import { isStrictlyInside, parseUploadName, pathKey, VIDEO_ID_RE } from './paths'

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** <dataDir>/downloads, where YouTube downloads land: <videoId>.<ext>, <videoId>.live_chat.json and yt-dlp's partial files. */
export function downloadsDir(config: AppConfig): string {
  return path.join(config.dataDir, 'downloads')
}

/**
 * Files and folders the app created for this video and may delete on removal: its work folder,
 * its clips folder, and the video file itself only for uploads/YouTube downloads. Every path is
 * inside dataDir; Watch Folder originals are never included. A YouTube video's other files in
 * downloadsDir need a folder listing: removeVideoFiles adds them (listDownloadFiles).
 */
export function ownedPaths(config: AppConfig, video: VideoRecord): string[] {
  const dataDir = path.resolve(config.dataDir)
  const result: string[] = []
  const add = (p: string) => {
    const resolved = path.resolve(p)
    if (isStrictlyInside(dataDir, resolved) && !result.some(r => pathKey(r) === pathKey(resolved))) result.push(resolved)
  }

  // An id like '..' would turn data/videos/<id> into data itself.
  if (SAFE_ID_RE.test(video.id)) {
    add(videoWorkDir(config, video.id))
    add(clipsDir(config, video.id))
  }

  if (video.filePath) {
    const file = path.resolve(video.filePath)
    if (video.sourceKind === 'upload' && isStrictlyInside(uploadsDir(config), file)) {
      add(file)
      const parsed = parseUploadName(path.basename(file))
      if (parsed && !parsed.part && pathKey(path.dirname(file)) === pathKey(uploadsDir(config))) {
        add(path.join(path.dirname(file), `${parsed.id}.json`))
      }
    }
    else if (video.sourceKind === 'youtube' && isStrictlyInside(downloadsDir(config), file)) {
      add(file)
    }
  }

  return result.filter(p => !protectsOriginal(video, p))
}

/** True when deleting p would delete a Watch Folder original (p is the file or a folder holding it). */
function protectsOriginal(video: VideoRecord, p: string): boolean {
  if (video.sourceKind !== 'watch-folder' || !video.filePath) return false
  return isInside(p, video.filePath)
}

/** Entries directly inside downloadsDir; none when the folder does not exist or cannot be read. */
async function downloadEntries(config: AppConfig): Promise<Dirent[]> {
  try {
    return await fs.readdir(downloadsDir(config), { withFileTypes: true })
  }
  catch {
    return []
  }
}

/**
 * Every file directly inside downloadsDir whose name starts with '<videoId>.': the download, yt-dlp's
 * partial and fragment files (.part, .ytdl, .fNNN.*, .temp.*, .part-FragN), the live chat replay and
 * its .part. Folders are never listed. Empty for an unsafe id or a missing folder; never throws.
 */
export async function listDownloadFiles(config: AppConfig, videoId: string): Promise<string[]> {
  if (!SAFE_ID_RE.test(videoId)) return []
  const prefix = `${videoId}.`
  const dir = downloadsDir(config)
  return (await downloadEntries(config))
    .filter(entry => entry.isFile() && entry.name.startsWith(prefix))
    .map(entry => path.join(dir, entry.name))
}

/** Deletes the given paths (recursively, ignoring ones already gone) after checking every one is inside dataDir. */
export async function deleteInsideDataDir(config: AppConfig, paths: string[]): Promise<void> {
  for (const p of paths) {
    if (!isStrictlyInside(config.dataDir, p)) throw new Error(`拒絕刪除資料夾以外的路徑：${p}`)
  }
  for (const p of paths) {
    await fs.rm(path.resolve(p), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

/**
 * Deletes ownedPaths and, for a YouTube video, every downloadsDir/<id>.* file (also while filePath is
 * still null, e.g. a removal during the download). Ignores paths already gone; refuses any path outside
 * dataDir and never deletes a Watch Folder original.
 */
export async function removeVideoFiles(config: AppConfig, video: VideoRecord): Promise<void> {
  const paths = ownedPaths(config, video)
  if (video.sourceKind === 'youtube') {
    for (const file of await listDownloadFiles(config, video.id)) {
      if (!paths.some(p => pathKey(p) === pathKey(file))) paths.push(file)
    }
  }
  await deleteInsideDataDir(config, paths.filter(p => !protectsOriginal(video, p)))
}

/**
 * Startup tidy-up: deletes the files directly inside downloadsDir whose name before the first '.' is a
 * Source Video id (VIDEO_ID_RE) that is not in knownVideoIds, i.e. leftovers of a removal that could
 * not delete everything. Folders and any other names are never touched. Best effort (a file still held
 * open stays); returns how many files were deleted. Read knownVideoIds before any new download can
 * start, or a just-added video's first file could be taken for an orphan.
 */
export async function cleanupOrphanDownloads(config: AppConfig, knownVideoIds: Iterable<string>): Promise<number> {
  const known = new Set(knownVideoIds)
  const dir = downloadsDir(config)
  let removed = 0
  for (const entry of await downloadEntries(config)) {
    if (!entry.isFile()) continue
    const dot = entry.name.indexOf('.')
    if (dot <= 0) continue
    const id = entry.name.slice(0, dot)
    if (!VIDEO_ID_RE.test(id) || known.has(id)) continue
    try {
      // Not recursive: a folder that replaced the file since the listing makes this fail instead.
      await fs.rm(path.join(dir, entry.name), { force: true, maxRetries: 5, retryDelay: 100 })
      removed++
    }
    catch {
      // Held open by another process (Windows) or gone: try again at the next start.
    }
  }
  return removed
}
