import { defineEventHandler, getRouterParam } from 'h3'
import type { SourceVideo } from '../../../../shared/types/domain'
import { conflict, getVideoOr404 } from '../../../lib/api'
import { toSourceVideo } from '../../../lib/library'
import { useServices } from '../../../lib/services'

export default defineEventHandler(async (event): Promise<SourceVideo> => {
  const { repos, analysis } = useServices()
  const video = getVideoOr404(repos, getRouterParam(event, 'id'))
  if (video.analysis.status !== 'failed') throw conflict('只有分析失敗的影片可以重試')
  analysis.enqueue(video.id)
  return toSourceVideo(repos.videos.get(video.id)!)
})
