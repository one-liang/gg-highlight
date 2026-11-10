import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../media/test-utils'
import { readSignalsFile, writeSignalsFile } from './signals-file'
import type { SignalsFile } from './types'

const sample: SignalsFile = {
  version: 2,
  loudness: { db: [-100, -42.5, -12, 0] },
  transcript: {
    model: 'qwen3.5:9b',
    moments: [
      { start: 12.3, end: 40, score: 1, reason: '主播被嚇到大叫' },
      { start: 100, end: 130.5, score: 5 / 9, reason: '隊友失誤後一起爆笑' },
    ],
  },
  heatmap: {
    markers: [
      { start: 0, end: 36.2, value: 1 },
      { start: 36.2, end: 72.4, value: 0.25 },
      { start: 72.4, end: 108.6, value: 0 },
    ],
    fetchedAt: '2026-11-09T08:00:00.000Z',
  },
}

/** A milestone 2 file, as analysis wrote it before version 2. */
const version1 = { version: 1, loudness: sample.loudness, transcript: sample.transcript }

describe('signals.json', () => {
  it('round-trips, creating the folder and leaving only the final file', async () => {
    const dir = path.join(await makeTmpDir('gg-signals-'), 'videos', 'v1')
    const file = path.join(dir, 'signals.json')
    await writeSignalsFile(file, sample)
    expect(await readSignalsFile(file)).toEqual(sample)
    expect(await fs.readdir(dir)).toEqual(['signals.json'])
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ version: 2 })
  })

  it('keeps null signals and replaces an existing file', async () => {
    const file = path.join(await makeTmpDir('gg-signals-'), 'signals.json')
    await writeSignalsFile(file, sample)
    const next: SignalsFile = { version: 2, loudness: { db: [-30] }, transcript: null, heatmap: null }
    await writeSignalsFile(file, next)
    expect(await readSignalsFile(file)).toEqual(next)
    const empty: SignalsFile = { version: 2, loudness: null, transcript: { model: 'qwen3.5:9b', moments: [] }, heatmap: { markers: [], fetchedAt: '2026-11-09T08:00:00.000Z' } }
    await writeSignalsFile(file, empty)
    expect(await readSignalsFile(file)).toEqual(empty)
  })

  it('reads a version 1 file as version 2 without a heatmap, keeping the cached loudness', async () => {
    const file = path.join(await makeTmpDir('gg-signals-'), 'signals.json')
    await fs.writeFile(file, JSON.stringify(version1))
    expect(await readSignalsFile(file)).toEqual({ ...sample, heatmap: null })

    await fs.writeFile(file, JSON.stringify({ version: 1, loudness: null, transcript: null }))
    expect(await readSignalsFile(file)).toEqual({ version: 2, loudness: null, transcript: null, heatmap: null })

    // A heatmap in a version 1 file is not trusted (version 1 never had one).
    await fs.writeFile(file, JSON.stringify({ ...version1, heatmap: sample.heatmap }))
    expect(await readSignalsFile(file)).toEqual({ ...sample, heatmap: null })
  })

  it('reads a missing, corrupt, other-version or wrongly shaped file as null', async () => {
    const dir = await makeTmpDir('gg-signals-')
    const file = path.join(dir, 'signals.json')
    expect(await readSignalsFile(file)).toBeNull()

    const json = JSON.stringify(sample)
    const marker = sample.heatmap!.markers[0]!
    const bad: [string, string][] = [
      ['empty', ''],
      ['truncated', json.slice(0, json.length / 2)],
      ['not an object', '[1, 2, 3]'],
      ['other version', JSON.stringify({ ...sample, version: 3 })],
      ['version as a string', JSON.stringify({ ...sample, version: '2' })],
      ['no version', JSON.stringify({ loudness: sample.loudness, transcript: sample.transcript, heatmap: null })],
      ['db not numbers', JSON.stringify({ ...sample, loudness: { db: ['-12'] } })],
      ['loudness missing', JSON.stringify({ version: 2, transcript: null, heatmap: null })],
      ['heatmap missing in version 2', JSON.stringify({ ...version1, version: 2 })],
      ['heatmap without fetchedAt', JSON.stringify({ ...sample, heatmap: { markers: [] } })],
      ['heatmap markers not a list', JSON.stringify({ ...sample, heatmap: { markers: {}, fetchedAt: 'x' } })],
      ['marker value not a number', JSON.stringify({ ...sample, heatmap: { ...sample.heatmap, markers: [{ ...marker, value: '1' }] } })],
      ['marker without end', JSON.stringify({ ...sample, heatmap: { ...sample.heatmap, markers: [{ start: 0, value: 1 }] } })],
      ['score above 1', JSON.stringify({ ...sample, transcript: { model: 'm', moments: [{ start: 0, end: 1, score: 7, reason: 'r' }] } })],
      ['moment without reason', JSON.stringify({ ...sample, transcript: { model: 'm', moments: [{ start: 0, end: 1, score: 0.5 }] } })],
      ['model missing', JSON.stringify({ ...sample, transcript: { moments: [] } })],
      ['version 1 with bad loudness', JSON.stringify({ ...version1, loudness: { db: 'x' } })],
      ['version 1 without transcript', JSON.stringify({ version: 1, loudness: null })],
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
