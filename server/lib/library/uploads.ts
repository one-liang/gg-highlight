// Drag-and-drop uploads: streamed into <dataDir>/uploads/<uploadId><ext> with a <uploadId>.json sidecar.
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { type AppConfig, uploadsDir } from '../config'
import { isExistingFile, isVideoFile, parseUploadName, pathKey, UPLOAD_ID_RE, VIDEO_EXTENSIONS } from './paths'

interface UploadSidecar {
  fileName: string
  createdAt: string
}

const RM_OPTIONS = { force: true, maxRetries: 5, retryDelay: 100 } as const
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** On Windows an antivirus scan can hold a just-written file for a moment. */
async function renameWithRetry(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(from, to)
    }
    catch (err) {
      if (attempt >= 5 || !RETRY_CODES.has((err as NodeJS.ErrnoException).code ?? '')) throw err
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
}

/** Best effort: cleanup must not stop at a file another process still holds open. */
async function tryRemove(file: string): Promise<boolean> {
  try {
    await fs.rm(file, RM_OPTIONS)
    return true
  }
  catch {
    return false
  }
}

/** Base name of a browser-supplied file name: no folders, no control characters. */
export function cleanFileName(originalName: string): string {
  const base = String(originalName ?? '').split(/[\\/]/).pop() ?? ''
  return base.replace(/[\u0000-\u001f\u007f]/g, '').trim()
}

export function isUploadId(uploadId: string): boolean {
  return typeof uploadId === 'string' && UPLOAD_ID_RE.test(uploadId)
}

function sidecarPath(config: AppConfig, uploadId: string): string {
  return path.join(uploadsDir(config), `${uploadId}.json`)
}

/** Streams an upload into <dataDir>/uploads/<uploadId><ext>. The original name is kept for the title. */
export async function saveUpload(config: AppConfig, originalName: string, body: Readable): Promise<{ uploadId: string, filePath: string, fileName: string }> {
  const fileName = cleanFileName(originalName)
  const ext = path.extname(fileName).toLowerCase()
  if (!fileName || !isVideoFile(fileName)) throw new Error('不支援的檔案格式')

  const uploadId = randomUUID()
  const dir = uploadsDir(config)
  const filePath = path.join(dir, `${uploadId}${ext}`)
  const partPath = `${filePath}.part`
  const sidecar = sidecarPath(config, uploadId)
  await fs.mkdir(dir, { recursive: true })

  try {
    await pipeline(body, createWriteStream(partPath))
    const meta: UploadSidecar = { fileName, createdAt: new Date().toISOString() }
    await fs.writeFile(sidecar, JSON.stringify(meta), 'utf8')
    await renameWithRetry(partPath, filePath)
  }
  catch (err) {
    await Promise.all([partPath, filePath, sidecar].map(tryRemove))
    throw err
  }
  return { uploadId, filePath, fileName }
}

/** Absolute path of a saved upload, or null when the id is unknown/invalid. */
export async function resolveUpload(config: AppConfig, uploadId: string): Promise<{ filePath: string, fileName: string } | null> {
  if (!isUploadId(uploadId)) return null
  let meta: Partial<UploadSidecar>
  try {
    meta = JSON.parse(await fs.readFile(sidecarPath(config, uploadId), 'utf8')) as Partial<UploadSidecar>
  }
  catch {
    return null
  }
  const fileName = typeof meta.fileName === 'string' ? meta.fileName : ''
  const ext = path.extname(fileName).toLowerCase()
  if (!VIDEO_EXTENSIONS.includes(ext)) return null
  const filePath = path.join(uploadsDir(config), `${uploadId}${ext}`)
  if (!(await isExistingFile(filePath))) return null
  return { filePath, fileName }
}

/** Deletes upload files no video points at and older than olderThanMs. Returns how many were removed. */
export async function cleanupOrphanUploads(config: AppConfig, referencedPaths: Set<string>, olderThanMs: number): Promise<number> {
  const dir = uploadsDir(config)
  let names: string[]
  try {
    names = await fs.readdir(dir)
  }
  catch {
    return 0
  }
  const referenced = new Set([...referencedPaths].map(p => pathKey(p)))
  const cutoff = Date.now() - olderThanMs
  const isOld = async (file: string) => {
    try {
      return (await fs.stat(file)).mtimeMs <= cutoff
    }
    catch {
      return false
    }
  }

  const keptIds = new Set<string>()
  const removedIds = new Set<string>()
  const sidecars: { id: string, file: string }[] = []
  let removed = 0

  for (const name of names) {
    const parsed = parseUploadName(name)
    if (!parsed) continue
    const file = path.join(dir, name)
    if (parsed.ext === '.json' && !parsed.part) {
      sidecars.push({ id: parsed.id, file })
      continue
    }
    if (!VIDEO_EXTENSIONS.includes(parsed.ext)) continue
    if (!parsed.part && referenced.has(pathKey(file))) {
      keptIds.add(parsed.id)
      continue
    }
    if (await isOld(file) && await tryRemove(file)) {
      removedIds.add(parsed.id)
      removed++
    }
    else {
      keptIds.add(parsed.id)
    }
  }

  for (const { id, file } of sidecars) {
    if (keptIds.has(id)) continue
    if (removedIds.has(id) || await isOld(file)) await tryRemove(file)
  }
  return removed
}
