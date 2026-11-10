import type { UploadResult, WatchFolderFile, YoutubeInfo } from '../../shared/types/domain'

/** The file or YouTube video chosen in "加入影片", before the language (/ audio track) form. */
export type PickedSource =
  | { kind: 'watch-folder', file: WatchFolderFile }
  | { kind: 'upload', upload: UploadResult, sizeBytes: number }
  | { kind: 'youtube', info: YoutubeInfo }
