import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractAudio } from '../media/audio'
import { makeTmpDir, tools } from '../media/test-utils'
import { loudnessTrack, readLoudnessEnvelope, rollingMedian, SILENCE_DB, WavLoudnessParser } from './loudness'
import {
  concatSamples, dcDb, dcPower, extensibleFmt, ffmpegListChunk, generate, interleave, makeWav, pcmFmt, referenceDb,
} from './test-helpers/wav'
import type { WavSpec } from './test-helpers/wav'

const dc = (sampleRate: number, seconds: number, level: number) => generate(sampleRate, seconds, () => level)

async function writeWav(spec: WavSpec | Buffer, name = 'audio.wav'): Promise<string> {
  const file = path.join(await makeTmpDir('gg-signals-'), name)
  await fs.writeFile(file, Buffer.isBuffer(spec) ? spec : makeWav(spec))
  return file
}

describe('readLoudnessEnvelope', () => {
  it('parses ffmpeg\'s layout (fmt 16 + LIST 26, data at byte 70) and gives dBFS per second', async () => {
    const wav = makeWav({ sampleRate: 16000, channels: 1, samples: dc(16000, 3, 0.5), beforeData: [ffmpegListChunk()] })
    expect(wav.indexOf('data')).toBe(70)
    const envelope = await readLoudnessEnvelope(await writeWav(wav))
    expect(envelope.db).toEqual([-6, -6, -6])
    expect(dcDb(0.5)).toBe(-6)
  })

  it('averages power over the 3 s window centred on each second', async () => {
    // Per second: quiet, quiet, quiet, loud, loud, quiet
    const levels = [0.01, 0.01, 0.01, 0.5, 0.5, 0.01]
    const samples = concatSamples(...levels.map(l => dc(16000, 1, l)))
    const envelope = await readLoudnessEnvelope(await writeWav({ sampleRate: 16000, channels: 1, samples, beforeData: [ffmpegListChunk()] }))
    expect(envelope.db).toEqual(referenceDb(levels.map(dcPower)))
    expect(envelope.db[0]).toBe(-40)
    expect(envelope.db[3]).toBeGreaterThan(envelope.db[1]!)
  })

  it('averages the channels of stereo audio (and copes with frames split across reads)', async () => {
    // 8 s of 44.1 kHz stereo is larger than one read, and data at byte 70 splits a 4-byte frame there.
    const left = dc(44100, 8, 0.5)
    const right = dc(44100, 8, 0)
    const envelope = await readLoudnessEnvelope(await writeWav({
      sampleRate: 44100, channels: 2, samples: interleave(left, right), beforeData: [ffmpegListChunk()],
    }))
    expect(envelope.db).toEqual(Array.from({ length: 8 }, () => -12))
  })

  it('reads 8 kHz audio', async () => {
    const levels = [0, 0, 0, 0.25, 0.25]
    const samples = concatSamples(...levels.map(l => dc(8000, 1, l)))
    const envelope = await readLoudnessEnvelope(await writeWav({ sampleRate: 8000, channels: 1, samples }))
    expect(envelope.db).toEqual(referenceDb(levels.map(dcPower)))
    expect(envelope.db[0]).toBe(SILENCE_DB)
    expect(envelope.db[4]).toBe(dcDb(0.25))
  })

  it('handles an odd sample rate and a partial last second', async () => {
    const levels = [0.1, 0.1, 0.4]
    const samples = concatSamples(dc(11025, 1, 0.1), dc(11025, 1, 0.1), dc(11025, 0.5, 0.4))
    const envelope = await readLoudnessEnvelope(await writeWav({ sampleRate: 11025, channels: 1, samples }))
    expect(envelope.db).toEqual(referenceDb(levels.map(dcPower), 0.5))
  })

  it('accepts WAVE_FORMAT_EXTENSIBLE PCM and skips odd-sized chunks with their pad byte', async () => {
    const envelope = await readLoudnessEnvelope(await writeWav({
      sampleRate: 16000,
      channels: 2,
      samples: interleave(dc(16000, 2, 0.25), dc(16000, 2, 0.25)),
      fmt: extensibleFmt(16000, 2),
      beforeFmt: [{ id: 'junk', data: Buffer.from('abc') }],
      beforeData: [{ id: 'fact', data: Buffer.alloc(5) }],
    }))
    expect(envelope.db).toEqual([dcDb(0.25), dcDb(0.25)])
  })

  it('reads to the end of the file when the data size is unknown or larger than the file', async () => {
    const samples = dc(16000, 2, 0.5)
    const unknown = await readLoudnessEnvelope(await writeWav({ sampleRate: 16000, channels: 1, samples, dataSize: 0xFFFFFFFF }))
    expect(unknown.db).toEqual([-6, -6])
    const truncated = await readLoudnessEnvelope(await writeWav({ sampleRate: 16000, channels: 1, samples, dataSize: 16000 * 2 * 10 }))
    expect(truncated.db).toEqual([-6, -6])
  })

  it('ignores chunks after the audio', async () => {
    const envelope = await readLoudnessEnvelope(await writeWav({
      sampleRate: 16000, channels: 1, samples: dc(16000, 1, 0.5), afterData: [{ id: 'LIST', data: Buffer.alloc(33, 0x7F) }],
    }))
    expect(envelope.db).toEqual([-6])
  })

  it('gives -100 dBFS for silence', async () => {
    const envelope = await readLoudnessEnvelope(await writeWav({ sampleRate: 16000, channels: 1, samples: new Int16Array(16000 * 5) }))
    expect(envelope.db).toEqual([-100, -100, -100, -100, -100])
    expect(Array.from(loudnessTrack(envelope, 5))).toEqual([0, 0, 0, 0, 0])
  })

  it('gives one value for audio shorter than a second, and none for no samples', async () => {
    const short = await readLoudnessEnvelope(await writeWav({ sampleRate: 16000, channels: 1, samples: dc(16000, 0.3, 0.5) }))
    expect(short.db).toEqual([-6])
    const empty = await readLoudnessEnvelope(await writeWav({ sampleRate: 16000, channels: 1, samples: new Int16Array(0) }))
    expect(empty.db).toEqual([])
  })

  it('reports progress by bytes read, increasing up to exactly 1', async () => {
    const file = await writeWav({ sampleRate: 16000, channels: 1, samples: dc(16000, 150, 0.1) }) // ~4.8 MB, several reads
    const seen: number[] = []
    await readLoudnessEnvelope(file, { onProgress: v => seen.push(v) })
    expect(seen.length).toBeGreaterThan(2)
    expect(seen.filter(v => v > 0 && v < 1).length).toBeGreaterThan(1)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]!)
    expect(seen.at(-1)).toBe(1)
  })

  it('rejects with the abort reason mid-stream and stops reading', async () => {
    const file = await writeWav({ sampleRate: 16000, channels: 1, samples: dc(16000, 150, 0.1) })
    const controller = new AbortController()
    const reason = new Error('cancelled by test')
    const seen: number[] = []
    const result = readLoudnessEnvelope(file, {
      signal: controller.signal,
      onProgress: (v) => {
        seen.push(v)
        controller.abort(reason)
      },
    })
    await expect(result).rejects.toBe(reason)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeLessThan(1)
  })

  it('rejects with the abort reason when already aborted', async () => {
    const file = await writeWav({ sampleRate: 16000, channels: 1, samples: dc(16000, 1, 0.1) })
    const controller = new AbortController()
    const reason = new Error('shutdown')
    controller.abort(reason)
    const seen: number[] = []
    await expect(readLoudnessEnvelope(file, { signal: controller.signal, onProgress: v => seen.push(v) })).rejects.toBe(reason)
    expect(seen).toEqual([])
  })

  it('explains files that are not WAV or not 16-bit PCM', async () => {
    const samples = dc(16000, 1, 0.1)
    const cases: [Buffer, string][] = [
      [Buffer.from('this is not audio at all, just some text'), '音訊檔不是 WAV 格式'],
      [Buffer.alloc(0), '音訊檔不是 WAV 格式'],
      [Buffer.from('RIFF'), '音訊檔不是 WAV 格式'],
      [makeWav({ sampleRate: 16000, channels: 1, samples, fmt: pcmFmt(16000, 1, 24) }), '不支援的 WAV 格式（24 位元 PCM），只支援 16 位元 PCM'],
      [makeWav({ sampleRate: 16000, channels: 1, samples, fmt: pcmFmt(16000, 1, 32, 3) }), '不支援的 WAV 格式（格式代碼 0x0003），只支援 16 位元 PCM'],
      [makeWav({ sampleRate: 16000, channels: 1, samples, fmt: extensibleFmt(16000, 1, 3) }), '不支援的 WAV 格式（格式代碼 0x0003），只支援 16 位元 PCM'],
      [makeWav({ sampleRate: 16000, channels: 1, samples }).subarray(0, 36), 'WAV 檔裡沒有音訊資料'],
      [Buffer.from('RIFF\0\0\0\0WAVEfmt \xFF\xFF\xFF\x7F', 'latin1'), 'WAV 檔的格式資訊（fmt 區塊）不正確'],
    ]
    for (const [bytes, message] of cases) {
      await expect(readLoudnessEnvelope(await writeWav(bytes)), message).rejects.toThrow(message)
    }
    // 'data' before 'fmt '
    const noFmt = Buffer.from('RIFF\0\0\0\0WAVEdata\x04\0\0\0\0\0\0\0', 'latin1')
    await expect(readLoudnessEnvelope(await writeWav(noFmt))).rejects.toThrow('WAV 檔缺少格式資訊（fmt 區塊）')
  })

  it('rejects (instead of crashing the process) when onProgress throws', async () => {
    const file = await writeWav({ sampleRate: 16000, channels: 1, samples: dc(16000, 1, 0.1) })
    const boom = new Error('progress failed')
    await expect(readLoudnessEnvelope(file, { onProgress: () => { throw boom } })).rejects.toBe(boom)
  })

  it('rejects when the file does not exist', async () => {
    const dir = await makeTmpDir('gg-signals-')
    await expect(readLoudnessEnvelope(path.join(dir, 'missing.wav'))).rejects.toThrow()
  })
})

describe('WavLoudnessParser', () => {
  it('gives the same envelope however the bytes are split', () => {
    const t = (sec: number) => 0.6 * Math.sin(2 * Math.PI * 220 * sec) * (sec % 1)
    const left = generate(8000, 2.7, t)
    const right = generate(8000, 2.7, sec => t(sec) / 3)
    const wav = makeWav({ sampleRate: 8000, channels: 2, samples: interleave(left, right), beforeData: [ffmpegListChunk()] })

    const whole = new WavLoudnessParser()
    whole.push(wav)
    const expected = whole.finish()
    expect(expected.db).toHaveLength(3)

    const byteByByte = new WavLoudnessParser()
    for (let i = 0; i < wav.length; i++) byteByByte.push(wav.subarray(i, i + 1))
    expect(byteByByte.finish()).toEqual(expected)

    let seed = 7
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647
    const pieces = new WavLoudnessParser()
    for (let i = 0; i < wav.length;) {
      const n = 1 + Math.floor(random() * 97)
      pieces.push(wav.subarray(i, i + n))
      i += n
    }
    expect(pieces.finish()).toEqual(expected)
  })
})

describe('loudness from a real extractAudio WAV', () => {
  it('peaks at a loud burst in a quiet tone and is about 0 elsewhere', async () => {
    const dir = await makeTmpDir('gg-signals-')
    const source = path.join(dir, 'source.m4a')
    // 60 s stereo 48 kHz AAC: a quiet 440 Hz tone with a loud burst during second 30.
    const expr = 'if(between(t,30,31),0.5,0.01)*sin(2*PI*440*t)'
    const made = spawnSync(tools.ffmpegPath, [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', `aevalsrc='${expr}|${expr}':s=48000:d=60`, '-c:a', 'aac', '-b:a', '128k', source,
    ], { encoding: 'utf8' })
    expect(made.status, made.stderr).toBe(0)

    const wav = path.join(dir, 'audio.wav')
    await extractAudio(tools, { filePath: source, audioTrack: 0, durationSec: 60 }, wav)
    const header = (await fs.readFile(wav)).subarray(0, 128)
    expect(header.indexOf('LIST')).toBeGreaterThan(0) // so 'data' is not at byte 36

    const envelope = await readLoudnessEnvelope(wav)
    expect(envelope.db.length).toBeGreaterThanOrEqual(60)
    expect(envelope.db.length).toBeLessThanOrEqual(61)
    expect(envelope.db[10]).toBeCloseTo(-43, 0) // 0.01 sine: 20·log10(0.01/√2)

    const track = loudnessTrack(envelope, 60)
    expect(track).toHaveLength(60)
    const peak = track.indexOf(Math.max(...track))
    expect(peak).toBeGreaterThanOrEqual(29)
    expect(peak).toBeLessThanOrEqual(31)
    expect(track[30]).toBe(1)
    for (let i = 0; i < 60; i++) {
      if (Math.abs(i - 30) >= 2) expect(track[i], `second ${i}`).toBeLessThan(0.05)
    }
  })
})

function naiveRollingMedian(values: number[], count: number, radius: number): number[] {
  return Array.from({ length: count }, (_, i) => {
    const w = values.slice(Math.max(0, i - radius), Math.min(count, i + radius + 1)).sort((a, b) => a - b)
    const mid = w.length >> 1
    return w.length % 2 ? w[mid]! : (w[mid - 1]! + w[mid]!) / 2
  })
}

describe('rollingMedian', () => {
  it('matches a naive median, with ties, even windows at the ends and short inputs', () => {
    let seed = 11
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647
    const values = Array.from({ length: 700 }, () => Math.round(random() * 40) / 2 - 60)
    for (const [count, radius] of [[700, 150], [700, 3], [200, 150], [5, 150], [1, 150], [0, 150], [700, 0]] as const) {
      expect(Array.from(rollingMedian(values, count, radius)), `${count}/${radius}`).toEqual(naiveRollingMedian(values, count, radius))
    }
  })
})

describe('loudnessTrack', () => {
  const flat = (seconds: number, db: number) => Array.from({ length: seconds }, () => db)

  it('scores dB above the ±150 s median: 3 dB starts, 12 dB is 1', () => {
    const db = flat(600, -40)
    db[100] = -30 // +10 dB
    db[200] = -28 // +12 dB
    db[300] = -37 // +3 dB
    db[400] = -20 // +20 dB
    db[500] = -35.5 // +4.5 dB
    const track = loudnessTrack({ db }, 600)
    expect(track[100]).toBeCloseTo(7 / 9, 5)
    expect(track[200]).toBe(1)
    expect(track[300]).toBe(0)
    expect(track[400]).toBe(1)
    expect(track[500]).toBeCloseTo(1.5 / 9, 5)
    expect(track.reduce((n, v) => n + (v > 0 ? 1 : 0), 0)).toBe(4)
  })

  it('gives 0 below -50 dBFS even far above the baseline', () => {
    const db = flat(300, -100)
    db[50] = -55
    db[60] = -45
    const track = loudnessTrack({ db }, 300)
    expect(track[50]).toBe(0)
    expect(track[60]).toBe(1)
  })

  it('does not score a lasting change of level once the median follows it', () => {
    const db = [...flat(1000, -40), ...flat(1000, -20)]
    const track = loudnessTrack({ db }, 2000)
    expect(track.every(v => v === 0)).toBe(true)
  })

  it('pads with 0 or truncates to ceil(durationSec)', () => {
    const db = flat(400, -40)
    db[2] = -20
    expect(Array.from(loudnessTrack({ db: db.slice(0, 3) }, 5))).toEqual([0, 0, 1, 0, 0])
    const truncated = loudnessTrack({ db }, 2.5)
    expect(Array.from(truncated)).toEqual([0, 0, 1])
    expect(loudnessTrack({ db }, 0)).toHaveLength(0)
    expect(loudnessTrack({ db: [] }, 3)).toEqual(new Float32Array(3))
  })

  it('handles a 4-hour envelope in well under 300 ms', () => {
    let seed = 3
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647
    const db = Array.from({ length: 4 * 3600 }, () => Math.round((-45 + random() * 30) * 10) / 10)
    const started = performance.now()
    const track = loudnessTrack({ db }, 4 * 3600)
    const elapsed = performance.now() - started
    expect(track).toHaveLength(14400)
    expect(elapsed).toBeLessThan(300)
  })
})
