import type { SignalsFile } from './types'

/** Reads data/videos/<id>/signals.json; null when missing or unreadable (never throws). */
export async function readSignalsFile(_path: string): Promise<SignalsFile | null> {
  throw new Error('not implemented')
}

/** Writes signals.json atomically (temp file + rename). */
export async function writeSignalsFile(_path: string, _data: SignalsFile): Promise<void> {
  throw new Error('not implemented')
}
