// Loudness Signal (design.md「訊號」→「音量」): stream audio.wav → dB per second → 0–1 track.
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import type { LoudnessEnvelope, SignalTrack } from './types'

/** dBFS that stands for digital silence (and anything quieter). */
export const SILENCE_DB = -100

/** RMS is measured per block of this many seconds. */
const BLOCK_SEC = 0.5
/** Short-term loudness of second i averages the power of [i - 1, i + 2): 3 s centred on the second. */
const WINDOW_BLOCKS_BEFORE = 1 / BLOCK_SEC
const WINDOW_BLOCKS = 3 / BLOCK_SEC

/** Seconds compared on each side for the baseline (design.md: 前後各 150 秒的中位數). */
const BASELINE_RADIUS_SEC = 150
/** dB above the baseline where scoring starts, and the extra dB that reach 1. */
const SCORE_FROM_DB = 3
const SCORE_RANGE_DB = 9
/** Quieter than this is never exciting (background noise, silence). */
const QUIET_DB = -50

const WAVE_FORMAT_PCM = 0x0001
const WAVE_FORMAT_EXTENSIBLE = 0xFFFE
/** A chunk size of 0xFFFFFFFF means "unknown" (ffmpeg writing to a pipe): read to the end of the file. */
const UNKNOWN_SIZE = 0xFFFFFFFF
const READ_CHUNK_BYTES = 1 << 20
const MAX_FMT_BYTES = 1024

const NOT_WAV = '音訊檔不是 WAV 格式'

interface WavFormat {
  channels: number
  sampleRate: number
}

type ParserState =
  | { kind: 'riff' }
  | { kind: 'chunk-header' }
  | { kind: 'fmt', size: number }
  | { kind: 'skip', remaining: number }
  | { kind: 'data', remaining: number }
  | { kind: 'done' }

/**
 * Incremental RIFF/WAVE parser that turns 16-bit PCM into per-block power. Accepts the bytes in
 * any chunking (a frame or a chunk header may straddle two pushes), so the file never has to be
 * in memory at once. Channels are averaged to mono before squaring.
 */
export class WavLoudnessParser {
  private state: ParserState = { kind: 'riff' }
  /** Bytes of a header (RIFF, chunk header, fmt body) or of a split frame waiting for the rest. */
  private pending: Buffer = Buffer.alloc(0)
  private format: WavFormat | null = null
  private sawData = false
  private totalFrames = 0
  private blockFrames = 0
  private blockSumSq = 0
  /** Frame index (from the start of the data) where the current block ends. */
  private nextBoundary = 0
  /** Sum of squared mono samples (in s16 units) and frame count of each finished block. */
  private readonly blockSums: number[] = []
  private readonly blockCounts: number[] = []

  push(bytes: Buffer): void {
    let offset = 0
    while (offset < bytes.length && this.state.kind !== 'done') {
      offset = this.step(bytes, offset)
    }
  }

  finish(): LoudnessEnvelope {
    if (this.state.kind === 'riff') throw new Error(NOT_WAV)
    if (!this.sawData) throw new Error(this.format ? 'WAV 檔裡沒有音訊資料' : 'WAV 檔缺少格式資訊（fmt 區塊）')
    if (this.blockFrames > 0) this.closeBlock()
    this.state = { kind: 'done' }
    return { db: this.perSecondDb() }
  }

  /** Consumes bytes from `offset` for the current state; returns the new offset. */
  private step(bytes: Buffer, offset: number): number {
    const state = this.state
    switch (state.kind) {
      case 'riff': {
        const got = this.take(bytes, offset, 12)
        if (!got) return bytes.length
        if (got.data.toString('latin1', 0, 4) !== 'RIFF' || got.data.toString('latin1', 8, 12) !== 'WAVE') throw new Error(NOT_WAV)
        this.state = { kind: 'chunk-header' }
        return got.next
      }
      case 'chunk-header': {
        const got = this.take(bytes, offset, 8)
        if (!got) return bytes.length
        this.onChunkHeader(got.data.toString('latin1', 0, 4), got.data.readUInt32LE(4))
        return got.next
      }
      case 'fmt': {
        const got = this.take(bytes, offset, state.size)
        if (!got) return bytes.length
        this.format = parseFormat(got.data)
        this.state = { kind: 'skip', remaining: state.size % 2 } // pad byte of an odd-sized chunk
        return got.next
      }
      case 'skip': {
        const n = Math.min(state.remaining, bytes.length - offset)
        state.remaining -= n
        if (state.remaining === 0) this.state = { kind: 'chunk-header' }
        return offset + n
      }
      case 'data': {
        const n = Math.min(state.remaining, bytes.length - offset)
        this.consumeSamples(bytes, offset, offset + n)
        state.remaining -= n
        // Anything after the audio (e.g. a trailing LIST chunk) does not matter.
        if (state.remaining === 0) this.state = { kind: 'done' }
        return offset + n
      }
      case 'done':
        return bytes.length
    }
  }

  private onChunkHeader(id: string, size: number) {
    if (id === 'fmt ') {
      // 16, 18 or 40 bytes in practice; a huge size means a corrupt header (and would be buffered).
      if (size < 16 || size > MAX_FMT_BYTES) throw new Error('WAV 檔的格式資訊（fmt 區塊）不正確')
      this.state = { kind: 'fmt', size }
    }
    else if (id === 'data') {
      if (!this.format) throw new Error('WAV 檔缺少格式資訊（fmt 區塊）')
      this.sawData = true
      this.nextBoundary = this.boundaryOf(0)
      this.state = { kind: 'data', remaining: size === UNKNOWN_SIZE ? Infinity : size }
    }
    else {
      this.state = { kind: 'skip', remaining: size + (size % 2) }
    }
  }

  /**
   * Collects exactly `size` bytes, across pushes if needed; `next` is the offset after them in
   * `bytes`. Null when `bytes` ran out first (what it had is kept for the next push).
   */
  private take(bytes: Buffer, offset: number, size: number): { data: Buffer, next: number } | null {
    const need = size - this.pending.length
    if (bytes.length - offset < need) {
      this.pending = Buffer.concat([this.pending, bytes.subarray(offset)])
      return null
    }
    const data = Buffer.concat([this.pending, bytes.subarray(offset, offset + need)])
    this.pending = Buffer.alloc(0)
    return { data, next: offset + need }
  }

  private consumeSamples(bytes: Buffer, start: number, end: number) {
    const frameBytes = this.format!.channels * 2
    let pos = start
    if (this.pending.length > 0) {
      // Complete the frame split across the previous push.
      const need = frameBytes - this.pending.length
      if (end - pos < need) {
        this.pending = Buffer.concat([this.pending, bytes.subarray(pos, end)])
        return
      }
      const frame = Buffer.concat([this.pending, bytes.subarray(pos, pos + need)])
      this.pending = Buffer.alloc(0)
      this.accumulate(frame, 0, 1)
      pos += need
    }
    const frames = Math.floor((end - pos) / frameBytes)
    this.accumulate(bytes, pos, frames)
    pos += frames * frameBytes
    if (pos < end) this.pending = Buffer.from(bytes.subarray(pos, end))
  }

  /** Adds `frames` whole frames starting at byte `pos`, closing blocks at their boundaries. */
  private accumulate(bytes: Buffer, pos: number, frames: number) {
    const channels = this.format!.channels
    let left = frames
    while (left > 0) {
      const n = Math.min(left, this.nextBoundary - this.totalFrames)
      this.blockSumSq += channels === 1 ? sumSquaresMono(bytes, pos, n) : sumSquaresMixed(bytes, pos, n, channels)
      pos += n * channels * 2
      left -= n
      this.totalFrames += n
      this.blockFrames += n
      if (this.totalFrames === this.nextBoundary) this.closeBlock()
    }
  }

  private closeBlock() {
    this.blockSums.push(this.blockSumSq)
    this.blockCounts.push(this.blockFrames)
    this.blockSumSq = 0
    this.blockFrames = 0
    this.nextBoundary = this.boundaryOf(this.blockSums.length)
  }

  /** Frame index where block `index` ends (rounded, so odd sample rates work too). */
  private boundaryOf(index: number): number {
    return Math.round((index + 1) * BLOCK_SEC * this.format!.sampleRate)
  }

  private perSecondDb(): number[] {
    const seconds = Math.ceil(this.totalFrames / this.format!.sampleRate)
    const blocks = this.blockSums.length
    const db: number[] = Array.from({ length: seconds })
    for (let s = 0; s < seconds; s++) {
      const from = Math.max(0, s / BLOCK_SEC - WINDOW_BLOCKS_BEFORE)
      const to = Math.min(blocks, s / BLOCK_SEC - WINDOW_BLOCKS_BEFORE + WINDOW_BLOCKS)
      let sum = 0
      let count = 0
      for (let b = from; b < to; b++) {
        sum += this.blockSums[b]!
        count += this.blockCounts[b]!
      }
      db[s] = powerToDb(count > 0 ? sum / count / (32768 * 32768) : 0)
    }
    return db
  }
}

function parseFormat(fmt: Buffer): WavFormat {
  let audioFormat = fmt.readUInt16LE(0)
  const channels = fmt.readUInt16LE(2)
  const sampleRate = fmt.readUInt32LE(4)
  const blockAlign = fmt.readUInt16LE(12)
  const bits = fmt.readUInt16LE(14)
  // WAVE_FORMAT_EXTENSIBLE keeps the real format code in the first two bytes of SubFormat.
  if (audioFormat === WAVE_FORMAT_EXTENSIBLE && fmt.length >= 26) audioFormat = fmt.readUInt16LE(24)
  if (audioFormat !== WAVE_FORMAT_PCM || bits !== 16) {
    const what = audioFormat === WAVE_FORMAT_PCM ? `${bits} 位元 PCM` : `格式代碼 0x${audioFormat.toString(16).padStart(4, '0')}`
    throw new Error(`不支援的 WAV 格式（${what}），只支援 16 位元 PCM`)
  }
  if (channels < 1 || sampleRate < 1 || blockAlign !== channels * 2) throw new Error('WAV 檔的格式資訊（fmt 區塊）不正確')
  return { channels, sampleRate }
}

function sumSquaresMono(bytes: Buffer, pos: number, frames: number): number {
  let sum = 0
  const end = pos + frames * 2
  for (let i = pos; i < end; i += 2) {
    const v = ((bytes[i]! | (bytes[i + 1]! << 8)) << 16) >> 16
    sum += v * v
  }
  return sum
}

function sumSquaresMixed(bytes: Buffer, pos: number, frames: number, channels: number): number {
  let sum = 0
  const frameBytes = channels * 2
  const end = pos + frames * frameBytes
  for (let i = pos; i < end; i += frameBytes) {
    let mixed = 0
    for (let c = i; c < i + frameBytes; c += 2) mixed += ((bytes[c]! | (bytes[c + 1]! << 8)) << 16) >> 16
    mixed /= channels
    sum += mixed * mixed
  }
  return sum
}

/** Mean power (full scale = 1) → dBFS rounded to 0.1, clamped to SILENCE_DB. */
function powerToDb(power: number): number {
  if (!(power > 0)) return SILENCE_DB
  const db = 10 * Math.log10(power)
  if (db <= SILENCE_DB) return SILENCE_DB
  return Math.round(db * 10) / 10 + 0 // + 0 turns -0 into 0
}

/**
 * Streams a PCM WAV file (16 kHz mono s16le as written by extractAudio; parse RIFF chunks, do not
 * assume a 44-byte header) and returns its short-term loudness per second (design.md「音量」).
 * Rejects with the abort reason when `signal` aborts.
 */
export async function readLoudnessEnvelope(
  wavPath: string,
  opts: { signal?: AbortSignal, onProgress?: (fraction: number) => void } = {},
): Promise<LoudnessEnvelope> {
  const { signal, onProgress } = opts
  signal?.throwIfAborted()
  const { size } = await fs.stat(wavPath)
  signal?.throwIfAborted()

  const parser = new WavLoudnessParser()
  let lastReported = 0
  const report = (fraction: number) => {
    if (fraction <= lastReported) return
    lastReported = fraction
    onProgress?.(fraction)
  }

  return new Promise<LoudnessEnvelope>((resolve, reject) => {
    const stream = createReadStream(wavPath, { highWaterMark: READ_CHUNK_BYTES })
    let settled = false
    let bytesRead = 0
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const fail = (err: unknown) => {
      stream.destroy()
      settle(() => reject(err))
    }
    const onAbort = () => fail(signal!.reason)
    signal?.addEventListener('abort', onAbort, { once: true })

    stream.on('data', (chunk) => {
      if (settled) return
      const bytes = chunk as Buffer
      bytesRead += bytes.length
      try {
        parser.push(bytes)
        report(size > 0 ? Math.min(1, bytesRead / size) : 1)
      }
      catch (err) {
        fail(err)
      }
    })
    stream.on('error', fail)
    stream.on('end', () => {
      if (settled) return
      try {
        const envelope = parser.finish()
        report(1)
        settle(() => resolve(envelope))
      }
      catch (err) {
        fail(err)
      }
    })
  })
}

/** Rolling median of `values[0..count)` (no NaN) over [i - radius, i + radius], clipped at the ends. */
export function rollingMedian(values: ArrayLike<number>, count: number, radius: number): Float64Array {
  const out = new Float64Array(count)
  // Sorted copy of the current window; one removal and one insertion per step.
  const window = new Float64Array(Math.min(count, 2 * radius + 1))
  let size = 0
  const insert = (v: number) => {
    let i = size++
    while (i > 0 && window[i - 1]! > v) {
      window[i] = window[i - 1]!
      i--
    }
    window[i] = v
  }
  const remove = (v: number) => {
    let i = lowerBound(window, size, v)
    size--
    for (; i < size; i++) window[i] = window[i + 1]!
  }
  for (let i = 0; i < Math.min(count, radius); i++) insert(values[i]!)
  for (let i = 0; i < count; i++) {
    if (i - radius - 1 >= 0) remove(values[i - radius - 1]!)
    if (i + radius < count) insert(values[i + radius]!)
    const mid = size >> 1
    out[i] = size % 2 === 1 ? window[mid]! : (window[mid - 1]! + window[mid]!) / 2
  }
  return out
}

function lowerBound(sorted: Float64Array, size: number, v: number): number {
  let lo = 0
  let hi = size
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid]! < v) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Loudness envelope → 0–1 per second: 3 dB above the ±150 s rolling median starts scoring, 12 dB is 1, below -50 dBFS is 0. */
export function loudnessTrack(envelope: LoudnessEnvelope, durationSec: number): SignalTrack {
  const length = Number.isFinite(durationSec) && durationSec > 0 ? Math.ceil(durationSec) : 0
  const track = new Float32Array(length)
  // Seconds past the end of the envelope stay 0 and do not take part in the baseline.
  const count = Math.min(length, envelope.db.length)
  const baseline = rollingMedian(envelope.db, count, BASELINE_RADIUS_SEC)
  for (let i = 0; i < count; i++) {
    const db = envelope.db[i]!
    if (db < QUIET_DB) continue
    track[i] = Math.min(1, Math.max(0, (db - baseline[i]! - SCORE_FROM_DB) / SCORE_RANGE_DB))
  }
  return track
}
