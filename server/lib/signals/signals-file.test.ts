import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../media/test-utils'
import { readSignalsFile, writeSignalsFile } from './signals-file'
import type { SignalsFile } from './types'

const sample: SignalsFile = {
  version: 1,
  loudness: { db: [-100, -42.5, -12, 0] },
  transcript: {
    model: 'qwen3.5:9b',
    moments: [
      { start: 12.3, end: 40, score: 1, reason: '主播被嚇到大叫' },
      { start: 100, end: 130.5, score: 5 / 9, reason: '隊友失誤後一起爆笑' },
    ],
  },
}

describe('signals.json', () => {
  it('round-trips, creating the folder and leaving only the final file', async () => {
    const dir = path.join(await makeTmpDir('gg-signals-'), 'videos', 'v1')
    const file = path.join(dir, 'signals.json')
    await writeSignalsFile(file, sample)
    expect(await readSignalsFile(file)).toEqual(sample)
    expect(await fs.readdir(dir)).toEqual(['signals.json'])
  })

  it('keeps null signals and replaces an existing file', async () => {
    const file = path.join(await makeTmpDir('gg-signals-'), 'signals.json')
    await writeSignalsFile(file, sample)
    const next: SignalsFile = { version: 1, loudness: { db: [-30] }, transcript: null }
    await writeSignalsFile(file, next)
    expect(await readSignalsFile(file)).toEqual(next)
    const empty: SignalsFile = { version: 1, loudness: null, transcript: { model: 'qwen3.5:9b', moments: [] } }
    await writeSignalsFile(file, empty)
    expect(await readSignalsFile(file)).toEqual(empty)
  })

  it('reads a missing, corrupt, other-version or wrongly shaped file as null', async () => {
    const dir = await makeTmpDir('gg-signals-')
    const file = path.join(dir, 'signals.json')
    expect(await readSignalsFile(file)).toBeNull()

    const json = JSON.stringify(sample)
    const bad: [string, string][] = [
      ['empty', ''],
      ['truncated', json.slice(0, json.length / 2)],
      ['not an object', '[1, 2, 3]'],
      ['other version', JSON.stringify({ ...sample, version: 2 })],
      ['no version', JSON.stringify({ loudness: sample.loudness, transcript: sample.transcript })],
      ['db not numbers', JSON.stringify({ ...sample, loudness: { db: ['-12'] } })],
      ['loudness missing', JSON.stringify({ version: 1, transcript: null })],
      ['score above 1', JSON.stringify({ ...sample, transcript: { model: 'm', moments: [{ start: 0, end: 1, score: 7, reason: 'r' }] } })],
      ['moment without reason', JSON.stringify({ ...sample, transcript: { model: 'm', moments: [{ start: 0, end: 1, score: 0.5 }] } })],
      ['model missing', JSON.stringify({ ...sample, transcript: { moments: [] } })],
    ]
    for (const [name, content] of bad) {
      await fs.writeFile(file, content)
      expect(await readSignalsFile(file), name).toBeNull()
    }

    await fs.rm(file)
    await fs.mkdir(file) // a folder where the file should be
    expect(await readSignalsFile(file)).toBeNull()
  })
})
