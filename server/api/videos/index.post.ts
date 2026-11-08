import fs from 'node:fs/promises'
import path from 'node:path'
import { defineEventHandler } from 'h3'
import type { MediaInfo, SourceVideo } from '../../../shared/types/domain'
import {
  addVideoSchema, badRequest, conflict, forbidden, notFound, parseWith, readJsonBody, titleFromFileName, unprocessable,
} from '../../lib/api'
import { checkAudioTrack } from '../../lib/jobs'
import { isInWatchFolders, resolveUpload, toSourceVideo } from '../../lib/library'
import { probeMedia } from '../../lib/media'
import { useServices } from '../../lib/services'

export default defineEventHandler(async (event): Promise<SourceVideo> => {
  const { config, repos, tools, analysis } = useServices()
  const body = parseWith(addVideoSchema, await readJsonBody(event))

  let filePath: string
  let fileName: string
  if (body.sourceKind === 'watch-folder') {
    if (!body.filePath?.trim()) throw badRequest('請選擇影片資料夾裡的影片檔')
    const requested = body.filePath.trim()
    if (!path.isAbsolute(requested) || !isInWatchFolders(repos.settings.get().watchFolders, requested)) {
      throw forbidden('只能加入設定的影片資料夾裡的影片檔')
    }
    filePath = path.resolve(requested)
    try {
      if (!(await fs.stat(filePath)).isFile()) throw new Error('not a file')
    }
    catch {
      throw notFound('找不到這個影片檔，可能已被移動或刪除')
    }
    fileName = path.basename(filePath)
  }
  else {
    if (!body.uploadId) throw badRequest('缺少上傳編號')
    const upload = await resolveUpload(config, body.uploadId)
    if (!upload) throw notFound('找不到上傳的檔案，請重新上傳')
    filePath = path.resolve(upload.filePath)
    fileName = upload.fileName
  }

  if (repos.videos.findByFilePath(filePath)) throw conflict('這個影片檔已經在影片庫裡了')

  let media: MediaInfo
  try {
    media = await probeMedia(tools, filePath)
  }
  catch (err) {
    throw unprocessable(`無法讀取這個影片檔：${(err as Error).message.split('\n')[0]}`)
  }
  try {
    checkAudioTrack(media, body.audioTrack)
  }
  catch (err) {
    throw unprocessable((err as Error).message)
  }

  const video = repos.videos.insert({
    title: titleFromFileName(fileName),
    sourceKind: body.sourceKind,
    filePath,
    youtubeUrl: null,
    language: body.language,
    audioTrack: body.audioTrack,
    media,
  })
  analysis.kick()
  return toSourceVideo(video)
})
