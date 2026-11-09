import { describe, expect, it } from 'vitest'
import type { SignalKind } from '../../../shared/types/domain'
import { momentsTrack } from '../signals/tracks'
import type { NamedTrack, TranscriptMoment } from '../signals/types'
import { buildCandidates, candidateCap, rangeScore, reasonFor } from './candidates'
import { DEFAULT_CANDIDATE_OPTIONS, LOUDNESS_REASON } from './types'
import type { CandidateDraft, CandidateInput, TimeRange } from './types'

/** Per-second values: 0 everywhere except the given [from, to] (inclusive) runs. */
function values(durationSec: number, ...runs: Array<[from: number, to: number, value: number]>): Float32Array {
  const out = new Float32Array(Math.ceil(durationSec))
  for (const [from, to, value] of runs) out.fill(value, from, to + 1)
  return out
}

const track = (kind: SignalKind, v: Float32Array): NamedTrack => ({ kind, values: v })

/** Back-to-back segments of `every` seconds covering [0, durationSec]. */
function segmentsEvery(every: number, durationSec: number): TimeRange[] {
  const out: TimeRange[] = []
  for (let start = 0; start < durationSec; start += every) out.push({ start, end: Math.min(durationSec, start + every) })
  return out
}

function input(partial: Partial<CandidateInput> & Pick<CandidateInput, 'durationSec'>): CandidateInput {
  return { segments: [], tracks: [], moments: [], occupied: [], ...partial }
}

const moment = (start: number, end: number, score: number, reason: string): TranscriptMoment => ({ start, end, score, reason })
const ranges = (candidates: CandidateDraft[]) => candidates.map(({ start, end }) => [start, end])
const overlap = (a: TimeRange, b: TimeRange) => a.start < b.end && b.start < a.end

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A 20 s burst of loudness at seconds 40–59 of a 2-minute video. */
const burst = (durationSec = 120) => track('loudness', values(durationSec, [40, 59, 1]))

describe('buildCandidates: one peak', () => {
  it('finds one candidate around the peak, snapped to sentences with 1 s padding', () => {
    // Smoothed peak 42–57; expansion keeps 40–59; 40 sits in [35, 42) and 60 ends [56, 63).
    const segments = [0, 7, 14, 21, 28, 35, 42, 49, 56, 63, 70].map(start => ({ start, end: start + 7 }))
    const result = buildCandidates(input({ durationSec: 120, tracks: [burst()], segments }))
    expect(result).toEqual([{ start: 34, end: 64, score: 0.9, reason: LOUDNESS_REASON }])
  })

  it('pads the expanded window when there are no segments', () => {
    const result = buildCandidates(input({ durationSec: 120, tracks: [burst()] }))
    expect(result).toEqual([{ start: 39, end: 61, score: 0.967, reason: LOUDNESS_REASON }])
  })

  it('pads in silence when a window edge falls between segments', () => {
    const segments = [{ start: 30, end: 38 }, { start: 62, end: 70 }]
    expect(ranges(buildCandidates(input({ durationSec: 120, tracks: [burst()], segments })))).toEqual([[39, 61]])
  })

  it('fills a short peak up to the 15 s minimum toward the higher side', () => {
    // One loud second at 50 with a softer tail after it (below 60 % of the peak, so no expansion).
    const loud = track('loudness', values(120, [50, 50, 1], [51, 80, 0.3]))
    const [candidate] = buildCandidates(input({ durationSec: 120, tracks: [loud] }), { smoothSec: 1, padSec: 0 })
    expect(candidate).toMatchObject({ start: 50, end: 65 })
  })

  it('caps the expansion at 60 s', () => {
    const loud = track('loudness', values(600, [100, 299, 1]))
    const [candidate] = buildCandidates(input({ durationSec: 600, tracks: [loud] }))
    expect(candidate!.end - candidate!.start).toBeLessThanOrEqual(60)
    expect(candidate!.end - candidate!.start).toBeGreaterThanOrEqual(58)
  })

  it('scores 0.7 × peak + 0.3 × mean over the range', () => {
    const loud = track('loudness', values(100, [20, 29, 0.5], [30, 34, 1]))
    const [candidate] = buildCandidates(input({ durationSec: 100, tracks: [loud] }), { smoothSec: 1, padSec: 0, expandRatio: 0.5 })
    // Window 20–34: peak 1, mean (10 × 0.5 + 5 × 1) / 15.
    expect(candidate).toMatchObject({ start: 20, end: 35, score: Math.round((0.7 + 0.3 * (10 / 15)) * 1000) / 1000 })
  })
})

describe('buildCandidates: nothing to find', () => {
  it('returns nothing without tracks', () => {
    expect(buildCandidates(input({ durationSec: 120, segments: segmentsEvery(5, 120) }))).toEqual([])
  })

  it('returns nothing when every score is 0', () => {
    expect(buildCandidates(input({ durationSec: 120, tracks: [track('loudness', values(120))] }))).toEqual([])
  })

  it('stops below the minimum peak (0.2)', () => {
    const weak = track('loudness', values(120, [40, 59, 0.19]))
    expect(buildCandidates(input({ durationSec: 120, tracks: [weak] }))).toEqual([])
  })

  it('returns nothing for an invalid duration', () => {
    expect(buildCandidates(input({ durationSec: 0, tracks: [burst()] }))).toEqual([])
    expect(buildCandidates(input({ durationSec: Number.NaN, tracks: [burst()] }))).toEqual([])
  })
})

describe('buildCandidates: cap', () => {
  it('is ceil(hours × 10)', () => {
    expect(candidateCap(900, 10)).toBe(3)
    expect(candidateCap(3600, 10)).toBe(10)
    expect(candidateCap(3601, 10)).toBe(11)
    expect(candidateCap(14400, 10)).toBe(40)
    expect(candidateCap(10.8, 10)).toBe(1)
    expect(candidateCap(100, 0)).toBe(0)
  })

  /** A 3 s bump every 60 s (more bumps than the cap allows), each with a different height. */
  function bumps(durationSec: number) {
    const v = new Float32Array(durationSec)
    const count = Math.floor(durationSec / 60)
    const heights = Array.from({ length: count }, (_, k) => ({ centre: 30 + 60 * k, height: 0.4 + (0.6 * ((k * 7) % count)) / count }))
    for (const { centre, height } of heights) v.fill(height, centre - 1, centre + 2)
    return { tracks: [track('loudness', v)], heights }
  }

  it.each([
    ['15 minutes', 900, 3],
    ['1 hour', 3600, 10],
    ['4 hours', 14400, 40],
  ])('keeps the highest bumps of %s (%i s) up to %i candidates', (_, durationSec, cap) => {
    const { tracks, heights } = bumps(durationSec)
    const result = buildCandidates(input({ durationSec, tracks }))
    expect(result).toHaveLength(cap)
    const best = [...heights].sort((a, b) => b.height - a.height).slice(0, cap).map(h => h.centre).sort((a, b) => a - b)
    expect(result.map(c => best.find(centre => c.start <= centre && centre < c.end))).toEqual(best)
  })
})

describe('buildCandidates: short videos (the e2e fixtures)', () => {
  it('uses the whole 10.8 s video', () => {
    const loud = track('loudness', values(10.8, [4, 6, 1]))
    expect(buildCandidates(input({ durationSec: 10.8, tracks: [loud] }))).toEqual([
      { start: 0, end: 10.8, score: expect.any(Number), reason: LOUDNESS_REASON },
    ])
  })

  it('finds a candidate in a 10.8 s video from the transcript signal alone', () => {
    const moments = [moment(2.1, 6.4, 7 / 9, '大家一起笑出來')]
    const tracks = [track('transcript', momentsTrack(moments, 10.8))]
    const segments = [{ start: 0.5, end: 2.1 }, { start: 2.1, end: 6.4 }, { start: 6.4, end: 9.9 }]
    expect(buildCandidates(input({ durationSec: 10.8, tracks, moments, segments }))).toEqual([
      { start: 0, end: 10.8, score: expect.any(Number), reason: '大家一起笑出來' },
    ])
  })

  it('gives a 17.8 s video one candidate of at least 15 s', () => {
    const loud = track('loudness', values(17.8, [12, 14, 1]))
    const result = buildCandidates(input({ durationSec: 17.8, tracks: [loud], segments: segmentsEvery(3, 17.8) }))
    expect(result).toHaveLength(1)
    const [candidate] = result
    expect(candidate!.start).toBeGreaterThanOrEqual(0)
    expect(candidate!.end).toBeLessThanOrEqual(17.8)
    expect(candidate!.end - candidate!.start).toBeGreaterThanOrEqual(15)
    expect(candidate!.start).toBeLessThanOrEqual(12)
    expect(candidate!.end).toBeGreaterThanOrEqual(15)
  })

  it('keeps a video shorter than one second', () => {
    const loud = track('loudness', values(0.6, [0, 0, 1]))
    expect(ranges(buildCandidates(input({ durationSec: 0.6, tracks: [loud] })))).toEqual([[0, 0.6]])
  })
})

describe('buildCandidates: occupied ranges', () => {
  it('starts after an occupied range that covers part of the peak', () => {
    const occupied = [{ start: 95, end: 112 }]
    const loud = track('loudness', values(600, [100, 119, 1]))
    const [candidate, ...others] = buildCandidates(input({ durationSec: 600, tracks: [loud], occupied }))
    expect(others).toEqual([])
    expect(candidate!.start).toBe(112)
    expect(candidate!.end - candidate!.start).toBeGreaterThanOrEqual(15)
  })

  it('does not snap or pad into an occupied range', () => {
    const occupied = [{ start: 30.4, end: 38.6 }, { start: 61.3, end: 70 }]
    const segments = segmentsEvery(7, 120)
    const [candidate] = buildCandidates(input({ durationSec: 120, tracks: [burst()], segments, occupied }))
    expect(candidate).toMatchObject({ start: 38.6, end: 61.3 })
  })

  it('rounds inward at an occupied edge that is not on the 0.1 s grid', () => {
    const occupied = [{ start: 30, end: 38.64 }, { start: 61.36, end: 70 }]
    const segments = segmentsEvery(7, 120)
    const [candidate] = buildCandidates(input({ durationSec: 120, tracks: [burst()], segments, occupied }))
    expect(candidate).toMatchObject({ start: 38.7, end: 61.3 })
  })

  it('finds nothing when the peak is inside an occupied range', () => {
    const occupied = [{ start: 90, end: 130 }]
    expect(buildCandidates(input({ durationSec: 600, tracks: [track('loudness', values(600, [100, 119, 1]))], occupied }))).toEqual([])
  })

  it('finds nothing when the free gap around the peak is shorter than 15 s', () => {
    const occupied = [{ start: 0, end: 100 }, { start: 110, end: 600 }]
    expect(buildCandidates(input({ durationSec: 600, tracks: [track('loudness', values(600, [100, 109, 1]))], occupied }))).toEqual([])
  })

  it('finds nothing when occupied ranges cover the whole video', () => {
    const occupied = [{ start: 0, end: 60 }, { start: 60, end: 120 }]
    expect(buildCandidates(input({ durationSec: 120, tracks: [burst()], occupied }))).toEqual([])
  })

  it('accepts unordered, reversed and out-of-range occupied ranges', () => {
    const occupied = [{ start: 70, end: 61.3 }, { start: -5, end: 38.6 }, { start: Number.NaN, end: 50 }]
    const segments = segmentsEvery(7, 120)
    const [candidate] = buildCandidates(input({ durationSec: 120, tracks: [burst()], segments, occupied }))
    expect(candidate).toMatchObject({ start: 38.6, end: 61.3 })
  })
})

describe('buildCandidates: long segments', () => {
  it('uses the padded window when one segment covers more than 60 s around it', () => {
    const segments = [{ start: 0, end: 200 }]
    expect(ranges(buildCandidates(input({ durationSec: 300, tracks: [burst(300)], segments })))).toEqual([[39, 61]])
  })

  it('cuts at the sentence boundary on the side that reaches further', () => {
    // Outward snap is [29, 121]: the end reaches 60 s past the window, so the end moves to 58.
    const segments = [{ start: 0, end: 30 }, { start: 30, end: 41 }, { start: 41, end: 50 }, { start: 50, end: 58 }, { start: 58, end: 120 }]
    expect(ranges(buildCandidates(input({ durationSec: 300, tracks: [burst(300)], segments })))).toEqual([[29, 59]])
  })

  it('cuts both sides when one cut is not enough', () => {
    const loud = track('loudness', values(400, [100, 119, 1]))
    const segments = [{ start: 30, end: 101.5 }, { start: 101.5, end: 110 }, { start: 110, end: 118.5 }, { start: 118.5, end: 200 }]
    expect(ranges(buildCandidates(input({ durationSec: 400, tracks: [loud], segments })))).toEqual([[100.5, 119.5]])
  })

  it('never cuts away the peak: falls back to the padded window', () => {
    // The start's segment [0, 45) holds the peak (second 42), so it cannot be dropped.
    const segments = [{ start: 0, end: 45 }, { start: 45, end: 50 }, { start: 50, end: 55 }, { start: 55, end: 62 }, { start: 62, end: 300 }]
    expect(ranges(buildCandidates(input({ durationSec: 300, tracks: [burst(300)], segments })))).toEqual([[39, 61]])
  })
})

describe('buildCandidates: merging', () => {
  const options = { smoothSec: 1, minSec: 5 }
  const twoPeaks = track('loudness', values(1000, [20, 24, 1], [33, 37, 0.9]))

  it('merges a candidate whose sentences reach into an earlier one', () => {
    // First [19, 27]; the second snaps to [25, 41] through the segment [26, 40].
    const segments = [{ start: 15, end: 20 }, { start: 20, end: 26 }, { start: 26, end: 40 }, { start: 40, end: 50 }]
    const result = buildCandidates(input({ durationSec: 1000, tracks: [twoPeaks], segments }), options)
    expect(result).toEqual([{ start: 19, end: 41, score: 0.83, reason: LOUDNESS_REASON }])
  })

  it('keeps the earlier candidate when the merge would pass 60 s and it scores higher', () => {
    const segments = [{ start: 15, end: 20 }, { start: 20, end: 26 }, { start: 26, end: 80 }]
    expect(ranges(buildCandidates(input({ durationSec: 1000, tracks: [twoPeaks], segments }), options))).toEqual([[19, 27]])
  })

  it('keeps the later candidate when the merge would pass 60 s and it scores higher', () => {
    // First [19, 76] has a low mean (0.726); the second [74, 102] scores 0.818.
    const loud = track('loudness', values(1000, [20, 24, 1], [85, 99, 0.95]))
    const segments = [{ start: 20, end: 75 }, { start: 75, end: 101 }]
    const result = buildCandidates(input({ durationSec: 1000, tracks: [loud], segments }), options)
    expect(result).toEqual([{ start: 74, end: 102, score: 0.818, reason: LOUDNESS_REASON }])
  })

  it('keeps 5 s clear around a candidate for new peaks', () => {
    // The second burst is 4 s after the first candidate's end, inside its gap: no second candidate.
    const loud = track('loudness', values(1000, [20, 24, 1], [29, 29, 0.9]))
    expect(ranges(buildCandidates(input({ durationSec: 1000, tracks: [loud] }), { ...options, padSec: 0 }))).toEqual([[20, 25]])
  })
})

describe('buildCandidates: reasons', () => {
  it('uses the reason of the highest-scoring overlapping moment', () => {
    const moments = [
      moment(10, 39, 1, '在前面，只碰到邊'),
      moment(45, 50, 0.6, '鬥嘴'),
      moment(52, 58, 0.9, '  逆轉勝  '),
      moment(200, 210, 1, '很遠的片段'),
    ]
    const [candidate] = buildCandidates(input({ durationSec: 1000, tracks: [burst(1000)], moments }))
    expect(candidate).toMatchObject({ start: 39, end: 61, reason: '逆轉勝' })
  })

  it('takes the first of equally scored moments and skips empty reasons', () => {
    expect(reasonFor({ start: 0, end: 30 }, [moment(1, 2, 0.9, ' '), moment(3, 4, 0.8, '第一個'), moment(5, 6, 0.8, '第二個')]))
      .toBe('第一個')
  })

  it('falls back to the loudness reason without an overlapping moment', () => {
    expect(reasonFor({ start: 0, end: 30 }, [])).toBe(LOUDNESS_REASON)
    expect(reasonFor({ start: 0, end: 30 }, [moment(30, 40, 1, '剛好接在後面')])).toBe(LOUDNESS_REASON)
  })
})

describe('buildCandidates: signals', () => {
  it('does not lower loudness-only scores when the transcript signal is missing', () => {
    const loudOnly = buildCandidates(input({ durationSec: 120, tracks: [burst()] }))
    const withEmptyTranscript = buildCandidates(input({ durationSec: 120, tracks: [burst(), track('transcript', values(120))] }))
    expect(loudOnly[0]!.score).toBeGreaterThan(0.9)
    expect(withEmptyTranscript[0]!.score).toBeLessThan(0.4)
  })

  it('combines loudness and transcript with weights 1 and 2', () => {
    const moments = [moment(70, 85, 1, '尖叫')]
    const tracks = [track('loudness', values(300, [40, 59, 1])), track('transcript', momentsTrack(moments, 300))]
    const result = buildCandidates(input({ durationSec: 3600, tracks, moments }))
    // The transcript moment (weight 2/3) outranks the loudness burst (1/3); both become candidates.
    expect(result.map(c => c.reason)).toEqual([LOUDNESS_REASON, '尖叫'])
    expect(result[1]!.score).toBeGreaterThan(result[0]!.score)
  })

  it('is deterministic and independent of track order', () => {
    const moments = [moment(70, 85, 0.8, '尖叫')]
    const loud = track('loudness', values(300, [40, 59, 1]))
    const transcript = track('transcript', momentsTrack(moments, 300))
    const a = buildCandidates(input({ durationSec: 300, tracks: [loud, transcript], moments }), { perHour: 100 })
    const b = buildCandidates(input({ durationSec: 300, tracks: [transcript, loud], moments }), { perHour: 100 })
    expect(a).toEqual(b)
    expect(buildCandidates(input({ durationSec: 300, tracks: [loud, transcript], moments }), { perHour: 100 })).toEqual(a)
  })
})

describe('buildCandidates: invariants', () => {
  function randomInput(seed: number, durationSec: number): CandidateInput {
    const next = random(seed)
    const loud = new Float32Array(Math.ceil(durationSec))
    for (let i = 0; i < loud.length; i++) loud[i] = next() * 0.15
    for (let i = 0; i < loud.length; i++) {
      if (next() < 0.01) loud.fill(0.7 + next() * 0.3, i, i + 4 + Math.floor(next() * 7))
    }
    const moments: TranscriptMoment[] = []
    for (let k = 0; k < durationSec / 300; k++) {
      const start = next() * durationSec
      moments.push(moment(start, start + 5 + next() * 40, next(), `理由 ${k}`))
    }
    const segments: TimeRange[] = []
    for (let t = next() * 3; t < durationSec;) {
      const end = Math.min(durationSec, t + 0.5 + next() * 7)
      segments.push({ start: t, end })
      t = end + (next() < 0.3 ? next() * 4 : 0)
    }
    const occupied: TimeRange[] = []
    for (let k = 0; k < 5; k++) {
      const start = Math.round(next() * durationSec * 10) / 10
      occupied.push({ start, end: start + Math.round(next() * 900) / 10 })
    }
    const tracks = [track('loudness', loud), track('transcript', momentsTrack(moments, durationSec))]
    return { durationSec, segments, tracks, moments, occupied }
  }

  it.each([1, 2, 3, 4, 5, 6])('keeps every rule on random input (seed %i)', (seed) => {
    const durationSec = 1800 + seed * 437.3
    const data = randomInput(seed, durationSec)
    const result = buildCandidates(data)
    expect(result.length).toBeGreaterThan(0)
    expect(result.length).toBeLessThanOrEqual(candidateCap(durationSec, DEFAULT_CANDIDATE_OPTIONS.perHour))
    result.forEach((c, i) => {
      expect(c.start).toBeGreaterThanOrEqual(0)
      expect(c.end).toBeLessThanOrEqual(durationSec)
      expect(c.end - c.start).toBeGreaterThanOrEqual(15 - 1e-9)
      expect(c.end - c.start).toBeLessThanOrEqual(60 + 1e-9)
      expect(Math.abs(c.start * 10 - Math.round(c.start * 10))).toBeLessThan(1e-6)
      expect(Math.abs(c.end * 10 - Math.round(c.end * 10))).toBeLessThan(1e-6)
      expect(c.score).toBeGreaterThan(0)
      expect(c.score).toBeLessThanOrEqual(1)
      expect(c.score).toBe(Math.round(c.score * 1000) / 1000)
      expect(c.reason.length).toBeGreaterThan(0)
      if (i > 0) expect(c.start).toBeGreaterThanOrEqual(result[i - 1]!.end)
      for (const o of data.occupied) expect(overlap(c, o)).toBe(false)
    })
  })

  it('builds candidates for a 4-hour video in under 500 ms', () => {
    const durationSec = 4 * 3600
    const data = randomInput(42, durationSec)
    buildCandidates(data) // warm up the JIT
    const started = performance.now()
    const result = buildCandidates(data)
    const elapsed = performance.now() - started
    expect(result.length).toBe(40)
    expect(elapsed).toBeLessThan(500)
  })
})

describe('rangeScore', () => {
  it('uses every second the range touches', () => {
    const scores = Float32Array.from([0, 0.5, 1, 0.5, 0])
    expect(rangeScore(scores, { start: 1, end: 4 })).toBe(Math.round((0.7 + 0.3 * (2 / 3)) * 1000) / 1000)
    expect(rangeScore(scores, { start: 1.5, end: 2.2 })).toBe(Math.round((0.7 + 0.3 * 0.75) * 1000) / 1000)
    expect(rangeScore(scores, { start: 9, end: 10 })).toBe(0)
  })
})
