import type { UploadResult, WatchFolderFile } from '../../shared/types/domain'

/** The file chosen in "加入影片", before the language / audio track form. */
export type PickedSource =
  | { kind: 'watch-folder', file: WatchFolderFile }
  | { kind: 'upload', upload: UploadResult, sizeBytes: number }
