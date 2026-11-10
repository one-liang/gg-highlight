import { defineEventHandler, getRouterParam } from 'h3'
import type { Clip } from '../../../../shared/types/domain'
import {
  createClipSchema, getHighlightOr404, getVideoOr404, missingFileMessage, parseWith, readJsonBody, requireTranscriptReady,
  unprocessable,
} from '../../../lib/api'
import { toClip } from '../../../lib/db'
import { isFile } from '../../../lib/jobs'
import { useServices } from '../../../lib/services'

/** Export: a new queued Clip with a snapshot of the Highlight's current range. */
export default defineEventHandler(async (event): Promise<Clip> => {
  const { repos, exports } = useServices()
  const highlightId = getHighlightOr404(repos, getRouterParam(event, 'id')).id
  const body = parseWith(createClipSchema, await readJsonBody(event))
  const filePath = getVideoOr404(repos, getHighlightOr404(repos, highlightId).videoId).filePath
  const sourceExists = !!filePath && await isFile(filePath)
  // Read again after the awaits: a 'full' re-analysis may have been queued meanwhile.
  const highlight = getHighlightOr404(repos, highlightId)
  const video = getVideoOr404(repos, highlight.videoId)
  requireTranscriptReady(video, 'export')
  if (!sourceExists) throw unprocessable(missingFileMessage(video, 'export'))
  const clip = repos.clips.insert({
    videoId: video.id,
    highlightId: highlight.id,
    start: highlight.start,
    end: highlight.end,
    layout: body.layout,
    burnSubtitles: body.burnSubtitles,
  })
  exports.enqueue(clip.id)
  return toClip(clip)
})
