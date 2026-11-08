// ffprobe → MediaInfo.
import path from 'node:path'
import type { AudioTrack, MediaInfo } from '../../../shared/types/domain'
import { MediaToolError, runTool } from './process'
import type { MediaTools } from './types'

interface ProbeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  duration?: string
  channels?: number
  tags?: Record<string, string>
  side_data_list?: Array<{ rotation?: number | string }>
  disposition?: Record<string, number>
}

export interface ProbeOutput {
  streams?: ProbeStream[]
  format?: { format_name?: string, duration?: string }
}

/** "30000/1001" → 29.97; null when missing, 0/0 or invalid. */
export function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null
  const [num, den = '1'] = value.split('/')
  const n = Number(num)
  const d = Number(den)
  if (!Number.isFinite(n) || !Number.isFinite(d) || n <= 0 || d <= 0) return null
  return Math.round((n / d) * 1000) / 1000
}

function positive(value: string | number | undefined): number | null {
  const n = typeof value === 'number' ? value : Number.parseFloat(value ?? '')
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Matroska stores per-stream durations as a "HH:MM:SS.nnnnnnnnn" tag. */
function parseClock(value: string | undefined): number | null {
  const m = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(value?.trim() ?? '')
  if (!m) return null
  return positive(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]))
}

function tag(tags: Record<string, string> | undefined, name: string): string | null {
  if (!tags) return null
  for (const [key, value] of Object.entries(tags)) {
    if (key.toLowerCase() === name && typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function rotationOf(stream: ProbeStream): number {
  for (const side of stream.side_data_list ?? []) {
    if (side.rotation !== undefined) {
      const r = Number(side.rotation)
      if (Number.isFinite(r)) return r
    }
  }
  const r = Number(tag(stream.tags, 'rotate'))
  return Number.isFinite(r) ? r : 0
}

const NO_VIDEO = '無法讀取影片：找不到影像軌'

/** Pure part of probeMedia, exported for tests. */
export function parseProbeOutput(data: ProbeOutput): MediaInfo {
  const streams = data.streams ?? []
  // Cover art in audio files shows up as an "attached picture" video stream; it is not a video.
  const video = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic)
  if (!video) throw new Error(NO_VIDEO)

  let width = video.width ?? 0
  let height = video.height ?? 0
  const rotation = ((Math.round(rotationOf(video)) % 360) + 360) % 360
  if (rotation === 90 || rotation === 270) [width, height] = [height, width]

  const fps = parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate) ?? 30

  const durationSec = positive(data.format?.duration)
    ?? positive(video.duration)
    ?? parseClock(tag(video.tags, 'duration') ?? undefined)
    ?? 0

  const audioTracks: AudioTrack[] = streams
    .filter(s => s.codec_type === 'audio')
    .map((s, index) => {
      const language = tag(s.tags, 'language')
      return {
        index,
        codec: s.codec_name ?? 'unknown',
        channels: s.channels ?? 0,
        language: language && language.toLowerCase() !== 'und' ? language : null,
        title: tag(s.tags, 'title'),
      }
    })

  return {
    durationSec,
    width,
    height,
    fps,
    videoCodec: video.codec_name ?? 'unknown',
    container: data.format?.format_name ?? '',
    audioTracks,
  }
}

/** Last stderr line without ffprobe's "<input path>: " prefix (the path is noise, and for uploads an internal one). */
function probeErrorDetail(err: unknown, inputPath: string): string {
  const detail = err instanceof MediaToolError ? err.stderr.split(/\r?\n/).filter(Boolean).pop() ?? '' : (err as Error).message
  const prefix = `${inputPath}: `
  return (detail.startsWith(prefix) ? detail.slice(prefix.length) : detail).trim()
}

async function ffprobeJson(tools: MediaTools, inputPath: string, args: string[]): Promise<ProbeOutput> {
  let stdout: string
  try {
    stdout = await runTool(tools.ffprobePath, ['-v', 'error', '-print_format', 'json', ...args, '-i', inputPath], { collectStdout: true })
  }
  catch (err) {
    throw new Error(`無法讀取影片：${probeErrorDetail(err, inputPath) || '未知錯誤'}`)
  }
  try {
    return JSON.parse(stdout) as ProbeOutput
  }
  catch {
    throw new Error('無法讀取影片：ffprobe 輸出格式不正確')
  }
}

export async function probeMedia(tools: MediaTools, filePath: string): Promise<MediaInfo> {
  const data = await ffprobeJson(tools, path.resolve(filePath), ['-show_format', '-show_streams'])
  return parseProbeOutput(data)
}

/** Number of audio streams, without requiring a video stream. */
export async function countAudioTracks(tools: MediaTools, filePath: string): Promise<number> {
  const data = await ffprobeJson(tools, path.resolve(filePath), ['-select_streams', 'a', '-show_entries', 'stream=index'])
  return data.streams?.length ?? 0
}
