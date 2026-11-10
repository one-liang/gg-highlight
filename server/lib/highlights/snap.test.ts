import { describe, expect, it } from 'vitest'
import { cleanRanges, freeAround, overlaps, roundToTenths, secondsOf } from './ranges'
import { segmentAt, snapToSentences } from './snap'
import type { SnapLimits } from './snap'

const segments = [{ start: 1, end: 4 }, { start: 4, end: 6 }, { start: 8, end: 12 }]
const limits: SnapLimits = { padSec: 1, minLen: 3, maxSec: 10 }

describe('segmentAt', () => {
  it('finds the segment a start falls in (its own start included, its end not)', () => {
    expect(segmentAt(segments, 2, 'start')).toEqual({ start: 1, end: 4 })
    expect(segmentAt(segments, 4, 'start')).toEqual({ start: 4, end: 6 })
    expect(segmentAt(segments, 6, 'start')).toBeNull()
    expect(segmentAt(segments, 0.5, 'start')).toBeNull()
  })

  it('finds the segment an end falls in (its own end included, its start not)', () => {
    expect(segmentAt(segments, 4, 'end')).toEqual({ start: 1, end: 4 })
    expect(segmentAt(segments, 6, 'end')).toEqual({ start: 4, end: 6 })
    expect(segmentAt(segments, 8, 'end')).toBeNull()
    expect(segmentAt(segments, 13, 'end')).toBeNull()
    expect(segmentAt([], 3, 'end')).toBeNull()
  })
})

describe('snapToSentences', () => {
  const bounds = { start: 0, end: 20 }

  it('moves both ends out to the sentence boundaries and pads them', () => {
    expect(snapToSentences({ start: 2, end: 9 }, { start: 5, end: 6 }, segments, bounds, { ...limits, maxSec: 20 }))
      .toEqual({ start: 0, end: 13 })
  })

  it('keeps the padding inside the bounds', () => {
    expect(snapToSentences({ start: 2, end: 9 }, { start: 5, end: 6 }, segments, { start: 0.5, end: 12.4 }, { ...limits, maxSec: 20 }))
      .toEqual({ start: 0.5, end: 12.4 })
  })

  it('drops the partial sentence that reaches further when the result is too long', () => {
    // Outward [0, 13] is 13 s: the start reaches 2 s past the window, the end 3 s, so the end moves to 8.
    expect(snapToSentences({ start: 3, end: 9 }, { start: 4, end: 5 }, segments, bounds, { ...limits, maxSec: 12 }))
      .toEqual({ start: 0, end: 9 })
  })

  it('pads the window when no cut fits', () => {
    expect(snapToSentences({ start: 2, end: 9 }, { start: 3, end: 4 }, [{ start: 0, end: 20 }], bounds, { ...limits, maxSec: 8 }))
      .toEqual({ start: 1.5, end: 9.5 })
  })
})

describe('ranges', () => {
  it('treats touching ranges as not overlapping', () => {
    expect(overlaps({ start: 0, end: 5 }, { start: 5, end: 9 })).toBe(false)
    expect(overlaps({ start: 0, end: 5 }, { start: 4.9, end: 9 })).toBe(true)
  })

  it('cleans, clips and sorts ranges', () => {
    expect(cleanRanges([{ start: 9, end: 7 }, { start: -1, end: 2 }, { start: 3, end: 3 }, { start: 8, end: Number.NaN }, { start: 9, end: 30 }], 10))
      .toEqual([{ start: 0, end: 2 }, { start: 7, end: 9 }, { start: 9, end: 10 }])
  })

  it('finds the free stretch between taken ranges', () => {
    const taken = [{ start: 0, end: 3 }, { start: 15, end: 18 }, { start: 5, end: 8 }]
    expect(freeAround({ start: 9, end: 12 }, taken, 30)).toEqual({ start: 8, end: 15 })
    expect(freeAround({ start: 20, end: 22 }, taken, 30)).toEqual({ start: 18, end: 30 })
  })

  it('lists the seconds a range touches', () => {
    expect(secondsOf({ start: 2, end: 5 }, 10)).toEqual({ first: 2, last: 4 })
    expect(secondsOf({ start: 2.5, end: 5.1 }, 10)).toEqual({ first: 2, last: 5 })
    expect(secondsOf({ start: 8, end: 12 }, 10)).toEqual({ first: 8, last: 9 })
  })

  it('rounds outward to 0.1 s, inward at the bounds, and keeps the maximum length', () => {
    const bounds = { start: 0, end: 100 }
    expect(roundToTenths({ start: 10.04, end: 20.01 }, bounds, 60)).toEqual({ start: 10, end: 20.1 })
    expect(roundToTenths({ start: 20.3, end: 30.7 }, bounds, 60)).toEqual({ start: 20.3, end: 30.7 })
    expect(roundToTenths({ start: 10.04, end: 20.06 }, { start: 10.04, end: 20.06 }, 60)).toEqual({ start: 10.1, end: 20 })
    expect(roundToTenths({ start: 10.05, end: 70.05 }, bounds, 60)).toEqual({ start: 10, end: 70 })
    expect(roundToTenths({ start: 5.01, end: 5.04 }, { start: 5.01, end: 5.04 }, 60)).toBeNull()
  })
})
