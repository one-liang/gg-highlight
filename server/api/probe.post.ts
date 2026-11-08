import fs from 'node:fs/promises'
import path from 'node:path'
import { defineEventHandler } from 'h3'
import type { MediaInfo } from '../../shared/types/domain'
import { forbidden, notFound, parseWith, probeSchema, readJsonBody, unprocessable } from '../lib/api'
import { isInWatchFolders } from '../lib/library'
import { probeMedia } from '../lib/media'
import { useServices } from '../lib/services'

/** MediaInfo of a file inside a Watch Folder (to pick language and audio track before adding it). */
export default defineEventHandler(async (event): Promise<MediaInfo> => {
  const { repos, tools } = useServices()
  const { filePath } = parseWith(probeSchema, await readJsonBody(event))
  if (!path.isAbsolute(filePath) || !isInWatchFolders(repos.settings.get().watchFolders, filePath)) {
    throw forbidden('只能讀取設定的影片資料夾裡的影片檔')
  }
  const resolved = path.resolve(filePath)
  try {
    if (!(await fs.stat(resolved)).isFile()) throw new Error('not a file')
  }
  catch {
    throw notFound('找不到這個影片檔，可能已被移動或刪除')
  }
  try {
    return await probeMedia(tools, resolved)
  }
  catch (err) {
    throw unprocessable(`無法讀取這個影片檔：${(err as Error).message.split('\n')[0]}`)
  }
})
