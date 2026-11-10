import { defineEventHandler, getRouterParam } from 'h3'
import type { SourceVideo } from '../../../../shared/types/domain'
import { checkReanalyze, conflict, getVideoOr404 } from '../../../lib/api'
import { isFile } from '../../../lib/jobs'
import { toSourceVideo } from '../../../lib/library'
import { useServices } from '../../../lib/services'

/**
 * Queues a failed Analysis again in the same mode; a 'full' one obeys the 重新分析 rules (design.md),
 * so a YouTube video is retried even when its downloaded file is gone.
 */
export default defineEventHandler(async (event): Promise<SourceVideo> => {
  const { repos, analysis } = useServices()
  const id = getVideoOr404(repos, getRouterParam(event, 'id')).id
  const filePath = repos.videos.get(id)?.filePath
  const sourceExists = !!filePath && await isFile(filePath)
  // Read again after the await, so the checks and the enqueue see the same state.
  const video = getVideoOr404(repos, id)
  if (video.analysis.status !== 'failed') throw conflict('只有分析失敗的影片可以重試')
  if (video.analysis.mode === 'full') {
    // A failed 'full' re-run leaves the Transcript usable, so Clips may be exporting from it now.
    const activeClips = repos.clips.listByVideo(id).filter(c => c.status === 'queued' || c.status === 'running').length
    checkReanalyze(video, 'full', { activeClips, sourceExists })
  }
  analysis.enqueue(id)
  return toSourceVideo(repos.videos.get(id)!)
})
