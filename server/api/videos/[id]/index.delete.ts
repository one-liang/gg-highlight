import { defineEventHandler, getRouterParam } from 'h3'
import { getVideoOr404 } from '../../../lib/api'
import { removeVideoFiles } from '../../../lib/library'
import { useServices } from '../../../lib/services'

/** Removes the video from the Library: stops its jobs, deletes its rows, then its files inside data/. */
export default defineEventHandler(async (event): Promise<{ ok: true }> => {
  const { config, repos, analysis, exports } = useServices()
  const video = getVideoOr404(repos, getRouterParam(event, 'id'))
  await analysis.cancel(video.id)
  await exports.cancel(video.id)
  repos.videos.delete(video.id)
  try {
    await removeVideoFiles(config, video)
  }
  catch (err) {
    // The rows are gone already; leftover files are only wasted space.
    console.warn(`[gg-highlight] 刪除影片檔案失敗（${video.id}）：${(err as Error).message}`)
  }
  return { ok: true }
})
