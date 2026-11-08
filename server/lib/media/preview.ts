// Browser preview: play the original when possible, else remux to mp4, else transcode to ≤720p h264.
import path from 'node:path'
import type { MediaInfo } from '../../../shared/types/domain'
import { detectVideoEncoder } from './encoder'
import { writeAtomically } from './files'
import { runFfmpeg } from './process'
import type { MediaTools, RunOptions, VideoEncoder } from './types'

export type PreviewPlan = 'original' | 'remux' | 'transcode'

const BROWSER_VIDEO = new Set(['h264', 'av1', 'vp9'])
const BROWSER_AUDIO = new Set(['aac', 'mp3', 'opus'])
const PREVIEW_MAX_SHORT_SIDE = 720

function isMp4Family(container: string): boolean {
  return container.split(',').some(name => name.trim() === 'mp4' || name.trim() === 'mov')
}

export function previewPlan(media: MediaInfo): PreviewPlan {
  if (!BROWSER_VIDEO.has(media.videoCodec)) return 'transcode'
  const audio = media.audioTracks[0]
  const audioOk = !audio || BROWSER_AUDIO.has(audio.codec)
  return isMp4Family(media.container) && audioOk ? 'original' : 'remux'
}

/** Rounds to an even number ≥ 2, preferring the smaller one for odd integers (never upscales by a pixel). */
export function evenDim(value: number): number {
  const v = Number.isFinite(value) ? value : 0
  const rounded = Number.isInteger(v) && v % 2 === 1 ? v - 1 : Math.round(v / 2) * 2
  return Math.max(2, rounded)
}

/** Scales so the shorter side is at most `maxShort`, keeping aspect ratio; both sides even. */
export function fitShortSide(width: number, height: number, maxShort: number): { width: number, height: number } {
  const short = Math.min(width, height)
  const factor = short > maxShort ? maxShort / short : 1
  return { width: evenDim(width * factor), height: evenDim(height * factor) }
}

/** Transcoded preview size: the shorter side capped at 720 (so vertical sources stay sharp too). */
export function previewSize(media: MediaInfo): { width: number, height: number } {
  return fitShortSide(media.width, media.height, PREVIEW_MAX_SHORT_SIDE)
}

/** ffmpeg args for the preview, without the output path. */
export function previewArgs(filePath: string, media: MediaInfo, plan: Exclude<PreviewPlan, 'original'>, encoder: VideoEncoder): string[] {
  const args = ['-i', filePath, '-map', '0:v:0', '-map', '0:a:0?']
  if (plan === 'remux') {
    const audio = media.audioTracks[0]
    args.push('-c:v', 'copy')
    if (!audio || BROWSER_AUDIO.has(audio.codec)) args.push('-c:a', 'copy')
    else args.push('-c:a', 'aac', '-b:a', '160k')
  }
  else {
    const { width, height } = previewSize(media)
    args.push('-vf', `scale=${width}:${height},setsar=1`)
    if (encoder === 'h264_nvenc') args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '26', '-b:v', '0')
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23')
    args.push('-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k')
  }
  args.push('-sn', '-dn', '-movflags', '+faststart', '-f', 'mp4')
  return args
}

export async function preparePreview(
  tools: MediaTools,
  input: { filePath: string, media: MediaInfo },
  outPath: string,
  opts: RunOptions & { encoder?: VideoEncoder } = {},
): Promise<{ previewPath: string | null }> {
  const plan = previewPlan(input.media)
  if (plan === 'original') return { previewPath: null }
  const { encoder: requested, ...runOpts } = opts
  const encoder = plan === 'transcode' ? requested ?? await detectVideoEncoder(tools) : 'libx264'
  const args = previewArgs(path.resolve(input.filePath), input.media, plan, encoder)
  await writeAtomically(path.resolve(outPath), tmp => runFfmpeg(tools, [...args, tmp], {
    ...runOpts,
    durationSec: input.media.durationSec,
  }))
  return { previewPath: outPath }
}
