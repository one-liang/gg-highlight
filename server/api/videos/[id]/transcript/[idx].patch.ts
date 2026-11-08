import { defineEventHandler, getRouterParam } from 'h3'
import type { TranscriptSegment } from '../../../../../shared/types/domain'
import { getVideoOr404, notFound, parseIndexParam, parseWith, readJsonBody, updateSegmentSchema } from '../../../../lib/api'
import { useServices } from '../../../../lib/services'

export default defineEventHandler(async (event): Promise<TranscriptSegment> => {
  const { repos } = useServices()
  const video = getVideoOr404(repos, getRouterParam(event, 'id'))
  const idx = parseIndexParam(getRouterParam(event, 'idx'), '段落編號')
  const { text } = parseWith(updateSegmentSchema, await readJsonBody(event))
  const segment = repos.transcript.updateText(video.id, idx, text)
  if (!segment) throw notFound('找不到這段逐字稿')
  return segment
})
