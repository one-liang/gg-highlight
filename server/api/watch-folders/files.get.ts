import { defineEventHandler } from 'h3'
import type { WatchFolderFile } from '../../../shared/types/domain'
import { listWatchFolderFiles } from '../../lib/library'
import { useServices } from '../../lib/services'

export default defineEventHandler(async (): Promise<WatchFolderFile[]> => {
  const { repos } = useServices()
  const libraryPaths = new Set(repos.videos.list().map(v => v.filePath).filter((p): p is string => p !== null))
  return listWatchFolderFiles(repos.settings.get().watchFolders, libraryPaths)
})
