// ffmpeg/ffprobe wrappers: probing, audio extraction, browser preview and clip export.
export type { ExportJob, MediaTools, RunOptions, VideoEncoder } from './types'

/** runFfmpeg: rejects with an Error carrying the stderr tail; rejects with AbortError on abort. */
export { MediaToolError, abortError, isAbortError, runFfmpeg } from './process'

export { probeMedia, parseProbeOutput } from './probe'

/** extractAudio: one audio track as 16 kHz mono 16-bit WAV for ASR. */
export { extractAudio } from './audio'

/**
 * previewPlan: 'original' when the container is mp4/mov with h264/av1/vp9 video and aac/mp3/opus
 * (or no) first audio track; 'remux' when only the container (or audio codec) is the problem;
 * 'transcode' otherwise. preparePreview makes the mp4 (video + audio track 0) or returns null.
 */
export { preparePreview, previewPlan, previewSize } from './preview'

/**
 * detectVideoEncoder: h264_nvenc when a tiny test encode succeeds, else libx264. Cached per ffmpeg path.
 * withEncoderFallback: redoes a failed h264_nvenc encode once with libx264 (exportClip / preparePreview use it).
 */
export { clearVideoEncoderCache, detectVideoEncoder, encoderFallbackMessage, withEncoderFallback } from './encoder'
export type { EncoderFallbackOptions } from './encoder'

export { escapeFilterPath, escapeFilterValue } from './escape'

export { buildExportArgs, buildFilterGraph, exportClip, fontsReady, outputSizeFor } from './export'
