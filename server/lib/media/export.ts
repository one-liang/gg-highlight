// Clip export: Layout filtergraph, optional burned-in ASS subtitles, h264 + AAC mp4.
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Layout, MediaInfo } from '../../../shared/types/domain'
import { escapeFilterPath } from './escape'
import { writeAtomically } from './files'
import { fitShortSide } from './preview'
import { runFfmpeg } from './process'
import type { ExportJob, MediaTools, RunOptions } from './types'

const VERTICAL = { width: 1080, height: 1920 }
const ORIGINAL_MAX_SHORT_SIDE = 1080

export function outputSizeFor(layout: Layout, media: MediaInfo): { width: number, height: number } {
  if (layout !== 'original') return { ...VERTICAL }
  return fitShortSide(media.width, media.height, ORIGINAL_MAX_SHORT_SIDE)
}

/** Seconds as a plain decimal string with millisecond precision ("12.5", never "1e-7"). */
export function formatSeconds(value: number): string {
  return String(Number(Math.max(0, value).toFixed(3)))
}

/** Video part of the filtergraph for a Layout; input [0:v:0], unlabelled output. */
function layoutChain(layout: Layout, media: MediaInfo): string {
  const { width: W, height: H } = VERTICAL
  switch (layout) {
    case 'blurred-background':
      // Blur a small copy (cheap), blow it up as the backdrop, fit the full frame on top.
      return '[0:v:0]split=2[bgsrc][fgsrc];'
        + '[bgsrc]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,gblur=sigma=12,'
        + `scale=${W}:${H}[bg];`
        + `[fgsrc]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2[fg];`
        + '[bg][fg]overlay=(W-w)/2:(H-h)/2'
    case 'center-crop':
      // Largest centred 9:16 area with even sides (crop centres by default), then scale.
      return '[0:v:0]crop=w=trunc(min(iw\\,ih*9/16)/2)*2:h=trunc(min(ih\\,iw*16/9)/2)*2,'
        + `scale=${W}:${H}`
    case 'original': {
      const size = outputSizeFor('original', media)
      return `[0:v:0]scale=${size.width}:${size.height}`
    }
    default:
      throw new Error(`不支援的版型：${String(layout)}`)
  }
}

/** Full -filter_complex graph producing [v]. ASS times are relative to the clip start (input seeking resets pts to 0). */
export function buildFilterGraph(job: Pick<ExportJob, 'layout' | 'media' | 'assPath' | 'fontsDir'>): string {
  let graph = `${layoutChain(job.layout, job.media)},setsar=1`
  if (job.assPath) {
    graph += `,subtitles=filename=${escapeFilterPath(job.assPath)}:fontsdir=${escapeFilterPath(job.fontsDir)}`
  }
  return `${graph}[v]`
}

function videoEncoderArgs(encoder: ExportJob['encoder']): string[] {
  if (encoder === 'h264_nvenc') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '21', '-b:v', '0', '-profile:v', 'high']
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high']
}

/** Full ffmpeg argv (without the binary) for one Clip export. Audio = track 0 when present. */
export function buildExportArgs(job: ExportJob): string[] {
  if (!(Number.isFinite(job.start) && Number.isFinite(job.end) && job.start >= 0 && job.end > job.start)) {
    throw new Error('剪輯的起訖時間不正確')
  }
  return [
    '-ss', formatSeconds(job.start),
    '-i', job.input,
    '-t', formatSeconds(job.end - job.start),
    '-filter_complex', buildFilterGraph(job),
    '-map', '[v]',
    '-map', '0:a:0?',
    ...videoEncoderArgs(job.encoder),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-movflags', '+faststart',
    '-sn', '-dn',
    '-f', 'mp4',
    job.output,
  ]
}

export async function exportClip(tools: MediaTools, job: ExportJob, opts: RunOptions = {}): Promise<void> {
  // Absolute paths: ffmpeg runs with cwd = the ASS folder.
  const assPath = job.assPath ? path.resolve(job.assPath) : null
  const resolved: ExportJob = {
    ...job,
    input: path.resolve(job.input),
    assPath,
    fontsDir: path.resolve(job.fontsDir),
    output: path.resolve(job.output),
  }
  // Fail early with a readable message instead of an ffmpeg stderr dump.
  await fs.access(resolved.input).catch(() => {
    throw new Error('找不到原始影片檔')
  })
  if (assPath) {
    await fs.access(assPath).catch(() => {
      throw new Error('找不到字幕檔')
    })
  }
  await writeAtomically(resolved.output, tmp => runFfmpeg(tools, buildExportArgs({ ...resolved, output: tmp }), {
    ...opts,
    cwd: assPath ? path.dirname(assPath) : opts.cwd,
    durationSec: job.end - job.start,
  }))
}

/** True when fontsDir holds at least one .otf/.ttf/.ttc file. */
export async function fontsReady(fontsDir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(fontsDir, { withFileTypes: true })
    return entries.some(e => (e.isFile() || e.isSymbolicLink()) && /\.(?:otf|ttf|ttc)$/i.test(e.name))
  }
  catch {
    return false
  }
}
