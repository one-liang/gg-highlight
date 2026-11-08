import path from 'node:path'
import { defineEventHandler, getQuery, getRouterParam } from 'h3'
import { clipDownloadName, getClipOr404, httpError, notFound } from '../../../lib/api'
import { clipsDir } from '../../../lib/config'
import { serveFile } from '../../../lib/http'
import { useServices } from '../../../lib/services'

/** The clip mp4 (Range supported); ?download=1 sends it as 「影片標題_起點_版型.mp4」. */
export default defineEventHandler(async (event) => {
  if (event.method !== 'GET' && event.method !== 'HEAD') throw httpError(405, '不支援這個請求方法')
  const { config, repos } = useServices()
  const clip = getClipOr404(repos, getRouterParam(event, 'id'))
  if (!clip.fileName) throw notFound('這個剪輯還沒輸出完成')
  const query = getQuery(event)
  const download = query.download === '1' || query.download === 'true'
  const title = repos.videos.get(clip.videoId)?.title ?? '剪輯'
  try {
    return await serveFile(event, path.join(clipsDir(config, clip.videoId), path.basename(clip.fileName)), {
      contentType: 'video/mp4',
      downloadName: download ? clipDownloadName(title, clip.start, clip.layout, '.mp4') : undefined,
    })
  }
  catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) throw notFound('找不到剪輯檔，可能已被刪除')
    throw err
  }
})
