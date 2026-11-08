// Progress reporting: monotonic, and written to the database at most every `intervalMs`.

export interface ThrottledProgress {
  /** Reports a value (0–1); lower values than the last one are ignored. `force` writes right away. */
  report(value: number, force?: boolean): void
  readonly value: number
}

export function createThrottledProgress(write: (value: number) => void, now: () => number, intervalMs: number): ThrottledProgress {
  let last = 0
  let written = -1
  let lastWriteAt = Number.NEGATIVE_INFINITY
  return {
    report(value, force = false) {
      const v = Math.min(1, Math.max(last, Number.isFinite(value) ? value : 0))
      last = v
      if (v === written) return
      const t = now()
      if (!force && t - lastWriteAt < intervalMs) return
      written = v
      lastWriteAt = t
      write(v)
    },
    get value() {
      return last
    },
  }
}

export interface StepProgress<S extends string> {
  /** Moves to the next step; writes right away. */
  step(name: S): void
  /** Progress within the current step, 0–1. */
  update(fraction: number): void
  readonly current: S
  readonly overall: number
}

/** Overall progress from weighted steps (weights sum to 1), e.g. probe 2 %, transcribe 75 %. */
export function createStepProgress<S extends string>(
  weights: ReadonlyArray<readonly [S, number]>,
  write: (step: S, overall: number) => void,
  now: () => number,
  intervalMs: number,
): StepProgress<S> {
  const first = weights[0]
  if (!first) throw new Error('steps must not be empty')
  let current: S = first[0]
  let base = 0
  let weight = first[1]
  let last = 0
  let lastWriteAt = Number.NEGATIVE_INFINITY
  const round = (x: number) => Math.round(x * 10000) / 10000
  const emit = (force: boolean) => {
    const t = now()
    if (!force && t - lastWriteAt < intervalMs) return
    lastWriteAt = t
    write(current, last)
  }
  return {
    step(name) {
      let offset = 0
      for (const [step, w] of weights) {
        if (step === name) {
          current = name
          base = offset
          weight = w
          last = Math.max(last, round(offset))
          // A step change is always written.
          emit(true)
          return
        }
        offset += w
      }
      throw new Error(`unknown step ${name}`)
    },
    update(fraction) {
      const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0))
      const v = Math.min(1, Math.max(last, round(base + weight * f)))
      if (v === last) return
      last = v
      emit(false)
    },
    get current() {
      return current
    },
    get overall() {
      return last
    },
  }
}
