// Which files a Library removal may delete, and deleting them. Only paths inside dataDir are ever touched.
import fs from 'node:fs/promises'
import path from 'node:path'
import { type AppConfig, clipsDir, isInside, uploadsDir, videoWorkDir } from '../config'
import type { VideoRecord } from '../db'
import { isStrictlyInside, parseUploadName, pathKey } from './paths'

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** <dataDir>/downloads, where YouTube downloads land (milestone 3). */
export function downloadsDir(config: AppConfig): string {
  return path.join(config.dataDir, 'downloads')
}

/**
 * Files and folders the app created for this video and may delete on removal: its work folder,
 * its clips folder, and the video file itself only for uploads/YouTube downloads. Every path is
 * inside dataDir; Watch Folder originals are never included.
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

/** Deletes the given paths (recursively, ignoring ones already gone) after checking every one is inside dataDir. */
export async function deleteInsideDataDir(config: AppConfig, paths: string[]): Promise<void> {
  for (const p of paths) {
    if (!isStrictlyInside(config.dataDir, p)) throw new Error(`拒絕刪除資料夾以外的路徑：${p}`)
  }
  for (const p of paths) {
    await fs.rm(path.resolve(p), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

/** Deletes ownedPaths (ignoring ones already gone). Refuses any path outside dataDir. */
export async function removeVideoFiles(config: AppConfig, video: VideoRecord): Promise<void> {
  await deleteInsideDataDir(config, ownedPaths(config, video))
}
