import type { AnalysisMode, ReanalyzeBody, SourceVideo } from '../../shared/types/domain'
import { reanalyzeStartedNotice } from '../utils/analysis'

/** POST /api/videos/:id/reanalyze with toasts; `start` resolves to the queued video, or null on failure. */
export function useReanalyze() {
  const notify = useNotify()
  const pending = ref<AnalysisMode | null>(null)

  async function start(videoId: string, mode: AnalysisMode): Promise<SourceVideo | null> {
    if (pending.value) return null
    pending.value = mode
    try {
      const body: ReanalyzeBody = { mode }
      const video = await apiFetch<SourceVideo>(`/api/videos/${encodeURIComponent(videoId)}/reanalyze`, { method: 'POST', body })
      const notice = reanalyzeStartedNotice(mode)
      notify.success(notice.title, notice.description)
      return video
    }
    catch (err) {
      notify.error(err, mode === 'highlights' ? '無法開始找精華片段' : '無法重新分析')
      return null
    }
    finally {
      pending.value = null
    }
  }

  return { pending, start }
}
