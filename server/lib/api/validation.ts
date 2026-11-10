// Request validation (zod) with Chinese messages. Every failure becomes a 400.
import { z } from 'zod'
import type {
  AddVideoBody, CreateClipBody, CreateHighlightBody, ReanalyzeBody, Settings, UpdateHighlightBody, UpdateSegmentBody,
  YoutubeProbeBody,
} from '../../../shared/types/domain'
import { badRequest } from './errors'

const NOT_OBJECT = '請求內容必須是 JSON 物件'
export const MAX_SEGMENT_TEXT_CHARS = 200

const seconds = (label: string) => z.number({ error: `${label}必須是數字（秒）` })

export const YOUTUBE_URL_REQUIRED_MESSAGE = '請貼上 YouTube 影片連結'
export const YOUTUBE_AUDIO_TRACK_MESSAGE = 'YouTube 影片只有一條音軌，音軌必須是 0'

/**
 * POST /api/videos. YouTube needs youtubeUrl and audio track 0 (the download has one audio track);
 * the link itself is parsed by the route (400 / 422 by kind).
 */
export const addVideoSchema = z.object({
  sourceKind: z.enum(['watch-folder', 'upload', 'youtube'], { error: '來源必須是 watch-folder、upload 或 youtube' }),
  filePath: z.string({ error: '影片路徑必須是文字' }).optional(),
  uploadId: z.string({ error: '上傳編號必須是文字' }).optional(),
  youtubeUrl: z.string({ error: 'YouTube 連結必須是文字' }).optional(),
  language: z.enum(['zh', 'en'], { error: '語言必須是 zh（中文）或 en（英文）' }),
  audioTrack: z.number({ error: '音軌必須是數字' }).int('音軌必須是整數').min(0, '音軌不能小於 0').max(255, '音軌編號太大').default(0),
}, { error: NOT_OBJECT }).superRefine((body, ctx) => {
  if (body.sourceKind !== 'youtube') return
  if (!body.youtubeUrl?.trim()) ctx.addIssue({ code: 'custom', path: ['youtubeUrl'], message: YOUTUBE_URL_REQUIRED_MESSAGE })
  else if (body.audioTrack !== 0) ctx.addIssue({ code: 'custom', path: ['audioTrack'], message: YOUTUBE_AUDIO_TRACK_MESSAGE })
}) satisfies z.ZodType<AddVideoBody, unknown>

/** POST /api/youtube/probe; the link is parsed by the route (400 / 422 by kind). */
export const youtubeProbeSchema = z.object({
  url: z.string({ error: YOUTUBE_URL_REQUIRED_MESSAGE }).trim().min(1, YOUTUBE_URL_REQUIRED_MESSAGE),
}, { error: NOT_OBJECT }) satisfies z.ZodType<YoutubeProbeBody, unknown>

export const createHighlightSchema = z.object({
  start: seconds('起點'),
  end: seconds('終點'),
}, { error: NOT_OBJECT }) satisfies z.ZodType<CreateHighlightBody, unknown>

export const updateHighlightSchema = z.object({
  start: seconds('起點').optional(),
  end: seconds('終點').optional(),
  status: z.enum(['candidate', 'selected', 'dismissed'], { error: '狀態必須是 candidate、selected 或 dismissed' }).optional(),
}, { error: NOT_OBJECT })
  .refine(body => body.start !== undefined || body.end !== undefined || body.status !== undefined, { error: '沒有要修改的內容' }) satisfies z.ZodType<UpdateHighlightBody, unknown>

export const createClipSchema = z.object({
  layout: z.enum(['blurred-background', 'center-crop', 'original'], { error: '版型必須是模糊背景、置中裁切或原比例其中之一' }),
  burnSubtitles: z.boolean({ error: '是否燒錄字幕必須是 true 或 false' }).default(true),
}, { error: NOT_OBJECT }) satisfies z.ZodType<CreateClipBody, unknown>

export const updateSegmentSchema = z.object({
  text: z.string({ error: '字幕文字必須是文字' })
    .transform(text => text.trim())
    .refine(text => text.length > 0, { error: '字幕文字不能是空的' })
    .refine(text => [...text].length <= MAX_SEGMENT_TEXT_CHARS, { error: `字幕文字最多 ${MAX_SEGMENT_TEXT_CHARS} 字` }),
}, { error: NOT_OBJECT }) satisfies z.ZodType<UpdateSegmentBody, unknown>

export const settingsSchema = z.object({
  watchFolders: z.array(z.string({ error: '資料夾路徑必須是文字' }), { error: '影片資料夾必須是清單' }).max(50, '影片資料夾最多 50 個'),
}, { error: NOT_OBJECT }) satisfies z.ZodType<Settings, unknown>

export const reanalyzeSchema = z.object({
  mode: z.enum(['full', 'highlights'], { error: '重新分析的方式必須是 full（重新辨識語音並找精華）或 highlights（只重新找精華片段）' }),
}, { error: NOT_OBJECT }) satisfies z.ZodType<ReanalyzeBody, unknown>

export const probeSchema = z.object({
  filePath: z.string({ error: '請提供影片路徑' }).min(1, '請提供影片路徑'),
}, { error: NOT_OBJECT })

/** Parses or throws a 400 with the first problem as the message. */
export function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  throw badRequest(result.error.issues[0]?.message ?? '請求內容不正確')
}

/** A non-negative integer route parameter (e.g. a transcript segment idx). */
export function parseIndexParam(value: string | undefined, label: string): number {
  if (value === undefined || !/^\d{1,9}$/.test(value)) throw badRequest(`${label}必須是 0 以上的整數`)
  return Number(value)
}

export function requireParam(value: string | undefined, label: string): string {
  if (!value) throw badRequest(`缺少${label}`)
  return value
}
