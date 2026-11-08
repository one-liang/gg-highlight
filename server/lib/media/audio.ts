// One audio track → 16 kHz mono 16-bit WAV for ASR.
import path from 'node:path'
import { writeAtomically } from './files'
import { countAudioTracks } from './probe'
import { runFfmpeg } from './process'
import type { MediaTools, RunOptions } from './types'

export async function extractAudio(
  tools: MediaTools,
  input: { filePath: string, audioTrack: number, durationSec: number },
  outWav: string,
  opts: RunOptions = {},
): Promise<void> {
  const file = path.resolve(input.filePath)
  const track = input.audioTrack
  const count = await countAudioTracks(tools, file)
  if (count === 0) throw new Error('這支影片沒有音訊')
  if (!Number.isInteger(track) || track < 0 || track >= count) throw new Error(`找不到第 ${track + 1} 條音軌`)

  await writeAtomically(path.resolve(outWav), tmp => runFfmpeg(tools, [
    '-i', file,
    '-map', `0:a:${track}`,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    '-f', 'wav',
    tmp,
  ], { ...opts, durationSec: input.durationSec }))
}
