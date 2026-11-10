import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { HeatmapMarker } from '../signals/types'
import { heatmapTrack, scoreHeatmapBuckets } from './heatmap'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-fixtures', 'heatmap')

interface Expected {
  bucketScores: number[]
  nonzeroBuckets: number[]
  fullBuckets: number[]
  perSecondLength: number
  peakSecond: number
  fractionSecondsNonzero: number
}

const expected = JSON.parse(readFileSync(path.join(FIXTURES, 'expected_track.json'), 'utf8')) as Record<string, Expected>

/** A fixture in yt-dlp's info_dict shape → the app's markers. */
function loadFixture(id: string): { markers: HeatmapMarker[], duration: number } {
  const data = JSON.parse(readFileSync(path.join(FIXTURES, `heatmap_${id}.json`), 'utf8')) as {
    duration: number
    heatmap: { start_time: number, end_time: number, value: number }[]
  }
  return {
    duration: data.duration,
    markers: data.heatmap.map(p => ({ start: p.start_time, end: p.end_time, value: p.value })),
  }
}

/** n equal buckets over `duration` with the given values. */
function buckets(values: number[], duration = values.length * 10): HeatmapMarker[] {
  const width = duration / values.length
  return values.map((value, i) => ({ start: i * width, end: (i + 1) * width, value }))
}

function indexOfMax(values: Float32Array): number {
  let best = 0
  for (let i = 1; i < values.length; i++) if (values[i]! > values[best]!) best = i
  return best
}

// expected_track.json was produced by the research prototype of the formula (reference_heatmap_track.py).
describe('heatmapTrack on real heatmaps', () => {
  it('has an expectation for every fixture', () => {
    expect(Object.keys(expected).sort()).toEqual([
      'FTjEZFjDIV0', 'J33JnrVJiIQ', 'MX_KPYujulk', 'N7Ic_eq9VUQ', 'Nc2V_HSuOsM', 'dQw4w9WgXcQ', 'fiXcPmFza8U', 'ipvVA46tZzM',
    ])
  })

  for (const [id, want] of Object.entries(expected)) {
    it(`matches the reference for ${id}`, () => {
      const { markers, duration } = loadFixture(id)
      const scored = scoreHeatmapBuckets(markers)
      if (scored.kind !== 'buckets') throw new Error(`expected buckets, got ${scored.kind}`)
      const scores = scored.buckets.map(b => b.score)
      expect(scores.map(s => Math.round(s * 1e4) / 1e4)).toEqual(want.bucketScores)
      expect(scores.flatMap((s, i) => (s > 0 ? [i] : []))).toEqual(want.nonzeroBuckets)
      expect(scores.flatMap((s, i) => (s >= 1 ? [i] : []))).toEqual(want.fullBuckets)

      const track = heatmapTrack(markers, duration)
      if (track.kind !== 'track') throw new Error(`expected a track, got ${track.kind}`)
      expect(track.values.length).toBe(want.perSecondLength)
      expect(track.covered.length).toBe(want.perSecondLength)
      expect(track.covered.every(c => c === 1)).toBe(true)
      expect(indexOfMax(track.values)).toBe(want.peakSecond)
      const nonzero = track.values.filter(v => v > 0).length
      expect(Math.round(nonzero / track.values.length * 1e4) / 1e4).toBe(want.fractionSecondsNonzero)
      expect(track.values.every(v => v >= 0 && v <= 1)).toBe(true)
    })
  }

  it('caps the opening replays of dQw4w9WgXcQ (bucket 0 is the raw maximum)', () => {
    const { markers } = loadFixture('dQw4w9WgXcQ')
    expect(markers[0]!.value).toBe(1)
    const scored = scoreHeatmapBuckets(markers)
    if (scored.kind !== 'buckets') throw new Error(scored.kind)
    expect(scored.buckets[0]!.score).toBe(0)
  })

  it('works on unsorted markers', () => {
    const { markers, duration } = loadFixture('J33JnrVJiIQ')
    const shuffled = [...markers].reverse()
    expect(heatmapTrack(shuffled, duration)).toEqual(heatmapTrack(markers, duration))
  })
})

describe('scoreHeatmapBuckets', () => {
  it('is invalid with fewer than 10 usable markers', () => {
    expect(scoreHeatmapBuckets([])).toEqual({ kind: 'invalid' })
    expect(scoreHeatmapBuckets(buckets([0, 0, 0, 0, 1, 0, 0, 0, 0]))).toEqual({ kind: 'invalid' })
    // 10 markers, but two have end ≤ start and one a NaN value.
    const markers = buckets([0, 0, 0, 0, 1, 0, 0, 0, 0, 0])
    markers[1] = { start: 10, end: 10, value: 0 }
    markers[2] = { start: 30, end: 20, value: 0 }
    markers[3] = { start: 30, end: 40, value: Number.NaN }
    expect(scoreHeatmapBuckets(markers)).toEqual({ kind: 'invalid' })
    expect(scoreHeatmapBuckets([...markers, ...buckets([0, 0, 0], 30).map(m => ({ ...m, start: m.start + 100, end: m.end + 100 }))]).kind).toBe('buckets')
  })

  it('is flat when the maximum is less than 0.1 above the median', () => {
    expect(scoreHeatmapBuckets(buckets([0.5, 0.5, 0.5, 0.5, 0.59, 0.5, 0.5, 0.5, 0.5, 0.5]))).toEqual({ kind: 'flat' })
    expect(scoreHeatmapBuckets(buckets([0.5, 0.5, 0.5, 0.5, 0.61, 0.5, 0.5, 0.5, 0.5, 0.5])).kind).toBe('buckets')
  })

  it('is flat when the only peak is in the first 30 s (capped at the median)', () => {
    expect(scoreHeatmapBuckets(buckets([1, 0.9, 0.8, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2]))).toEqual({ kind: 'flat' })
  })

  it('scores (v − m) ÷ (top − m) from 0.3 (0) to 0.7 (1) and clamps values to 0–1', () => {
    // 10 s buckets: buckets 0–2 start before 30 s. Median of the clamped values is 0.2.
    const scored = scoreHeatmapBuckets(buckets([0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.32, 0.44, 1.7, -3]))
    if (scored.kind !== 'buckets') throw new Error(scored.kind)
    // After capping nothing changes (opening values are not above the median); m = 0.2, top = 1.
    const scores = scored.buckets.map(b => b.score)
    expect(scores[6]).toBeCloseTo(0, 10) // (0.32 − 0.2) / 0.8 = 0.15 < 0.3
    expect(scores[7]).toBeCloseTo(0, 10) // 0.24 / 0.8 = 0.3: scoring starts here
    expect(scores[8]).toBe(1)
    expect(scores[9]).toBe(0)
    const mid = scoreHeatmapBuckets(buckets([0, 0, 0, 0, 0, 0, 0.5, 0, 0, 1]))
    if (mid.kind !== 'buckets') throw new Error(mid.kind)
    expect(mid.buckets[6]!.score).toBeCloseTo(0.5, 10) // (0.5 − 0.3) / 0.4
  })

  it('caps bucket 0 and every bucket starting before 30 s at the median of all values', () => {
    // 20 s buckets: buckets 0 (0 s) and 1 (20 s) start before 30 s, bucket 2 starts at 40 s.
    const scored = scoreHeatmapBuckets(buckets([1, 1, 1, 0, 0, 0, 0, 0, 0, 0], 200))
    if (scored.kind !== 'buckets') throw new Error(scored.kind)
    expect(scored.buckets.map(b => b.score)).toEqual([0, 0, 1, 0, 0, 0, 0, 0, 0, 0])
  })
})

describe('heatmapTrack per second', () => {
  const values = [0, 0, 0, 0, 0, 0, 0, 1, 0, 0]

  it('interpolates linearly between bucket centres at k + 0.5 and holds the ends', () => {
    // 10 s buckets; bucket 7 (70–80 s, centre 75) scores 1, the rest 0.
    const track = heatmapTrack(buckets(values), 100)
    if (track.kind !== 'track') throw new Error(track.kind)
    expect(track.values.length).toBe(100)
    expect(track.values[75]).toBeCloseTo(0.95, 6) // 75.5 between centres 75 (1) and 85 (0)
    expect(track.values[74]).toBeCloseTo(0.95, 6) // 74.5 between 65 (0) and 75 (1)
    expect(track.values[70]).toBeCloseTo(0.55, 6)
    expect(track.values[65]).toBeCloseTo(0.05, 6)
    expect(track.values[64]).toBe(0)
    expect(track.values[85]).toBe(0)
  })

  it('holds the first and last bucket scores before the first and after the last centre', () => {
    const track = heatmapTrack(buckets([1, 0, 0, 0, 0, 0, 0, 0, 0.6, 1], 100), 100)
    if (track.kind !== 'track') throw new Error(track.kind)
    // Bucket 0 is capped (0); bucket 9 (centre 95) scores 1 and holds to the end.
    for (let k = 0; k < 5; k++) expect(track.values[k]).toBe(0)
    for (let k = 95; k < 100; k++) expect(track.values[k]).toBe(1)
  })

  it('covers seconds up to the last bucket end plus one bucket length', () => {
    // Buckets end at 100 s, 10 s long: positions up to 110 s are covered; a 130 s local file has 20 s more.
    const track = heatmapTrack(buckets(values), 130)
    if (track.kind !== 'track') throw new Error(track.kind)
    expect(track.values.length).toBe(130)
    expect(Array.from(track.covered.subarray(0, 110)).every(c => c === 1)).toBe(true)
    expect(Array.from(track.covered.subarray(110)).every(c => c === 0)).toBe(true)
    expect(Array.from(track.values.subarray(110)).every(v => v === 0)).toBe(true)
  })

  it('clamps to ceil(durationSec) when the local file is shorter than the heatmap', () => {
    const track = heatmapTrack(buckets(values), 72.3)
    if (track.kind !== 'track') throw new Error(track.kind)
    expect(track.values.length).toBe(73)
    expect(track.covered.every(c => c === 1)).toBe(true)
    expect(track.values[72]).toBeCloseTo(0.75, 6)
  })

  it('passes invalid and flat through', () => {
    expect(heatmapTrack(buckets([0, 1, 0]), 30)).toEqual({ kind: 'invalid' })
    expect(heatmapTrack(buckets(Array.from({ length: 10 }, () => 0.4)), 100)).toEqual({ kind: 'flat' })
  })

  it('gives empty arrays for a zero or unknown duration', () => {
    for (const duration of [0, Number.NaN]) {
      const track = heatmapTrack(buckets(values), duration)
      if (track.kind !== 'track') throw new Error(track.kind)
      expect(track.values.length).toBe(0)
      expect(track.covered.length).toBe(0)
    }
  })
})
