import { describe, expect, it } from 'vitest'
import { createMetadataCache, METADATA_CACHE_TTL_MS } from './cache'
import type { YoutubeMetadata } from './types'

function meta(id: string, title = id): YoutubeMetadata {
  return {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title,
    channel: null,
    durationSec: 60,
    liveStatus: 'was_live',
    uploadDate: null,
    chatAvailable: true,
    heatmapAvailable: false,
    heatmap: null,
    languageHint: null,
    fetchedAt: '2026-11-09T00:00:00.000Z',
  }
}

describe('createMetadataCache', () => {
  it('keeps a read for 30 minutes by default', () => {
    let t = 1_000_000
    const cache = createMetadataCache(undefined, () => t)
    expect(METADATA_CACHE_TTL_MS).toBe(30 * 60_000)
    expect(cache.get('ggVodChat01')).toBeNull()
    cache.set(meta('ggVodChat01'))
    t += METADATA_CACHE_TTL_MS - 1
    expect(cache.get('ggVodChat01')?.id).toBe('ggVodChat01')
    t += 1
    expect(cache.get('ggVodChat01')).toBeNull()
  })

  it('replacing an entry restarts its ttl', () => {
    let t = 0
    const cache = createMetadataCache(100, () => t)
    cache.set(meta('a', 'old'))
    t = 80
    cache.set(meta('a', 'new'))
    t = 150
    expect(cache.get('a')?.title).toBe('new')
    t = 181
    expect(cache.get('a')).toBeNull()
  })

  it('entries are independent; expired ones are dropped on the next set', () => {
    let t = 0
    const cache = createMetadataCache(100, () => t)
    cache.set(meta('a'))
    t = 50
    cache.set(meta('b'))
    t = 120
    expect(cache.get('a')).toBeNull()
    expect(cache.get('b')?.id).toBe('b')
    cache.set(meta('c'))
    expect(cache.get('c')?.id).toBe('c')
  })
})
