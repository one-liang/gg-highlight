import { defineEventHandler, getRouterParam } from 'h3'
import type { SourceVideo } from '../../../../shared/types/domain'
import { getVideoOr404 } from '../../../lib/api'
import { toSourceVideo } from '../../../lib/library'
import { useServices } from '../../../lib/services'

export default defineEventHandler(async (event): Promise<SourceVideo> => {
  const { repos } = useServices()
  return toSourceVideo(getVideoOr404(repos, getRouterParam(event, 'id')))
})
