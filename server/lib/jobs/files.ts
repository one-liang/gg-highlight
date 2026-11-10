// Small file helpers for the jobs.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile()
  }
  catch {
    return false
  }
}

export async function removeQuietly(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
}

/** UTF-8 text written to a temp file and renamed into place. */
export async function writeTextAtomic(target: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const tmp = path.join(path.dirname(target), `${path.basename(target)}.tmp-${randomUUID().slice(0, 8)}`)
  try {
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, target)
  }
  catch (err) {
    await removeQuietly(tmp)
    throw err
  }
}

/** Deletes leftovers of an interrupted run: files in `dir` whose name starts with one of `prefixes`. */
export async function removeLeftovers(dir: string, prefixes: string[]): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  }
  catch {
    return
  }
  await Promise.all(names
    .filter(name => prefixes.some(prefix => name.startsWith(prefix)))
    .map(name => removeQuietly(path.join(dir, name))))
}
