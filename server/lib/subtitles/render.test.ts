// Integration: libass (through ffmpeg's subtitles filter) accepts and draws what buildAss writes.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { buildAss, buildTranscriptSegments, cuesForRange, FONT_SIZE_PER_EM, subtitleStyleFor } from './index'
import type { SubtitleCanvas } from './index'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const ffmpeg = process.env.GG_FFMPEG ?? 'ffmpeg'

/** Folders holding a Noto CJK font: the app's fonts folder and the system one (a .ttc collection). */
function findFontsDirs(): string[] {
  const candidates = [
    process.env.GG_FONTS_DIR ? path.resolve(repoRoot, process.env.GG_FONTS_DIR) : null,
    path.join(repoRoot, 'fonts'),
    '/usr/share/fonts/opentype/noto',
  ]
  const found: string[] = []
  for (const dir of candidates) {
    if (!dir || found.includes(dir) || !existsSync(dir)) continue
    if (readdirSync(dir).some(f => /noto/i.test(f) && /\.(otf|ttf|ttc)$/i.test(f))) found.push(dir)
  }
  return found
}

const fontsDirs = findFontsDirs()
const fontsDir = fontsDirs[0] ?? null
const hasFfmpeg = spawnSync(ffmpeg, ['-hide_banner', '-version'], { windowsHide: true }).status === 0

/** Filter option value: forward slashes, escaped drive-letter colon, quoted. */
function filterValue(p: string): string {
  return `'${p.replace(/\\/g, '/').replace(/:/g, '\\:')}'`
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'gg-subtitles-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function runSubtitles(assName: string, canvas: SubtitleCanvas, extra: string[], logLevel = 'error', fonts = fontsDir!, background = 'black') {
  const filter = `subtitles=filename=${assName}:fontsdir=${filterValue(fonts)}`
  return spawnSync(ffmpeg, [
    '-hide_banner', '-nostdin', '-loglevel', logLevel,
    '-f', 'lavfi', '-i', `color=c=${background}:s=${canvas.width}x${canvas.height}:r=10:d=3`,
    '-vf', filter,
    ...extra,
  ], { cwd: tmp, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
}

/** Grabs the frame at `at` seconds as 8-bit gray pixels. */
function grabGray(assName: string, canvas: SubtitleCanvas, at: number, background = 'black'): Buffer {
  const r = runSubtitles(assName, canvas, ['-ss', String(at), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], 'error', fontsDir!, background)
  expect(r.status, r.stderr?.toString()).toBe(0)
  expect(r.stdout.length).toBe(canvas.width * canvas.height)
  return r.stdout
}

/** First and last rows that contain white (text fill) pixels. */
function whiteRows(frame: Buffer, canvas: SubtitleCanvas): [number, number] | null {
  let first = -1
  let last = -1
  for (let y = 0; y < canvas.height; y++) {
    const row = frame.subarray(y * canvas.width, (y + 1) * canvas.width)
    if (row.some(v => v > 200)) {
      if (first < 0) first = y
      last = y
    }
  }
  return first < 0 ? null : [first, last]
}

/** First and last columns whose pixels differ from a mid-gray background (white text or its black outline). */
function inkColumns(frame: Buffer, canvas: SubtitleCanvas): [number, number] | null {
  let first = -1
  let last = -1
  for (let x = 0; x < canvas.width; x++) {
    for (let y = 0; y < canvas.height; y++) {
      if (Math.abs(frame[y * canvas.width + x]! - 128) > 40) {
        if (first < 0) first = x
        last = x
        break
      }
    }
  }
  return first < 0 ? null : [first, last]
}

/** First and last columns that contain white (text fill) pixels. */
function whiteColumns(frame: Buffer, canvas: SubtitleCanvas): [number, number] | null {
  let first = -1
  let last = -1
  for (let x = 0; x < canvas.width; x++) {
    for (let y = 0; y < canvas.height; y++) {
      if (frame[y * canvas.width + x]! > 200) {
        if (first < 0) first = x
        last = x
        break
      }
    }
  }
  return first < 0 ? null : [first, last]
}

describe.skipIf(!hasFfmpeg || !fontsDir)('buildAss rendered by libass', () => {
  const canvas: SubtitleCanvas = { width: 1080, height: 1920, layout: 'blurred-background' }
  const segments = buildTranscriptSegments({
    language: 'zh',
    durationSec: 10,
    model: 'test',
    device: 'cpu',
    segments: [
      {
        start: 0,
        end: 6,
        text: '这个游戏太厉害了，我们再来一局吧！',
        words: Array.from('这个游戏太厉害了，我们再来一局吧！').map((ch, i) => ({ word: ch, start: 0.5 + i * 0.2, end: 0.7 + i * 0.2, probability: 1 })),
      },
    ],
  }, 'zh')
  const cues = [
    ...cuesForRange(segments, 0, 10),
    { start: 2.5, end: 3, text: 'Hello {\\b1}world\\N!' },
  ]

  it.each(fontsDirs)('parses the document without errors (-f null, fontsdir %s)', (fonts) => {
    writeFileSync(path.join(tmp, 'vertical.ass'), buildAss(cues, canvas))
    const r = runSubtitles('vertical.ass', canvas, ['-nostats', '-f', 'null', '-'], 'info', fonts)
    const log = r.stderr.toString()
    expect(r.status, log).toBe(0)
    expect(log).not.toMatch(/error|invalid/i)
    // libass picked the subtitle font itself, and every glyph (incl. ｛＼｝) was in it.
    expect(log).toMatch(/fontselect: \(Noto Sans CJK TC, 700, 0\) -> [^\n]*Noto/i)
    expect(log).not.toMatch(/Glyph 0x[0-9A-F]+ not found/)
  })

  it('draws white text just below the centred 16:9 band on the vertical canvas', () => {
    writeFileSync(path.join(tmp, 'vertical.ass'), buildAss(cues, canvas))
    const rows = whiteRows(grabGray('vertical.ass', canvas, 1), canvas)
    expect(rows).not.toBeNull()
    const [top, bottom] = rows!
    const bandBottom = (canvas.height + canvas.width * 9 / 16) / 2
    expect(top).toBeGreaterThan(bandBottom)
    expect(bottom).toBeLessThanOrEqual(canvas.height - subtitleStyleFor(canvas).marginV)
  })

  it('draws big characters: Fontsize 100 is about 69 px per CJK character (大字)', () => {
    writeFileSync(path.join(tmp, 'size.ass'), buildAss([{ start: 0, end: 3, text: '一二三四五六七八九十' }], canvas))
    const cols = whiteColumns(grabGray('size.ass', canvas, 1), canvas)
    expect(cols).not.toBeNull()
    const width = cols![1] - cols![0] + 1
    // 10 characters of 100 / 1.45 px, minus the side bearings of the first and last one
    expect(width).toBeGreaterThan(640)
    expect(width).toBeLessThanOrEqual(Math.ceil(10 * subtitleStyleFor(canvas).fontSize / FONT_SIZE_PER_EM))
  })

  it('keeps a full two-line segment (13 characters a line) between the side margins', () => {
    const text = '一二三四五六七八九十一二三四五六七八九十一二三四五六'
    writeFileSync(path.join(tmp, 'full.ass'), buildAss([{ start: 0, end: 3, text }], canvas))
    const style = subtitleStyleFor(canvas)
    const cols = inkColumns(grabGray('full.ass', canvas, 1, 'gray'), canvas)
    expect(cols).not.toBeNull()
    expect(cols![0]).toBeGreaterThanOrEqual(style.marginH - style.outline)
    expect(cols![1]).toBeLessThan(canvas.width - style.marginH + style.outline)
  })

  it.each([
    ['a 60-character edited zh segment', '這段字幕是使用者自己補上很多漏掉的字所以變得非常非常長'.repeat(3).slice(0, 60)],
    ['the 200 characters the editor allows', '字'.repeat(200)],
    ['latin capitals', 'OH MY GOD THIS IS AMAZING WHAT A PLAY WE WON THE GAME'],
  ])('shrinks %s so it stays between the side margins (never off the frame edges)', (_name, text) => {
    writeFileSync(path.join(tmp, 'long.ass'), buildAss([{ start: 0, end: 3, text }], canvas))
    const style = subtitleStyleFor(canvas)
    const cols = inkColumns(grabGray('long.ass', canvas, 1, 'gray'), canvas)
    expect(cols).not.toBeNull()
    expect(cols![0]).toBeGreaterThanOrEqual(style.marginH - style.outline)
    expect(cols![1]).toBeLessThan(canvas.width - style.marginH + style.outline)
  })

  it('draws nothing between cues', () => {
    writeFileSync(path.join(tmp, 'gap.ass'), buildAss([{ start: 2, end: 3, text: '之後才出現' }], canvas))
    expect(whiteRows(grabGray('gap.ass', canvas, 1), canvas)).toBeNull()
    expect(whiteRows(grabGray('gap.ass', canvas, 2.5), canvas)).not.toBeNull()
  })

  it('renders the original layout near the bottom of a landscape frame', () => {
    const landscape: SubtitleCanvas = { width: 1280, height: 720, layout: 'original' }
    writeFileSync(path.join(tmp, 'landscape.ass'), buildAss([{ start: 0, end: 3, text: '原比例版型的字幕 Good game' }], landscape))
    const rows = whiteRows(grabGray('landscape.ass', landscape, 1), landscape)
    expect(rows).not.toBeNull()
    expect(rows![0]).toBeGreaterThan(landscape.height / 2)
    expect(rows![1]).toBeLessThanOrEqual(landscape.height - subtitleStyleFor(landscape).marginV)
  })
})
