import { describe, expect, it } from 'vitest'
import { DownloadProgress, formatFraction, parseFileLine, parseProgressLine } from './progress'

const line = (formatId: string, progress: Record<string, unknown>) => `GGDL ${formatId} ${JSON.stringify(progress)}`

describe('parseProgressLine', () => {
  it('reads the format id and the JSON fields', () => {
    expect(parseProgressLine(line('137', { status: 'downloading', downloaded_bytes: 10, total_bytes: 100 }))).toEqual({
      formatId: '137',
      status: 'downloading',
      downloadedBytes: 10,
      totalBytes: 100,
      totalBytesEstimate: null,
      fragmentIndex: null,
      fragmentCount: null,
    })
  })

  it('tolerates nulls, missing fields and surrounding whitespace', () => {
    const p = parseProgressLine(`  GGDL 140 {"status":"downloading","downloaded_bytes":5,"total_bytes":null,"total_bytes_estimate":50.5}\r`)
    expect(p).toMatchObject({ formatId: '140', downloadedBytes: 5, totalBytes: null, totalBytesEstimate: 50.5 })
  })

  it('ignores other lines and broken JSON', () => {
    expect(parseProgressLine('[download]  45.0% of 10MiB')).toBeNull()
    expect(parseProgressLine('GGDL 137 {not json')).toBeNull()
    expect(parseProgressLine('GGDL 137 [1,2]')).toBeNull()
    expect(parseProgressLine('GGDL 137')).toBeNull()
    expect(parseProgressLine('WARNING: GGDL 137 {}')).toBeNull()
  })
})

describe('formatFraction', () => {
  const base = { formatId: '137', status: 'downloading', downloadedBytes: null, totalBytes: null, totalBytesEstimate: null, fragmentIndex: null, fragmentCount: null }

  it('bytes over total, else over the estimate', () => {
    expect(formatFraction({ ...base, downloadedBytes: 25, totalBytes: 100 })).toBe(0.25)
    expect(formatFraction({ ...base, downloadedBytes: 25, totalBytesEstimate: 50 })).toBe(0.5)
    expect(formatFraction({ ...base, downloadedBytes: 25, totalBytes: 0, totalBytesEstimate: 50 })).toBe(0.5)
    expect(formatFraction({ ...base, downloadedBytes: 150, totalBytesEstimate: 100 })).toBe(1)
  })

  it('fragments when there are no byte totals', () => {
    expect(formatFraction({ ...base, downloadedBytes: 1234, fragmentIndex: 3, fragmentCount: 12 })).toBe(0.25)
    expect(formatFraction({ ...base, fragmentIndex: 3, fragmentCount: 0 })).toBeNull()
  })

  it('finished is 1, nothing known is null', () => {
    expect(formatFraction({ ...base, status: 'finished' })).toBe(1)
    expect(formatFraction(base)).toBeNull()
  })
})

describe('DownloadProgress', () => {
  it('first format 0–0.9, second 0.9–1', () => {
    const p = new DownloadProgress()
    expect(p.push(line('137', { status: 'downloading', downloaded_bytes: 50, total_bytes: 100 }))).toBeCloseTo(0.45)
    expect(p.push(line('137', { status: 'finished', downloaded_bytes: 100, total_bytes: 100 }))).toBeCloseTo(0.9)
    expect(p.push(line('140', { status: 'downloading', downloaded_bytes: 5, total_bytes_estimate: 10 }))).toBeCloseTo(0.95)
    expect(p.push(line('140', { status: 'finished', downloaded_bytes: 10, total_bytes: 10 }))).toBeCloseTo(1)
    expect(p.value).toBeCloseTo(1)
  })

  it('never goes backwards and ignores repeated or unknown lines', () => {
    const p = new DownloadProgress()
    expect(p.push(line('137', { downloaded_bytes: 80, total_bytes: 100 }))).toBeCloseTo(0.72)
    expect(p.push(line('137', { downloaded_bytes: 40, total_bytes: 100 }))).toBeNull()
    expect(p.push(line('137', { downloaded_bytes: 80, total_bytes: 100 }))).toBeNull()
    expect(p.push(line('137', { status: 'downloading' }))).toBeNull()
    expect(p.push('GGFILE "/x.mp4"')).toBeNull()
    expect(p.push('random')).toBeNull()
    expect(p.value).toBeCloseTo(0.72)
  })

  it('a format seen again keeps its slot; a third format counts as done', () => {
    const p = new DownloadProgress()
    p.push(line('137', { downloaded_bytes: 10, total_bytes: 100 }))
    p.push(line('137', { status: 'finished', downloaded_bytes: 100, total_bytes: 100 }))
    p.push(line('140', { downloaded_bytes: 1, total_bytes: 10 }))
    expect(p.value).toBeCloseTo(0.91)
    expect(p.push(line('137', { status: 'finished' }))).toBeNull()
    expect(p.push(line('140', { status: 'finished' }))).toBe(1)
    expect(p.push(line('999', { downloaded_bytes: 1, total_bytes: 10 }))).toBeNull()
  })

  it('counts the next format only after the one before it finished (a video part that gave up)', () => {
    // Real yt-dlp 2026.10.26 against a server that drops every connection after 1 MiB: format 137 gives
    // up after its retries, yt-dlp still downloads 140, then exits 1.
    const p = new DownloadProgress()
    expect(p.push(line('137', { status: 'downloading', downloaded_bytes: 4190208, total_bytes: 24651883 }))).toBeCloseTo(0.153, 3)
    expect(p.push(line('137', { status: 'downloading', downloaded_bytes: 8380416, total_bytes: 24651883 }))).toBeCloseTo(0.306, 3)
    expect(p.push('ERROR:  [download] Got error: 1048576 bytes read, 8987961 more expected. Giving up after 10 retries')).toBeNull()
    expect(p.push(line('140', { status: 'downloading', downloaded_bytes: 1024, total_bytes: 194404 }))).toBeNull()
    expect(p.push(line('140', { status: 'finished', downloaded_bytes: 194404, total_bytes: 194404 }))).toBeNull()
    expect(p.value).toBeCloseTo(0.306, 3)
  })

  it('a part already on disk reports finished, so the next one counts', () => {
    const p = new DownloadProgress()
    expect(p.push(line('137', { status: 'finished', total_bytes: 24651883 }))).toBeCloseTo(0.9)
    expect(p.push(line('140', { status: 'downloading', downloaded_bytes: 97202, total_bytes: 194404 }))).toBeCloseTo(0.95)
  })

  it('uses fragments when the bytes have no total', () => {
    const p = new DownloadProgress()
    expect(p.push(line('270', { downloaded_bytes: 5000, fragment_index: 5, fragment_count: 10 }))).toBeCloseTo(0.45)
  })
})

describe('parseFileLine', () => {
  it('decodes the JSON string path', () => {
    expect(parseFileLine('GGFILE "/data/downloads/abc.mp4"')).toBe('/data/downloads/abc.mp4')
    expect(parseFileLine('GGFILE "C:\\\\gg\\\\data\\\\downloads\\\\abc.mp4"')).toBe('C:\\gg\\data\\downloads\\abc.mp4')
    expect(parseFileLine('GGFILE "/d/\\u5f71\\u7247.mp4"\r')).toBe('/d/影片.mp4')
  })

  it('ignores other lines, non-strings and broken JSON', () => {
    expect(parseFileLine('GGFILE NA')).toBeNull()
    expect(parseFileLine('GGFILE null')).toBeNull()
    expect(parseFileLine('GGFILE ""')).toBeNull()
    expect(parseFileLine('GGFILE "/unterminated')).toBeNull()
    expect(parseFileLine('[download] Destination: x')).toBeNull()
  })
})
