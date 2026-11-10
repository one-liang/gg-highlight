import { defineEventHandler, getRouterParam } from 'h3'
import { getVideoOr404, httpError, missingFileMessage, notFound } from '../../../lib/api'
import { serveFile } from '../../../lib/http'
import { isFile } from '../../../lib/jobs'
import { useServices } from '../../../lib/services'

/** The browser preview when there is one, else the source file (Range requests supported). */
export default defineEventHandler(async (event) => {
  if (event.method !== 'GET' && event.method !== 'HEAD') throw httpError(405, '不支援這個請求方法')
  const { repos } = useServices()
  const video = getVideoOr404(repos, getRouterParam(event, 'id'))
  const file = video.previewPath && await isFile(video.previewPath) ? video.previewPath : video.filePath
  if (!file) throw notFound('找不到影片檔')
  try {
    return await serveFile(event, file)
  }
  catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) throw notFound(missingFileMessage(video, 'media'))
    throw err
  }
})
