// Write-to-temp-then-rename so a crash or abort never leaves a half-written output behind.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** A unique temp file next to `target`, keeping its extension (ffmpeg infers formats from it). */
export function tempSibling(target: string): string {
  const ext = path.extname(target)
  const base = path.basename(target, ext)
  return path.join(path.dirname(target), `${base}.tmp-${randomUUID().slice(0, 8)}${ext}`)
}

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** fs.rename with a few retries: on Windows antivirus or a just-exited process can hold the file briefly. */
async function renameWithRetry(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to)
      return
    }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (attempt >= 5 || !RETRY_CODES.has(code)) throw err
      await new Promise(r => setTimeout(r, 100 * (attempt + 1)))
    }
  }
}

export async function removeQuietly(file: string) {
  await fs.rm(file, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
}

/** Runs `write(tmp)` and renames tmp to `target` on success; removes tmp on failure. */
export async function writeAtomically(target: string, write: (tmp: string) => Promise<void>): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const tmp = tempSibling(target)
  try {
    await write(tmp)
    await renameWithRetry(tmp, target)
  }
  catch (err) {
    await removeQuietly(tmp)
    throw err
  }
}
