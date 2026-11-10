import { describe, expect, it } from 'vitest'
import { buildTicks, chooseTickStep, clampNumber, pointerToTime, rangeStyle, timeToPercent } from './timeline'

describe('timeline geometry', () => {
  it('clamps', () => {
    expect(clampNumber(5, 0, 3)).toBe(3)
    expect(clampNumber(-1, 0, 3)).toBe(0)
    expect(clampNumber(Number.NaN, 0, 3)).toBe(0)
  })

  it('maps time to percent', () => {
    expect(timeToPercent(30, 120)).toBe(25)
    expect(timeToPercent(200, 120)).toBe(100)
    expect(timeToPercent(-5, 120)).toBe(0)
    expect(timeToPercent(5, 0)).toBe(0)
  })

  it('maps pointer x to time', () => {
    expect(pointerToTime(150, 100, 200, 60)).toBe(15)
    expect(pointerToTime(50, 100, 200, 60)).toBe(0)
    expect(pointerToTime(400, 100, 200, 60)).toBe(60)
    expect(pointerToTime(150, 100, 0, 60)).toBe(0)
  })

  it('builds range styles', () => {
    expect(rangeStyle(30, 60, 120)).toEqual({ left: '25%', width: '25%' })
    expect(rangeStyle(100, 200, 120).width).toBe(`${100 - (100 / 120) * 100}%`)
    expect(rangeStyle(60, 30, 120).width).toBe('0%')
  })
})

describe('ticks', () => {
  it('picks a readable step', () => {
    expect(chooseTickStep(60, 8)).toBe(10)
    expect(chooseTickStep(600, 8)).toBe(120)
    expect(chooseTickStep(3 * 3600, 8)).toBe(1800)
    expect(chooseTickStep(5, 8)).toBe(1)
    expect(chooseTickStep(10 ** 7, 8)).toBe(21600)
  })

  it('lists tick times', () => {
    expect(buildTicks(60, 8)).toEqual([0, 10, 20, 30, 40, 50, 60])
    expect(buildTicks(65, 8)).toEqual([0, 10, 20, 30, 40, 50, 60])
    expect(buildTicks(0, 8)).toEqual([])
  })
})
