// data/videos/<id>/signals.json: raw Signal results of the last run, so「只重新找精華片段」can reuse the loudness.
import fs from 'node:fs/promises'
import { z } from 'zod'
import { writeAtomically } from '../media/files'
import type { SignalsFile } from './types'

const loudnessSchema = z.object({
  db: z.array(z.number()),
})

const momentSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  score: z.number().min(0).max(1),
  reason: z.string(),
})

export const signalsFileSchema = z.object({
  version: z.literal(1),
  loudness: loudnessSchema.nullable(),
  transcript: z.object({
    model: z.string(),
    moments: z.array(momentSchema),
  }).nullable(),
})

// Compile-time check that the schema produces SignalsFile.
type Assert<T extends true> = T
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
export type _SignalsFileMatches = Assert<Same<z.infer<typeof signalsFileSchema>, SignalsFile>>

/** Reads data/videos/<id>/signals.json; null when missing or unreadable (never throws). */
export async function readSignalsFile(path: string): Promise<SignalsFile | null> {
  try {
    const parsed = signalsFileSchema.safeParse(JSON.parse(await fs.readFile(path, 'utf8')))
    return parsed.success ? parsed.data : null
  }
  catch {
    return null
  }
}

/** Writes signals.json atomically (temp file + rename). */
export async function writeSignalsFile(path: string, data: SignalsFile): Promise<void> {
  const json = JSON.stringify(data)
  await writeAtomically(path, tmp => fs.writeFile(tmp, json, 'utf8'))
}
