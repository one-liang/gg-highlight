import path from 'node:path'
import { defineEventHandler, getRouterParam } from 'h3'
import { clipDownloadName, getClipOr404, httpError, notFound } from '../../../lib/api'
import { clipsDir } from '../../../lib/config'
import { serveFile } from '../../../lib/http'
import { useServices } from '../../../lib/services'

/** The clip's .srt as a download (times start at 0 = clip start). */
export default defineEventHandler(async (event) => {
  if (event.method !== 'GET' && event.method !== 'HEAD') throw httpError(405, '不支援這個請求方法')
  const { config, repos } = useServices()
  const clip = getClipOr404(repos, getRouterParam(event, 'id'))
  if (!clip.srtFileName) throw notFound('這個剪輯的字幕檔還沒產生')
  const title = repos.videos.get(clip.videoId)?.title ?? '剪輯'
  try {
    return await serveFile(event, path.join(clipsDir(config, clip.videoId), path.basename(clip.srtFileName)), {
      contentType: 'application/x-subrip; charset=utf-8',
      downloadName: clipDownloadName(title, clip.start, clip.layout, '.srt'),
    })
  }
  catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) throw notFound('找不到字幕檔，可能已被刪除')
    throw err
  }
})
