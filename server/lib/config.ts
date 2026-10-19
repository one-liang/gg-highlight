import path from 'node:path'
import type { Language } from '../../shared/types/domain'

export interface AppConfig {
  /** Project root; start.mjs and the dev server run with cwd set to it. */
  rootDir: string
  /** Holds the SQLite file, per-video work files, uploads, downloads and clips. */
  dataDir: string
  /** Folder with the subtitle font files (Noto Sans CJK TC), passed to libass as fontsdir. */
  fontsDir: string
  ffmpegPath: string
  ffprobePath: string
  /** argv prefix that runs the Python transcriber CLI (`gg-transcribe`). */
  transcriberCommand: string[]
  /** Hugging Face repo id (or local path) of the CTranslate2 model per Language. */
  asrModels: Record<Language, string>
  /** 'auto' picks CUDA when available. */
  asrDevice: 'auto' | 'cuda' | 'cpu'
  /** Forces a video encoder instead of probing for NVENC. */
  videoEncoderOverride: 'h264_nvenc' | 'libx264' | null
}

export const DEFAULT_ASR_MODELS: Record<Language, string> = {
  zh: 'SoybeanMilk/faster-whisper-Breeze-ASR-25',
  en: 'deepdml/faster-whisper-large-v3-turbo-ct2',
}

function parseCommand(value: string): string[] {
  const trimmed = value.trim()
  if (trimmed.startsWith('[')) return JSON.parse(trimmed) as string[]
  return trimmed.split(/\s+/)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AppConfig {
  const rootDir = path.resolve(env.GG_ROOT_DIR ?? cwd)
  const encoder = env.GG_VIDEO_ENCODER
  const device = env.GG_ASR_DEVICE
  return {
    rootDir,
    dataDir: path.resolve(rootDir, env.GG_DATA_DIR ?? 'data'),
    fontsDir: path.resolve(rootDir, env.GG_FONTS_DIR ?? 'fonts'),
    ffmpegPath: env.GG_FFMPEG ?? 'ffmpeg',
    ffprobePath: env.GG_FFPROBE ?? 'ffprobe',
    transcriberCommand: env.GG_TRANSCRIBER_CMD
      ? parseCommand(env.GG_TRANSCRIBER_CMD)
      : ['uv', 'run', '--project', path.join(rootDir, 'transcriber'), 'gg-transcribe'],
    asrModels: {
      zh: env.GG_ASR_MODEL_ZH ?? DEFAULT_ASR_MODELS.zh,
      en: env.GG_ASR_MODEL_EN ?? DEFAULT_ASR_MODELS.en,
    },
    asrDevice: device === 'cuda' || device === 'cpu' ? device : 'auto',
    videoEncoderOverride: encoder === 'h264_nvenc' || encoder === 'libx264' ? encoder : null,
  }
}

let cached: AppConfig | null = null

export function getConfig(): AppConfig {
  cached ??= loadConfig()
  return cached
}

/** Per-video work folder (audio, preview, raw transcript). */
export function videoWorkDir(config: AppConfig, videoId: string): string {
  return path.join(config.dataDir, 'videos', videoId)
}

export function clipsDir(config: AppConfig, videoId: string): string {
  return path.join(config.dataDir, 'clips', videoId)
}

export function uploadsDir(config: AppConfig): string {
  return path.join(config.dataDir, 'uploads')
}

/** True if `target` is `dir` itself or inside it (after resolving). */
export function isInside(dir: string, target: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(target))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
