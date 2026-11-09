import { describe, expect, it } from 'vitest'
import { combineTracks, momentsTrack, movingAverage, trackLength } from './tracks'
import type { NamedTrack, TranscriptMoment } from './types'

const moment = (start: number, end: number, score: number): TranscriptMoment => ({ start, end, score, reason: '大笑' })
const track = (kind: NamedTrack['kind'], values: number[]): NamedTrack => ({ kind, values: Float32Array.from(values) })
const rounded = (values: ArrayLike<number>) => Array.from(values, v => Math.round(v * 1000) / 1000)

describe('trackLength', () => {
  it('is ceil(duration), 0 for invalid durations', () => {
    expect(trackLength(10)).toBe(10)
    expect(trackLength(10.2)).toBe(11)
    expect(trackLength(0)).toBe(0)
    expect(trackLength(-3)).toBe(0)
    expect(trackLength(Number.NaN)).toBe(0)
    expect(trackLength(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('momentsTrack', () => {
  it('is all zeros without moments', () => {
    expect(Array.from(momentsTrack([], 4.5))).toEqual([0, 0, 0, 0, 0])
  })

  it('gives every second a moment touches its score', () => {
    expect(rounded(momentsTrack([moment(2.5, 5.2, 0.5)], 8))).toEqual([0, 0, 0.5, 0.5, 0.5, 0.5, 0, 0])
  })

  it('ends at whole seconds without spilling into the next one', () => {
    expect(rounded(momentsTrack([moment(1, 3, 1)], 5))).toEqual([0, 1, 1, 0, 0])
  })

  it('takes the max where moments overlap', () => {
    const values = momentsTrack([moment(0, 4, 0.25), moment(2, 6, 0.75), moment(3, 4, 0.5)], 7)
    expect(rounded(values)).toEqual([0.25, 0.25, 0.75, 0.75, 0.75, 0.75, 0])
  })

  it('clips moments to the video and ignores ones outside it', () => {
    expect(rounded(momentsTrack([moment(-3, 1.5, 0.5), moment(3.5, 99, 1), moment(50, 60, 1)], 5)))
      .toEqual([0.5, 0.5, 0, 1, 1])
  })

  it('swaps reversed moments and covers the second of a zero-length one', () => {
    expect(rounded(momentsTrack([moment(3, 1, 0.5), moment(4.5, 4.5, 1)], 6))).toEqual([0, 0.5, 0.5, 0, 1, 0])
  })

  it('clamps scores to 0–1 and skips non-finite numbers', () => {
    const values = momentsTrack([moment(0, 1, 3), moment(1, 2, -1), moment(2, 3, Number.NaN), moment(Number.NaN, 4, 1)], 4)
    expect(rounded(values)).toEqual([1, 0, 0, 0])
  })

  it('is empty for an invalid duration', () => {
    expect(momentsTrack([moment(0, 1, 1)], 0).length).toBe(0)
  })
})

describe('movingAverage', () => {
  it('averages a centred window', () => {
    expect(rounded(movingAverage([0, 0, 0, 0, 0.5, 0, 0, 0, 0], 5))).toEqual([0, 0, 0.1, 0.1, 0.1, 0.1, 0.1, 0, 0])
  })

  it('averages only the values that exist near the ends', () => {
    expect(rounded(movingAverage([1, 0, 0, 0, 0], 5))).toEqual([0.333, 0.25, 0.2, 0, 0])
    expect(rounded(movingAverage([0.4, 0.4, 0.4], 5))).toEqual([0.4, 0.4, 0.4])
  })

  it('puts the extra value of an even window after the centre', () => {
    // window 4 = [i - 1, i + 2]
    expect(rounded(movingAverage([0, 0, 0, 0.8, 0, 0], 4))).toEqual([0, 0.2, 0.2, 0.2, 0.267, 0])
  })

  it('leaves values alone for a window of 1 (or less, or NaN)', () => {
    const values = [0.1, 0.9, 0.3]
    expect(rounded(movingAverage(values, 1))).toEqual(values)
    expect(rounded(movingAverage(values, 0))).toEqual(values)
    expect(rounded(movingAverage(values, Number.NaN))).toEqual(values)
  })
})

describe('combineTracks', () => {
  it('is all zeros without tracks', () => {
    expect(Array.from(combineTracks([], 3.2))).toEqual([0, 0, 0, 0])
  })

  it('keeps a single track as it is (renormalised to its own weight)', () => {
    const loud = [0, 0.5, 1, 0.25]
    expect(rounded(combineTracks([track('loudness', loud)], 4, 1))).toEqual(loud)
    expect(rounded(combineTracks([track('transcript', loud)], 4, 1))).toEqual(loud)
  })

  it('weights loudness 1 and transcript 2', () => {
    const values = combineTracks([track('loudness', [1, 0, 0.5]), track('transcript', [0, 1, 0.5])], 3, 1)
    expect(rounded(values)).toEqual([0.333, 0.667, 0.5])
  })

  it('renormalises over the tracks given, so a missing signal does not lower the score', () => {
    const loudOnly = combineTracks([track('loudness', [1, 1])], 2, 1)
    const withEmptyTranscript = combineTracks([track('loudness', [1, 1]), track('transcript', [0, 0])], 2, 1)
    expect(rounded(loudOnly)).toEqual([1, 1])
    expect(rounded(withEmptyTranscript)).toEqual([0.333, 0.333])
  })

  it('knows the milestone 3 weights (chat 1.5, heatmap 2)', () => {
    const values = combineTracks([track('chat', [1]), track('heatmap', [0]), track('loudness', [0.5])], 1, 1)
    expect(rounded(values)).toEqual([Math.round(((1.5 + 0.5) / 4.5) * 1000) / 1000])
  })

  it('smooths with a 5 s centred moving average by default', () => {
    const spike = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]
    expect(rounded(combineTracks([track('loudness', spike)], 11))).toEqual([0, 0, 0, 0.2, 0.2, 0.2, 0.2, 0.2, 0, 0, 0])
  })

  it('pads short tracks with zeros, ignores values past the duration, and clamps', () => {
    const values = combineTracks([track('loudness', [2, Number.NaN, -1, 0.5, 0.5, 0.5])], 4, 1)
    expect(rounded(values)).toEqual([1, 0, 0, 0.5])
    expect(rounded(combineTracks([track('loudness', [1])], 3, 1))).toEqual([1, 0, 0])
  })

  it('is empty for an invalid duration', () => {
    expect(combineTracks([track('loudness', [1])], Number.NaN).length).toBe(0)
  })
})
