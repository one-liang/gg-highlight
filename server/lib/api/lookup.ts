// Loading records by route id (404 when unknown) and reading JSON bodies.
import { type H3Event, readBody } from 'h3'
import type { Highlight } from '../../../shared/types/domain'
import type { ClipRecord, Repositories, VideoRecord } from '../db'
import { badRequest, notFound } from './errors'

export function getVideoOr404(repos: Repositories, id: string | undefined): VideoRecord {
  const video = id ? repos.videos.get(id) : null
  if (!video) throw notFound('找不到這支影片')
  return video
}

export function getHighlightOr404(repos: Repositories, id: string | undefined): Highlight {
  const highlight = id ? repos.highlights.get(id) : null
  if (!highlight) throw notFound('找不到這個精華片段')
  return highlight
}

export function getClipOr404(repos: Repositories, id: string | undefined): ClipRecord {
  const clip = id ? repos.clips.get(id) : null
  if (!clip) throw notFound('找不到這個剪輯')
  return clip
}

/** readBody with a Chinese 400 for malformed JSON. */
export async function readJsonBody(event: H3Event): Promise<unknown> {
  try {
    return await readBody(event)
  }
  catch {
    throw badRequest('請求內容不是正確的 JSON')
  }
}
