import { describe, expect, it } from 'vitest'
import { clipFileUrl, clipSrtUrl, videoMediaUrl } from './api-urls'

describe('api urls', () => {
  it('builds file endpoints', () => {
    expect(videoMediaUrl('v1')).toBe('/api/videos/v1/media')
    expect(clipFileUrl('c1')).toBe('/api/clips/c1/file')
    expect(clipFileUrl('c1', true)).toBe('/api/clips/c1/file?download=1')
    expect(clipSrtUrl('c1')).toBe('/api/clips/c1/srt')
  })

  it('encodes ids', () => {
    expect(videoMediaUrl('a/b')).toBe('/api/videos/a%2Fb/media')
  })
})
