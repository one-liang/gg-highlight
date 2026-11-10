import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPoller } from './poller'

describe('createPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('refreshes every interval while active and stops when inactive', async () => {
    let active = true
    const refresh = vi.fn(async () => {})
    const poller = createPoller({ refresh, isActive: () => active, intervalMs: 2000 })
    poller.sync()
    expect(refresh).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2000)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(refresh).toHaveBeenCalledTimes(2)

    active = false
    await vi.advanceTimersByTimeAsync(2000)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(poller.scheduled).toBe(false)
  })

  it('stops after a refresh flips the predicate', async () => {
    let active = true
    const refresh = vi.fn(async () => {
      active = false
    })
    const poller = createPoller({ refresh, isActive: () => active })
    poller.sync()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(poller.scheduled).toBe(false)
  })

  it('never overlaps a slow refresh', async () => {
    let resolveSlow: () => void = () => {}
    const refresh = vi.fn(() => new Promise<void>((r) => {
      resolveSlow = r
    }))
    const poller = createPoller({ refresh, isActive: () => true, intervalMs: 1000 })
    poller.sync()
    await vi.advanceTimersByTimeAsync(1000)
    expect(refresh).toHaveBeenCalledTimes(1)
    // sync while the request is in flight must not start a second timer
    poller.sync()
    await vi.advanceTimersByTimeAsync(5000)
    expect(refresh).toHaveBeenCalledTimes(1)
    resolveSlow()
    await vi.advanceTimersByTimeAsync(1000)
    expect(refresh).toHaveBeenCalledTimes(2)
    poller.dispose()
  })

  it('keeps polling after a failed refresh', async () => {
    const refresh = vi.fn(async () => {
      throw new Error('network')
    })
    const poller = createPoller({ refresh, isActive: () => true, intervalMs: 500 })
    poller.sync()
    await vi.advanceTimersByTimeAsync(1500)
    expect(refresh).toHaveBeenCalledTimes(3)
    poller.dispose()
  })

  it('does nothing after dispose', async () => {
    const refresh = vi.fn(async () => {})
    const poller = createPoller({ refresh, isActive: () => true })
    poller.sync()
    poller.dispose()
    poller.sync()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('restarts when it becomes active again', async () => {
    let active = false
    const refresh = vi.fn(async () => {})
    const poller = createPoller({ refresh, isActive: () => active })
    poller.sync()
    await vi.advanceTimersByTimeAsync(5000)
    expect(refresh).not.toHaveBeenCalled()
    active = true
    poller.sync()
    poller.sync()
    await vi.advanceTimersByTimeAsync(2000)
    expect(refresh).toHaveBeenCalledTimes(1)
    poller.dispose()
  })
})
