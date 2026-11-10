import { defineEventHandler } from 'h3'
import type { YoutubeInfo } from '../../../shared/types/domain'
import { parseWith, probeYoutube, readJsonBody, youtubeProbeSchema } from '../../lib/api'
import { useServices } from '../../lib/services'

/**
 * What the YouTube tab shows before adding (design.md「YouTube」→「加入」): 400 not a YouTube link, 422
 * playlist / channel / live / private…, 502 YouTube or yt-dlp failed. The read is cached for 30 minutes.
 */
export default defineEventHandler(async (event): Promise<YoutubeInfo> => {
  const { repos, youtube, metadataCache } = useServices()
  const { url } = parseWith(youtubeProbeSchema, await readJsonBody(event))
  return probeYoutube({ repos, youtube, metadataCache, log: message => console.log(message) }, url)
})
