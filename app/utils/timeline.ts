// Geometry helpers for the timeline bar.

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** Position of `time` as a percentage (0–100) of `duration`. */
export function timeToPercent(time: number, duration: number): number {
  if (!(duration > 0)) return 0
  return clampNumber((time / duration) * 100, 0, 100)
}

/** Time under a pointer at `clientX` on a bar starting at `left` with `width` pixels. */
export function pointerToTime(clientX: number, left: number, width: number, duration: number): number {
  if (!(width > 0) || !(duration > 0)) return 0
  return clampNumber(((clientX - left) / width) * duration, 0, duration)
}

/** CSS left/width for a range block. */
export function rangeStyle(start: number, end: number, duration: number): { left: string, width: string } {
  const left = timeToPercent(start, duration)
  const right = timeToPercent(end, duration)
  return { left: `${left}%`, width: `${Math.max(0, right - left)}%` }
}

const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600]

/** Smallest "nice" step (seconds) that keeps at most `maxTicks` intervals. */
export function chooseTickStep(duration: number, maxTicks: number): number {
  const limit = Math.max(1, Math.floor(maxTicks))
  for (const step of TICK_STEPS) {
    if (duration / step <= limit) return step
  }
  return TICK_STEPS[TICK_STEPS.length - 1]!
}

/** Tick times from 0 up to (but not past) the duration. */
export function buildTicks(duration: number, maxTicks: number): number[] {
  if (!(duration > 0)) return []
  const step = chooseTickStep(duration, maxTicks)
  const ticks: number[] = []
  for (let t = 0; t <= duration + 1e-6; t += step) ticks.push(t)
  return ticks
}
