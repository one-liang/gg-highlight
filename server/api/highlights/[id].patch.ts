import { defineEventHandler, getRouterParam } from 'h3'
import type { Highlight } from '../../../shared/types/domain'
import {
  checkHighlightRange, conflict, getHighlightOr404, getVideoOr404, parseWith, readJsonBody, requireTranscriptReady, updateHighlightSchema,
} from '../../lib/api'
import { useServices } from '../../lib/services'

export default defineEventHandler(async (event): Promise<Highlight> => {
  const { repos } = useServices()
  const id = getHighlightOr404(repos, getRouterParam(event, 'id')).id
  const body = parseWith(updateHighlightSchema, await readJsonBody(event))
  const highlight = getHighlightOr404(repos, id)
  const video = getVideoOr404(repos, highlight.videoId)
  const moves = body.start !== undefined || body.end !== undefined
  if (moves && !video.media) throw conflict('影片還沒讀取完成，暫時無法調整精華片段')
  requireTranscriptReady(video, 'editHighlight')
  const patch: Partial<Pick<Highlight, 'start' | 'end' | 'status'>> = {}
  if (moves) Object.assign(patch, checkHighlightRange(body.start ?? highlight.start, body.end ?? highlight.end, video.media!.durationSec))
  if (body.status !== undefined) patch.status = body.status
  return repos.highlights.update(highlight.id, patch) ?? getHighlightOr404(repos, highlight.id)
})
