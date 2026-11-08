import { defineEventHandler, getRouterParam } from 'h3'
import type { TranscriptSegment } from '../../../../../shared/types/domain'
import { getVideoOr404 } from '../../../../lib/api'
import { useServices } from '../../../../lib/services'

export default defineEventHandler((event): TranscriptSegment[] => {
  const { repos } = useServices()
  const video = getVideoOr404(repos, getRouterParam(event, 'id'))
  return repos.transcript.list(video.id)
})
