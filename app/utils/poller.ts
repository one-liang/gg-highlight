// Interval refresher that runs only while `isActive()` is true and never overlaps requests.

export interface PollerOptions {
  refresh: () => unknown
  isActive: () => boolean
  intervalMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface Poller {
  /** Re-check `isActive()`: start waiting for the next tick, or stop. */
  sync: () => void
  dispose: () => void
  readonly scheduled: boolean
}

export const DEFAULT_POLL_MS = 2000

export function createPoller(options: PollerOptions): Poller {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_MS
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>))
  let timer: unknown = null
  let inFlight = false
  let disposed = false

  function clear() {
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  function schedule() {
    if (disposed || timer !== null || inFlight) return
    timer = setTimer(tick, intervalMs)
  }

  async function tick() {
    timer = null
    if (disposed || !options.isActive()) return
    inFlight = true
    try {
      await options.refresh()
    }
    catch {
      // the caller shows its own errors; keep polling
    }
    finally {
      inFlight = false
    }
    if (!disposed && options.isActive()) schedule()
  }

  return {
    sync() {
      if (options.isActive()) schedule()
      else clear()
    },
    dispose() {
      disposed = true
      clear()
    },
    get scheduled() {
      return timer !== null
    },
  }
}
