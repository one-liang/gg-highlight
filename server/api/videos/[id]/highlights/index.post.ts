import { defineEventHandler, getRouterParam } from 'h3'
import type { Highlight } from '../../../../../shared/types/domain'
import { checkHighlightRange, conflict, createHighlightSchema, getVideoOr404, parseWith, readJsonBody } from '../../../../lib/api'
import { useServices } from '../../../../lib/services'

/** A manual Highlight, selected from the start. */
export default defineEventHandler(async (event): Promise<Highlight> => {
  const { repos } = useServices()
  const video = getVideoOr404(repos, getRouterParam(event, 'id'))
  const body = parseWith(createHighlightSchema, await readJsonBody(event))
  if (!video.media) throw conflict('影片還沒讀取完成，暫時無法新增精華片段')
  const range = checkHighlightRange(body.start, body.end, video.media.durationSec)
  return repos.highlights.insert({ videoId: video.id, ...range, status: 'selected', origin: 'manual', score: null, reason: null })
})
