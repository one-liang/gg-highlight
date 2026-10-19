// Library-level file rules: Watch Folders, uploads, and which files a removal may delete.
import type { Readable } from 'node:stream'
import type { SourceVideo, WatchFolderFile } from '../../../shared/types/domain'
import type { AppConfig } from '../config'
import type { VideoRecord } from '../db'

export const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.mov', '.flv', '.webm', '.ts', '.m4v', '.avi']

/** Video files directly inside each Watch Folder (not recursive), newest first. Missing folders are skipped. */
export function listWatchFolderFiles(folders: string[], libraryPaths: Set<string>): Promise<WatchFolderFile[]> {
  throw new Error('not implemented')
}

/** True if filePath is inside one of the Watch Folders and has a video extension. */
export function isInWatchFolders(folders: string[], filePath: string): boolean {
  throw new Error('not implemented')
}

/** Streams an upload into <dataDir>/uploads/<uploadId><ext>. The original name is kept for the title. */
export function saveUpload(config: AppConfig, originalName: string, body: Readable): Promise<{ uploadId: string, filePath: string, fileName: string }> {
  throw new Error('not implemented')
}

/** Absolute path of a saved upload, or null when the id is unknown/invalid. */
export function resolveUpload(config: AppConfig, uploadId: string): Promise<{ filePath: string, fileName: string } | null> {
  throw new Error('not implemented')
}

/** Deletes upload files no video points at and older than olderThanMs. Returns how many were removed. */
export function cleanupOrphanUploads(config: AppConfig, referencedPaths: Set<string>, olderThanMs: number): Promise<number> {
  throw new Error('not implemented')
}

/**
 * Files and folders the app created for this video and may delete on removal: its work folder,
 * its clips folder, and the video file itself only for uploads/YouTube downloads. Every path is
 * inside dataDir; Watch Folder originals are never included.
 */
export function ownedPaths(config: AppConfig, video: VideoRecord): string[] {
  throw new Error('not implemented')
}

/** Deletes ownedPaths (ignoring ones already gone). Refuses any path outside dataDir. */
export function removeVideoFiles(config: AppConfig, video: VideoRecord): Promise<void> {
  throw new Error('not implemented')
}

/** VideoRecord → SourceVideo with fileMissing checked on disk. */
export function toSourceVideo(video: VideoRecord): Promise<SourceVideo> {
  throw new Error('not implemented')
}
