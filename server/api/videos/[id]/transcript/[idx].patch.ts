import { defineEventHandler, getRouterParam } from 'h3'
import type { TranscriptSegment } from '../../../../../shared/types/domain'
import { getVideoOr404, notFound, parseIndexParam, parseWith, readJsonBody, requireTranscriptReady, updateSegmentSchema } from '../../../../lib/api'
import { useServices } from '../../../../lib/services'

export default defineEventHandler(async (event): Promise<TranscriptSegment> => {
  const { repos } = useServices()
  const id = getVideoOr404(repos, getRouterParam(event, 'id')).id
  const idx = parseIndexParam(getRouterParam(event, 'idx'), '段落編號')
  const { text } = parseWith(updateSegmentSchema, await readJsonBody(event))
  // A 'full' run that is queued or running would overwrite the edit.
  requireTranscriptReady(getVideoOr404(repos, id), 'editTranscript')
  const segment = repos.transcript.updateText(id, idx, text)
  if (!segment) throw notFound('找不到這段逐字稿')
  return segment
})
