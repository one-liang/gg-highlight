// Helpers for the media tests (real ffmpeg/ffprobe, generated fixtures). Not used by app code.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll } from 'vitest'
import { fixtures } from '../../../tests/fixtures'
import type { MediaTools } from './types'

export const tools: MediaTools = { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }

export const fx = fixtures()

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** A Noto Sans CJK font file: the Linux system copy, else whatever `pnpm fonts` put in fonts/. Null skips font tests. */
function findCjkFont(): string | null {
  const system = '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'
  if (existsSync(system)) return system
  const dir = path.join(REPO_ROOT, 'fonts')
  try {
    const name = readdirSync(dir).find(n => /\.(?:otf|ttf|ttc)$/i.test(n))
    return name ? path.join(dir, name) : null
  }
  catch {
    return null
  }
}

export const CJK_FONT = findCjkFont()

/** Puts the CJK font into `dir` (symlink, or a copy where symlinks need privileges); returns its path. */
export async function installFont(dir: string): Promise<string> {
  if (!CJK_FONT) throw new Error('no CJK font available')
  const target = path.join(dir, path.basename(CJK_FONT))
  await fs.symlink(CJK_FONT, target).catch(() => fs.copyFile(CJK_FONT, target))
  return target
}

/** Windows forbids ':' in names and silently drops trailing spaces. */
export function validDirName(name: string): boolean {
  return process.platform !== 'win32' || !/:|\s$/.test(name)
}

const tmpDirs: string[] = []

// Runs once per test file (each file gets its own copy of this module).
afterAll(async () => {
  await Promise.all(tmpDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 })))
})

/** A fresh scratch folder under the OS temp dir, removed after the test file. */
export async function makeTmpDir(prefix = 'gg-media-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

export interface RawStream {
  codec_type: string
  codec_name: string
  width?: number
  height?: number
  pix_fmt?: string
  profile?: string
  sample_rate?: string
  channels?: number
  avg_frame_rate?: string
}

/** Raw ffprobe streams + format, for properties MediaInfo does not carry (pix_fmt, sample rate…). */
export function rawProbe(file: string): { streams: RawStream[], format: { format_name: string, duration: string } } {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return JSON.parse(r.stdout)
}

/** One frame at `t` seconds as 8-bit gray pixels (row-major, width × height). */
export function grayFrame(file: string, t: number): Buffer {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(r.stderr.toString())
  return r.stdout
}

/** Pixels in rows [y0, y1) whose gray values differ by more than `threshold`. */
export function countDiff(a: Buffer, b: Buffer, width: number, y0: number, y1: number, threshold = 64): number {
  let n = 0
  for (let i = y0 * width; i < y1 * width; i++) {
    if (Math.abs(a[i]! - b[i]!) > threshold) n++
  }
  return n
}

/** Minimal valid ASS: white bold Noto Sans CJK TC, bottom centred, one event covering `seconds`. */
export function minimalAss(text: string, playRes = { width: 1080, height: 1920 }, fontSize = Math.round(playRes.height / 18), seconds = 30): string {
  // H:MM:SS.cc
  const end = new Date(seconds * 1000).toISOString().slice(12, 22)
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${playRes.width}`,
    `PlayResY: ${playRes.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Noto Sans CJK TC,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(playRes.height / 300))},0,2,20,20,${Math.round(playRes.height / 6)},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    `Dialogue: 0,0:00:00.00,${end},Default,,0,0,0,,${text}`,
    '',
  ].join('\n')
}
