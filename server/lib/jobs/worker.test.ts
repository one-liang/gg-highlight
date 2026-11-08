import { describe, expect, it } from 'vitest'
import { abortKind, JobAbort, SerialWorker, throwIfAborted } from './worker'

interface Job {
  id: string
  owner: string
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** A worker over an in-memory queue; each job waits for its gate (or an abort). */
function makeWorker() {
  const queue: Job[] = []
  const gates = new Map<string, ReturnType<typeof deferred>>()
  const log: string[] = []
  const aborts: Record<string, string | null> = {}
  let active = 0
  let maxActive = 0
  const worker = new SerialWorker<Job>({
    name: 'test',
    next: () => queue.shift() ?? null,
    ownerOf: job => job.owner,
    log: message => log.push(message),
    run: async (job, signal) => {
      active++
      maxActive = Math.max(maxActive, active)
      log.push(`start ${job.id}`)
      try {
        const gate = gates.get(job.id) ?? deferred()
        gates.set(job.id, gate)
        await new Promise<void>((resolve, reject) => {
          gate.promise.then(resolve)
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
        log.push(`end ${job.id}`)
      }
      catch {
        aborts[job.id] = abortKind(signal)
        log.push(`abort ${job.id}`)
      }
      finally {
        active--
      }
    },
  })
  const gate = (id: string) => {
    const g = gates.get(id) ?? deferred()
    gates.set(id, g)
    return g
  }
  return { worker, queue, gate, log, aborts, maxActive: () => maxActive }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

describe('SerialWorker', () => {
  it('does nothing until started, then runs jobs one at a time in order', async () => {
    const t = makeWorker()
    t.queue.push({ id: 'a', owner: 'v1' }, { id: 'b', owner: 'v2' })
    t.worker.kick()
    await tick()
    expect(t.log).toEqual([])

    t.worker.start()
    await tick()
    expect(t.worker.currentJob?.id).toBe('a')
    t.gate('a').resolve()
    await tick()
    expect(t.worker.currentJob?.id).toBe('b')
    t.gate('b').resolve()
    await t.worker.whenIdle()
    expect(t.log).toEqual(['start a', 'end a', 'start b', 'end b'])
    expect(t.maxActive()).toBe(1)
    expect(t.worker.currentJob).toBeNull()
  })

  it('picks up work queued while it was finishing (kick during the last job)', async () => {
    const t = makeWorker()
    t.queue.push({ id: 'a', owner: 'v1' })
    t.worker.start()
    await tick()
    t.gate('a').resolve()
    // Queue + kick in the same turn the last job ends.
    t.queue.push({ id: 'b', owner: 'v1' })
    t.worker.kick()
    t.gate('b').resolve()
    await t.worker.whenIdle()
    await tick()
    expect(t.log).toEqual(['start a', 'end a', 'start b', 'end b'])
  })

  it('kick after idle starts a new loop', async () => {
    const t = makeWorker()
    t.worker.start()
    await t.worker.whenIdle()
    t.queue.push({ id: 'a', owner: 'v1' })
    t.gate('a').resolve()
    t.worker.kick()
    await t.worker.whenIdle()
    expect(t.log).toEqual(['start a', 'end a'])
  })

  it('cancel(owner) aborts only the running job of that owner and waits for it', async () => {
    const t = makeWorker()
    t.queue.push({ id: 'a', owner: 'v1' }, { id: 'b', owner: 'v2' })
    t.worker.start()
    await tick()
    await t.worker.cancel('v2')
    expect(t.worker.currentJob?.id).toBe('a')
    await t.worker.cancel('v1')
    expect(t.aborts.a).toBe('cancel')
    expect(t.log).toContain('abort a')
    await tick()
    expect(t.worker.currentJob?.id).toBe('b')
    t.gate('b').resolve()
    await t.worker.whenIdle()
  })

  it('stop() aborts with kind shutdown, waits, and picks nothing new', async () => {
    const t = makeWorker()
    t.queue.push({ id: 'a', owner: 'v1' }, { id: 'b', owner: 'v2' })
    t.worker.start()
    await tick()
    await t.worker.stop()
    expect(t.aborts.a).toBe('shutdown')
    expect(t.queue.map(j => j.id)).toEqual(['b'])
    expect(t.worker.isStarted).toBe(false)
    t.worker.kick()
    await tick()
    expect(t.log).not.toContain('start b')
  })

  it('logs a job that throws and keeps going', async () => {
    const queue = ['a', 'b']
    const ran: string[] = []
    const log: string[] = []
    const worker = new SerialWorker<string>({
      name: 'boom',
      next: () => queue.shift() ?? null,
      ownerOf: id => id,
      log: m => log.push(m),
      run: async (id) => {
        ran.push(id)
        if (id === 'a') throw new Error('kaboom')
      },
    })
    worker.start()
    await worker.whenIdle()
    expect(ran).toEqual(['a', 'b'])
    expect(log.join('\n')).toContain('kaboom')
  })

  it('stops the loop when next() throws', async () => {
    const log: string[] = []
    const worker = new SerialWorker<string>({
      name: 'broken',
      next: () => {
        throw new Error('db closed')
      },
      ownerOf: id => id,
      log: m => log.push(m),
      run: async () => {},
    })
    worker.start()
    await worker.whenIdle()
    expect(log.join('\n')).toContain('db closed')
  })
})

describe('abort helpers', () => {
  it('abortKind tells cancel from shutdown', () => {
    const a = new AbortController()
    expect(abortKind(a.signal)).toBeNull()
    a.abort(new JobAbort('shutdown'))
    expect(abortKind(a.signal)).toBe('shutdown')
    const b = new AbortController()
    b.abort()
    expect(abortKind(b.signal)).toBe('cancel')
  })

  it('throwIfAborted throws the reason as an AbortError', () => {
    const a = new AbortController()
    expect(() => throwIfAborted(a.signal)).not.toThrow()
    a.abort(new JobAbort('cancel'))
    expect(() => throwIfAborted(a.signal)).toThrow('已取消')
  })
})
