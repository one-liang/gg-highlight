import path from 'node:path'
import { defineEventHandler, getRequestHeader } from 'h3'
import type { MediaInfo, UploadResult } from '../../shared/types/domain'
import { badRequest, httpError, unreadableVideo } from '../lib/api'
import { uploadsDir } from '../lib/config'
import { cleanFileName, deleteInsideDataDir, isVideoFile, saveUpload, VIDEO_EXTENSIONS } from '../lib/library'
import { probeMedia } from '../lib/media'
import { useServices } from '../lib/services'

/** Drag-and-drop upload: the raw body is streamed to data/uploads/ (never buffered), then probed. */
export default defineEventHandler(async (event): Promise<UploadResult> => {
  const { config, tools } = useServices()
  const header = getRequestHeader(event, 'x-file-name')
  if (!header) throw badRequest('缺少檔案名稱（X-File-Name）')
  let originalName: string
  try {
    originalName = cleanFileName(decodeURIComponent(header))
  }
  catch {
    throw badRequest('檔案名稱的編碼不正確')
  }
  if (!originalName) throw badRequest('缺少檔案名稱（X-File-Name）')
  if (!isVideoFile(originalName)) {
    throw httpError(415, `不支援這種檔案，請上傳影片檔（${VIDEO_EXTENSIONS.join('、')}）`)
  }

  // Node's http server drops requests that take longer than 5 minutes (requestTimeout → 408);
  // a multi-GB recording can take longer than that, so lift the limit (single-user, local server).
  const httpServer = (event.node.req.socket as { server?: { requestTimeout?: number } }).server
  if (httpServer?.requestTimeout) httpServer.requestTimeout = 0

  let saved: Awaited<ReturnType<typeof saveUpload>>
  try {
    saved = await saveUpload(config, originalName, event.node.req)
  }
  catch (err) {
    throw httpError(500, `上傳失敗：${(err as Error).message}`)
  }

  let media: MediaInfo
  try {
    media = await probeMedia(tools, saved.filePath)
  }
  catch (err) {
    const sidecar = path.join(uploadsDir(config), `${saved.uploadId}.json`)
    await deleteInsideDataDir(config, [saved.filePath, sidecar]).catch(() => {})
    throw unreadableVideo(err)
  }
  return { uploadId: saved.uploadId, fileName: saved.fileName, media }
})
