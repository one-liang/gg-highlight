// One-at-a-time job loop. Queued work lives in the database; the worker only asks `next()` for it.

export type StopKind = 'cancel' | 'shutdown'

/** Abort reason passed to a running job: a user cancel, or the server shutting down. */
export class JobAbort extends Error {
  readonly kind: StopKind
  constructor(kind: StopKind) {
    super(kind === 'cancel' ? '已取消' : '伺服器正在關閉')
    this.name = 'AbortError'
    this.kind = kind
  }
}

/** Why the signal was aborted, or null when it was not. */
export function abortKind(signal: AbortSignal): StopKind | null {
  if (!signal.aborted) return null
  return signal.reason instanceof JobAbort ? signal.reason.kind : 'cancel'
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new JobAbort('cancel')
}

export interface WorkerOptions<J> {
  name: string
  /** Picks the next job to run (synchronously, from the database), or null when idle. */
  next: () => J | null
  /** Video the job belongs to, for cancel(videoId). */
  ownerOf: (job: J) => string
  /** Runs one job. It records its own result; a throw here is only logged. */
  run: (job: J, signal: AbortSignal) => Promise<void>
  log: (message: string) => void
}

interface Running<J> {
  job: J
  owner: string
  controller: AbortController
  done: Promise<void>
}

export class SerialWorker<J> {
  private started = false
  private loop: Promise<void> | null = null
  private again = false
  private current: Running<J> | null = null
  private idleWaiters: Array<() => void> = []

  constructor(private readonly opts: WorkerOptions<J>) {}

  get isStarted(): boolean {
    return this.started
  }

  get currentJob(): J | null {
    return this.current?.job ?? null
  }

  start(): void {
    this.started = true
    this.kick()
  }

  kick(): void {
    if (!this.started) return
    if (this.loop) {
      // The loop may be about to finish; make it look again.
      this.again = true
      return
    }
    this.loop = this.drain().finally(() => {
      this.loop = null
      if (this.again && this.started) {
        this.again = false
        this.kick()
        return
      }
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const resolve of waiters) resolve()
    })
  }

  private async drain(): Promise<void> {
    while (this.started) {
      this.again = false
      let job: J | null
      try {
        job = this.opts.next()
      }
      catch (err) {
        this.opts.log(`[${this.opts.name}] 讀取佇列失敗：${(err as Error).message}`)
        return
      }
      if (job === null) return
      const controller = new AbortController()
      const done = this.runOne(job, controller.signal)
      this.current = { job, owner: this.opts.ownerOf(job), controller, done }
      await done
      this.current = null
    }
  }

  private async runOne(job: J, signal: AbortSignal): Promise<void> {
    try {
      await this.opts.run(job, signal)
    }
    catch (err) {
      this.opts.log(`[${this.opts.name}] 工作意外失敗：${(err as Error)?.stack ?? String(err)}`)
    }
  }

  /** Aborts the running job if it belongs to this video, and waits until it has finished. */
  async cancel(owner: string): Promise<void> {
    const current = this.current
    if (!current || current.owner !== owner) return
    if (!current.controller.signal.aborted) current.controller.abort(new JobAbort('cancel'))
    await current.done
  }

  async stop(): Promise<void> {
    this.started = false
    const current = this.current
    if (current && !current.controller.signal.aborted) current.controller.abort(new JobAbort('shutdown'))
    await this.loop
  }

  whenIdle(): Promise<void> {
    if (!this.loop) return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.push(resolve))
  }
}
