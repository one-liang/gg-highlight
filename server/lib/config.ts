import path from 'node:path'
import type { Language } from '../../shared/types/domain'
import { DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_URL, type OllamaConfig } from './llm/types'

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
  /** Local LLM for the transcript Signal; url null = GG_OLLAMA_URL=off. */
  ollama: OllamaConfig
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

/**
 * GG_OLLAMA_URL / GG_OLLAMA_MODEL (same rules as scripts/doctor.mjs ollamaConfig): unset or blank
 * → the default URL; 'off' in any letter case → disabled (url null); trailing slashes removed.
 * A blank model → the default model.
 */
export function parseOllamaConfig(env: NodeJS.ProcessEnv): OllamaConfig {
  const rawUrl = (env.GG_OLLAMA_URL ?? '').trim()
  const url = rawUrl.toLowerCase() === 'off' ? null : (rawUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, '')
  const model = (env.GG_OLLAMA_MODEL ?? '').trim() || DEFAULT_OLLAMA_MODEL
  return { url, model }
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
    ollama: parseOllamaConfig(env),
  }
}

/** Where the server listens unless HOST / PORT say otherwise: this computer only (design.md). */
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 3939

/**
 * Fills in HOST / PORT when neither they nor NITRO_HOST / NITRO_PORT are set, so the built server
 * never falls back to Nitro's own defaults (all interfaces, port 3000), e.g. when started with
 * `node .output/server/index.mjs` as the build output suggests. Explicit values always win.
 */
export function applyListenDefaults(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.NITRO_HOST && !env.HOST) env.HOST = DEFAULT_HOST
  if (!env.NITRO_PORT && !env.PORT) env.PORT = String(DEFAULT_PORT)
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
