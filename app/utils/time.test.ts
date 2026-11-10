import { describe, expect, it } from 'vitest'
import { formatDuration, formatSpan, formatTime, formatTimeInput, normalizeTimeText, parseTime, snapTime } from './time'

describe('formatTime', () => {
  it('formats under an hour as m:ss.s', () => {
    expect(formatTime(0)).toBe('0:00.0')
    expect(formatTime(5)).toBe('0:05.0')
    expect(formatTime(83.4)).toBe('1:23.4')
    expect(formatTime(83.44)).toBe('1:23.4')
    expect(formatTime(83.46)).toBe('1:23.5')
    expect(formatTime(600)).toBe('10:00.0')
    expect(formatTime(3599.9)).toBe('59:59.9')
  })

  it('carries rounding into the next minute', () => {
    expect(formatTime(59.96)).toBe('1:00.0')
    expect(formatTime(119.99)).toBe('2:00.0')
  })

  it('formats an hour or more as h:mm:ss', () => {
    expect(formatTime(3600)).toBe('1:00:00')
    expect(formatTime(3599.96)).toBe('1:00:00')
    expect(formatTime(3723.4)).toBe('1:02:03')
    expect(formatTime(36000 + 59 * 60 + 59)).toBe('10:59:59')
  })

  it('treats invalid or negative input as zero', () => {
    expect(formatTime(Number.NaN)).toBe('0:00.0')
    expect(formatTime(-3)).toBe('0:00.0')
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe('0:00.0')
  })
})

describe('formatTimeInput', () => {
  it('matches formatTime under an hour', () => {
    expect(formatTimeInput(83.4)).toBe('1:23.4')
  })

  it('keeps tenths past an hour', () => {
    expect(formatTimeInput(3723.45)).toBe('1:02:03.5')
    expect(formatTimeInput(3600)).toBe('1:00:00.0')
  })

  it('round-trips through parseTime', () => {
    for (const t of [0, 0.5, 12.3, 83.4, 599.9, 3600, 3723.4, 7384.1]) {
      expect(parseTime(formatTimeInput(t))).toBeCloseTo(t, 5)
    }
  })
})

describe('formatDuration', () => {
  it('formats whole seconds', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(65.4)).toBe('1:05')
    expect(formatDuration(65.6)).toBe('1:06')
    expect(formatDuration(3723)).toBe('1:02:03')
  })
})

describe('formatSpan', () => {
  it('uses seconds under a minute', () => {
    expect(formatSpan(45.24)).toBe('45.2 秒')
    expect(formatSpan(0.5)).toBe('0.5 秒')
  })

  it('uses minutes and hours for longer spans', () => {
    expect(formatSpan(185)).toBe('3 分 5 秒')
    expect(formatSpan(59.97)).toBe('1 分 0 秒')
    expect(formatSpan(3720)).toBe('1 小時 2 分')
  })
})

describe('parseTime', () => {
  it('parses plain seconds', () => {
    expect(parseTime('83.4')).toBe(83.4)
    expect(parseTime('83')).toBe(83)
    expect(parseTime('0')).toBe(0)
    expect(parseTime('.5')).toBe(0.5)
    expect(parseTime('7.')).toBe(7)
    expect(parseTime('125')).toBe(125)
  })

  it('parses m:ss and h:mm:ss forms', () => {
    expect(parseTime('1:23.4')).toBe(83.4)
    expect(parseTime('1:02:03')).toBe(3723)
    expect(parseTime('1:02:03.5')).toBe(3723.5)
    expect(parseTime('0:05')).toBe(5)
    expect(parseTime('90:00')).toBe(5400)
  })

  it('tolerates whitespace and full-width characters', () => {
    expect(parseTime('  1:23.4 ')).toBe(83.4)
    expect(parseTime('１：２３．４')).toBe(83.4)
    expect(normalizeTimeText(' １２ ')).toBe('12')
  })

  it('returns null for invalid input', () => {
    for (const bad of ['', '   ', 'abc', '1:2:3:4', '1:60', '1:61:00', '-5', '1:-5', ':30', '1:', '1..2', '1:2a', '1e3', 'NaN']) {
      expect(parseTime(bad), bad).toBeNull()
    }
  })

  it('avoids floating point noise', () => {
    expect(parseTime('0:00.3')).toBe(0.3)
    expect(parseTime('1:00:00.1')).toBe(3600.1)
  })
})

describe('snapTime', () => {
  it('rounds to tenths and clamps to the duration', () => {
    expect(snapTime(12.345, 100)).toBe(12.3)
    expect(snapTime(99.98, 99.97)).toBe(99.97)
    expect(snapTime(-1, 10)).toBe(0)
  })
})
