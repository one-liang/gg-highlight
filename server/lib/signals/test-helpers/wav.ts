// Builds WAV files byte by byte for the loudness tests. Not used by app code.

export interface RiffChunk {
  id: string
  data: Buffer
}

export interface WavSpec {
  sampleRate: number
  channels: number
  /** Interleaved s16 samples. */
  samples: Int16Array
  /** Chunks between 'fmt ' and 'data' (ffmpeg writes one 26-byte LIST chunk there). */
  beforeData?: RiffChunk[]
  /** Chunks between the RIFF header and 'fmt '. */
  beforeFmt?: RiffChunk[]
  /** Chunks after 'data'. */
  afterData?: RiffChunk[]
  /** Overrides the 'fmt ' body (e.g. another format code or bit depth). */
  fmt?: Buffer
  /** Overrides the size written in the 'data' header (e.g. 0xFFFFFFFF as when writing to a pipe). */
  dataSize?: number
}

/** The LIST/INFO chunk ffmpeg puts between 'fmt ' and 'data' (so 'data' starts at byte 70). */
export function ffmpegListChunk(): RiffChunk {
  const software = Buffer.from('Lavf60.16.100\0', 'latin1')
  const isft = Buffer.alloc(8)
  isft.write('ISFT', 0, 'latin1')
  isft.writeUInt32LE(software.length, 4)
  return { id: 'LIST', data: Buffer.concat([Buffer.from('INFO', 'latin1'), isft, software]) }
}

/** Plain 16-byte PCM 'fmt ' body. */
export function pcmFmt(sampleRate: number, channels: number, bitsPerSample = 16, formatCode = 1): Buffer {
  const fmt = Buffer.alloc(16)
  const blockAlign = channels * (bitsPerSample / 8)
  fmt.writeUInt16LE(formatCode, 0)
  fmt.writeUInt16LE(channels, 2)
  fmt.writeUInt32LE(sampleRate, 4)
  fmt.writeUInt32LE(sampleRate * blockAlign, 8)
  fmt.writeUInt16LE(blockAlign, 12)
  fmt.writeUInt16LE(bitsPerSample, 14)
  return fmt
}

/** 40-byte WAVE_FORMAT_EXTENSIBLE 'fmt ' body with the given SubFormat code (1 = PCM). */
export function extensibleFmt(sampleRate: number, channels: number, subFormat = 1): Buffer {
  const fmt = Buffer.alloc(40)
  pcmFmt(sampleRate, channels, 16, 0xFFFE).copy(fmt)
  fmt.writeUInt16LE(22, 16) // cbSize
  fmt.writeUInt16LE(16, 18) // valid bits
  fmt.writeUInt32LE(channels === 2 ? 0x3 : 0x4, 20) // channel mask
  fmt.writeUInt16LE(subFormat, 24)
  // Rest of KSDATAFORMAT_SUBTYPE_* GUID: 00000000-0010-8000-00AA00389B71
  Buffer.from([0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71]).copy(fmt, 26)
  return fmt
}

function chunk({ id, data }: RiffChunk, size = data.length): Buffer {
  const header = Buffer.alloc(8)
  header.write(id, 0, 'latin1')
  header.writeUInt32LE(size, 4)
  return Buffer.concat([header, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)])
}

export function makeWav(spec: WavSpec): Buffer {
  const pcm = Buffer.from(spec.samples.buffer, spec.samples.byteOffset, spec.samples.byteLength)
  const body = Buffer.concat([
    Buffer.from('WAVE', 'latin1'),
    ...(spec.beforeFmt ?? []).map(c => chunk(c)),
    chunk({ id: 'fmt ', data: spec.fmt ?? pcmFmt(spec.sampleRate, spec.channels) }),
    ...(spec.beforeData ?? []).map(c => chunk(c)),
    chunk({ id: 'data', data: pcm }, spec.dataSize),
    ...(spec.afterData ?? []).map(c => chunk(c)),
  ])
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0, 'latin1')
  riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}

/** `seconds` of mono samples from `value(t)` in -1..1 (t in seconds), rounded and clamped to s16. */
export function generate(sampleRate: number, seconds: number, value: (t: number) => number): Int16Array {
  const out = new Int16Array(Math.round(sampleRate * seconds))
  for (let i = 0; i < out.length; i++) out[i] = toS16(value(i / sampleRate))
  return out
}

/** Interleaves equally long mono channels. */
export function interleave(...channels: Int16Array[]): Int16Array {
  const frames = channels[0]!.length
  const out = new Int16Array(frames * channels.length)
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels.length; c++) out[f * channels.length + c] = channels[c]![f]!
  }
  return out
}

export function concatSamples(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function toS16(v: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(v * 32768)))
}

/** dBFS of a constant (DC) level in -1..1, rounded like the envelope. */
export function dcDb(level: number): number {
  return Math.round(20 * Math.log10(Math.abs(toS16(level)) / 32768) * 10) / 10
}

/** Mean power (full scale = 1) of a constant level after s16 quantisation. */
export function dcPower(level: number): number {
  return (toS16(level) / 32768) ** 2
}

/**
 * Reference envelope for audio whose power is constant within each second: second s averages
 * the powers of [s - 1, s + 2), weighted by how much of each second exists (`lastFraction` for
 * the final, possibly partial second).
 */
export function referenceDb(powerPerSecond: number[], lastFraction = 1): number[] {
  const n = powerPerSecond.length
  const weight = (i: number) => (i === n - 1 ? lastFraction : 1)
  return powerPerSecond.map((_, s) => {
    let sum = 0
    let w = 0
    for (let i = Math.max(0, s - 1); i <= Math.min(n - 1, s + 1); i++) {
      sum += powerPerSecond[i]! * weight(i)
      w += weight(i)
    }
    const power = sum / w
    if (!(power > 0)) return -100
    return Math.max(-100, Math.round(10 * Math.log10(power) * 10) / 10 + 0)
  })
}
