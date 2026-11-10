import { defineEventHandler, getRouterParam } from 'h3'
import type { SourceVideo } from '../../../../shared/types/domain'
import { checkReanalyze, getVideoOr404, parseWith, readJsonBody, reanalyzeSchema } from '../../../lib/api'
import { isFile } from '../../../lib/jobs'
import { toSourceVideo } from '../../../lib/library'
import { useServices } from '../../../lib/services'

/**
 * 重新分析: 'highlights' keeps the Transcript, 'full' transcribes again (design.md「重新分析」); a YouTube
 * video may run 'full' without its downloaded file (the download step gets it again).
 */
export default defineEventHandler(async (event): Promise<SourceVideo> => {
  const { repos, analysis } = useServices()
  const id = getVideoOr404(repos, getRouterParam(event, 'id')).id
  const { mode } = parseWith(reanalyzeSchema, await readJsonBody(event))
  const filePath = repos.videos.get(id)?.filePath
  const sourceExists = !!filePath && await isFile(filePath)
  // Read again after the awaits, so the checks and the enqueue see the same state.
  const video = getVideoOr404(repos, id)
  const activeClips = repos.clips.listByVideo(id).filter(c => c.status === 'queued' || c.status === 'running').length
  checkReanalyze(video, mode, { activeClips, sourceExists })
  analysis.enqueue(id, mode)
  return toSourceVideo(repos.videos.get(id)!)
})
