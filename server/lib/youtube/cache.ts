// In-memory cache of metadata reads by YouTube id (design.md「加入」: kept 30 minutes, so adding the video
// and its first download step do not ask YouTube again).
import type { YoutubeMetadata } from './types'

export const METADATA_CACHE_TTL_MS = 30 * 60_000

export interface MetadataCache {
  /** The metadata read less than ttl ago, else null. */
  get(youtubeId: string): YoutubeMetadata | null
  /** Stores (or replaces) the read under meta.id; the ttl starts now. */
  set(meta: YoutubeMetadata): void
}

export function createMetadataCache(ttlMs = METADATA_CACHE_TTL_MS, now: () => number = Date.now): MetadataCache {
  const entries = new Map<string, { meta: YoutubeMetadata, expiresAt: number }>()
  const prune = (t: number) => {
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= t) entries.delete(id)
    }
  }
  return {
    get(youtubeId) {
      const entry = entries.get(youtubeId)
      if (!entry) return null
      if (entry.expiresAt <= now()) {
        entries.delete(youtubeId)
        return null
      }
      return entry.meta
    },
    set(meta) {
      const t = now()
      prune(t)
      entries.set(meta.id, { meta, expiresAt: t + ttlMs })
    },
  }
}
