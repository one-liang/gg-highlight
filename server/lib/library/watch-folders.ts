// Watch Folders: listing their video files and checking that a path belongs to one.
import fs from 'node:fs/promises'
import path from 'node:path'
import type { WatchFolderFile } from '../../../shared/types/domain'
import { isInside } from '../config'
import { isVideoFile, pathKey, usableFolders } from './paths'

/** Video files directly inside each Watch Folder (not recursive), newest first. Missing folders are skipped. */
export async function listWatchFolderFiles(folders: string[], libraryPaths: Set<string>): Promise<WatchFolderFile[]> {
  const library = new Set([...libraryPaths].map(p => pathKey(p)))
  const seenFolders = new Set<string>()
  const files: { file: WatchFolderFile, mtimeMs: number }[] = []

  for (const folder of usableFolders(folders)) {
    const folderKey = pathKey(folder)
    if (seenFolders.has(folderKey)) continue
    seenFolders.add(folderKey)

    let entries
    try {
      entries = await fs.readdir(folder, { withFileTypes: true })
    }
    catch {
      continue
    }
    const candidates = entries.filter(e => (e.isFile() || e.isSymbolicLink()) && isVideoFile(e.name))
    await Promise.all(candidates.map(async (entry) => {
      const filePath = path.join(folder, entry.name)
      try {
        const stat = await fs.stat(filePath)
        if (!stat.isFile()) return
        files.push({
          mtimeMs: stat.mtimeMs,
          file: {
            path: filePath,
            name: entry.name,
            folder,
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            inLibrary: library.has(pathKey(filePath)),
          },
        })
      }
      catch {
        // Unreadable or vanished between readdir and stat.
      }
    }))
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.path.localeCompare(b.file.path))
  return files.map(f => f.file)
}

/** True if filePath is inside one of the Watch Folders and has a video extension. */
export function isInWatchFolders(folders: string[], filePath: string): boolean {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !isVideoFile(filePath)) return false
  const win = process.platform === 'win32'
  const target = path.resolve(filePath)
  return usableFolders(folders).some((folder) => {
    const [dir, file] = win ? [folder.toLowerCase(), target.toLowerCase()] : [folder, target]
    return dir !== file && isInside(dir, file)
  })
}
