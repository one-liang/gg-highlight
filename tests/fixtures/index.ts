// Typed access to the generated media fixtures (see make-fixtures.mjs).
import { makeFixtures as make } from './make-fixtures.mjs'

export interface Fixtures {
  dir: string
  speechEn: string
  speechZh: string
  /** 1280x720 h264 + two aac tracks: 0 = speech + tone, 1 = speech only. */
  sampleEnMkv: string
  sampleZhMkv: string
  /** 60 s, one audio track: Chinese speech at 0–17 s, quiet game audio, a loud burst at 40–46 s. */
  highlightsZhMkv: string
  /** sample-en.mkv remuxed to mp4 with only audio track 0. */
  sampleEnMp4: string
  noAudioMp4: string
  /** 720x1280 portrait source. */
  verticalMp4: string
  /** False when espeak-ng is missing and the "speech" is only a tone. */
  hasSpeech: boolean
}

export function fixtures(): Fixtures {
  return make() as Fixtures
}
