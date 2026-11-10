import { describe, expect, it } from 'vitest'
import { rawTranscriptSchema } from './schema'

const word = { start: 1, end: 1.2, word: '快', probability: 0.9 }
const transcript = (segment: Record<string, unknown>) => ({ language: 'zh', durationSec: 10, model: 'm', device: 'cuda', segments: [segment] })

describe('rawTranscriptSchema', () => {
  it('accepts segments written before the confidence fields existed', () => {
    const old = { start: 1, end: 1.2, text: '快', words: [word] }
    const parsed = rawTranscriptSchema.parse(transcript(old))
    expect(parsed.segments[0]).toEqual(old)
  })

  it('keeps the segment confidence fields', () => {
    const segment = { start: 1, end: 1.2, text: '快', words: [word], avgLogprob: -0.25, noSpeechProb: 0.1, compressionRatio: 2.6 }
    expect(rawTranscriptSchema.parse(transcript(segment)).segments[0]).toEqual(segment)
  })

  it('rejects confidence fields that are not numbers', () => {
    const segment = { start: 1, end: 1.2, text: '快', words: [word], noSpeechProb: '0.1' }
    const result = rawTranscriptSchema.safeParse(transcript(segment))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['segments', 0, 'noSpeechProb'])
  })
})
