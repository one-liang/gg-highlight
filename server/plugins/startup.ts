// Startup: listen address defaults, open the database, put interrupted work back in the queues,
// tidy leftover YouTube downloads, start the queues, tidy old uploads. Never runs yt-dlp (start.mjs
// installs and updates it before the server starts).
import { applyListenDefaults } from '../lib/config'
import { cleanupOrphanDownloads, cleanupOrphanUploads } from '../lib/library'
import { resetServices, useServices } from '../lib/services'

const ORPHAN_UPLOAD_AGE_MS = 24 * 60 * 60 * 1000

function openServices() {
  try {
    return useServices()
  }
  catch (err) {
    console.error(`[gg-highlight] 無法開啟資料庫：${(err as Error).message}`)
    throw err
  }
}

// Nitro calls plugins synchronously (a returned promise is not awaited), so the async part is chained below.
export default defineNitroPlugin((nitroApp) => {
  // 127.0.0.1:3939 unless HOST / PORT are set. Nitro's node server reads them right after the
  // plugins have run (plugins run synchronously when the app is created, before it listens).
  applyListenDefaults(process.env)

  // Nothing heavy while Nuxt prerenders or prepares the build.
  if (import.meta.prerender) return

  const services = openServices()

  nitroApp.hooks.hook('close', async () => {
    await resetServices()
  })

  const start = async () => {
    const analyses = await services.analysis.recover()
    const clips = await services.exports.recover()
    if (analyses.length > 0) console.log(`[gg-highlight] 重新排隊 ${analyses.length} 個中斷的分析`)
    if (clips.length > 0) console.log(`[gg-highlight] 重新排隊 ${clips.length} 個中斷的輸出`)

    // Before the Analysis queue starts: no download can be writing yet, so every <videoId>.* whose id
    // is not in the Library is a leftover (e.g. of a removal that could not delete a file in use).
    try {
      const orphans = await cleanupOrphanDownloads(services.config, services.repos.videos.list().map(v => v.id))
      if (orphans > 0) console.log(`[gg-highlight] 清掉 ${orphans} 個不屬於任何影片的下載檔`)
    }
    catch (err) {
      console.warn(`[gg-highlight] 清理下載資料夾失敗：${(err as Error).message}`)
    }

    services.analysis.start()
    services.exports.start()

    const referenced = new Set(services.repos.videos.list().map(v => v.filePath).filter((p): p is string => p !== null))
    const removed = await cleanupOrphanUploads(services.config, referenced, ORPHAN_UPLOAD_AGE_MS)
    if (removed > 0) console.log(`[gg-highlight] 清掉 ${removed} 個沒有加入影片庫的上傳檔`)
  }
  start().catch((err) => {
    console.error(`[gg-highlight] 啟動背景工作失敗：${(err as Error)?.stack ?? String(err)}`)
  })
})
