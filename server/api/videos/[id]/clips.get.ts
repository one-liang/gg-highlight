import { defineEventHandler, getRouterParam } from 'h3'
import type { Clip } from '../../../../shared/types/domain'
import { getVideoOr404 } from '../../../lib/api'
import { toClip } from '../../../lib/db'
import { useServices } from '../../../lib/services'

export default defineEventHandler((event): Clip[] => {
  const { repos } = useServices()
  const video = getVideoOr404(repos, getRouterParam(event, 'id'))
  return repos.clips.listByVideo(video.id).map(toClip)
})
