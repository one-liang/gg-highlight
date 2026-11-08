import { describe, expect, it } from 'vitest'
import { formatBytes, formatDate, formatDateTime, formatFps, formatPercent, formatResolution, formatScore, progressPercent } from './format'

describe('formatBytes', () => {
  it('formats with binary units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(12 * 1024 * 1024)).toBe('12 MB')
    expect(formatBytes(3.24 * 1024 ** 3)).toBe('3.2 GB')
    expect(formatBytes(2 * 1024 ** 4)).toBe('2 TB')
    expect(formatBytes(5000 * 1024 ** 4)).toBe('5000 TB')
  })

  it('handles invalid input', () => {
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })
})

describe('formatDate / formatDateTime', () => {
  it('formats in local time', () => {
    const iso = new Date(2026, 9, 9, 7, 3).toISOString()
    expect(formatDate(iso)).toBe('2026/10/09')
    expect(formatDateTime(iso)).toBe('2026/10/09 07:03')
  })

  it('returns empty text for missing or invalid dates', () => {
    expect(formatDate(null)).toBe('')
    expect(formatDateTime(undefined)).toBe('')
    expect(formatDateTime('not a date')).toBe('')
  })
})

describe('media formatting', () => {
  it('formats resolution and fps', () => {
    expect(formatResolution(1920, 1080)).toBe('1920×1080')
    expect(formatFps(60)).toBe('60 fps')
    expect(formatFps(29.97002997)).toBe('29.97 fps')
    expect(formatFps(0)).toBe('')
  })
})

describe('progress', () => {
  it('floors and clamps', () => {
    expect(formatPercent(0.425)).toBe('42%')
    expect(formatPercent(0.999)).toBe('99%')
    expect(formatPercent(1)).toBe('100%')
    expect(progressPercent(-0.2)).toBe(0)
    expect(progressPercent(1.7)).toBe(100)
    expect(progressPercent(Number.NaN)).toBe(0)
  })
})

describe('formatScore', () => {
  it('maps 0–1 to 0–100', () => {
    expect(formatScore(0.823)).toBe('82')
    expect(formatScore(1)).toBe('100')
    expect(formatScore(Number.NaN)).toBe('')
  })
})
