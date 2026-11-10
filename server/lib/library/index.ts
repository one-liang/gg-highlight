// Library-level file rules: Watch Folders, uploads, and which files a removal may delete.
//   paths.ts          extensions, path comparison, upload file names
//   watch-folders.ts  listWatchFolderFiles, isInWatchFolders
//   uploads.ts        saveUpload, resolveUpload, cleanupOrphanUploads
//   removal.ts        ownedPaths, listDownloadFiles, removeVideoFiles, cleanupOrphanDownloads
import type { SourceVideo } from '../../../shared/types/domain'
import type { VideoRecord } from '../db'
import { isExistingFile } from './paths'

export { isStrictlyInside, isVideoFile, pathKey, VIDEO_EXTENSIONS } from './paths'
export { isInWatchFolders, listWatchFolderFiles } from './watch-folders'
export { cleanFileName, cleanupOrphanUploads, isUploadId, resolveUpload, saveUpload } from './uploads'
export {
  cleanupOrphanDownloads, deleteInsideDataDir, downloadsDir, listDownloadFiles, ownedPaths, removeVideoFiles,
} from './removal'

/** VideoRecord → SourceVideo (youtube metadata included) with fileMissing checked on disk. */
export async function toSourceVideo(video: VideoRecord): Promise<SourceVideo> {
  const { previewPath: _previewPath, ...rest } = video
  const fileMissing = video.filePath !== null && !(await isExistingFile(video.filePath))
  return { ...rest, fileMissing }
}
