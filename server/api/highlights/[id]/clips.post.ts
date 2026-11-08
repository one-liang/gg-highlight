import { defineEventHandler, getRouterParam } from 'h3'
import type { Clip } from '../../../../shared/types/domain'
import { conflict, createClipSchema, getHighlightOr404, getVideoOr404, parseWith, readJsonBody, unprocessable } from '../../../lib/api'
import { toClip } from '../../../lib/db'
import { isFile } from '../../../lib/jobs'
import { useServices } from '../../../lib/services'

/** Export: a new queued Clip with a snapshot of the Highlight's current range. */
export default defineEventHandler(async (event): Promise<Clip> => {
  const { repos, exports } = useServices()
  const highlight = getHighlightOr404(repos, getRouterParam(event, 'id'))
  const body = parseWith(createClipSchema, await readJsonBody(event))
  const video = getVideoOr404(repos, highlight.videoId)
  if (video.analysis.status !== 'done') throw conflict('影片分析完成後才能輸出剪輯')
  if (!video.filePath || !(await isFile(video.filePath))) throw unprocessable('找不到原始影片檔，無法輸出剪輯')
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
