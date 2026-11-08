<script setup lang="ts">
import type { SourceVideo } from '~~/shared/types/domain'
import { formatFps, formatResolution } from '~/utils/format'
import { isAnalysisActive, languageLabels } from '~/utils/labels'
import { formatDuration } from '~/utils/time'

const route = useRoute()
const notify = useNotify()

const id = computed(() => String(route.params.id ?? ''))
const { data: video, error, loaded, loading, refresh, set } = useApiData<SourceVideo>(
  () => (id.value ? `/api/videos/${encodeURIComponent(id.value)}` : null),
  '讀取影片失敗',
)

usePolling(refresh, () => !!video.value && isAnalysisActive(video.value))

// tell the user when the analysis they are watching finishes
watch(() => video.value?.analysis.status, (now, before) => {
  if (before !== 'queued' && before !== 'running') return
  if (now === 'done') notify.success('分析完成', '可以開始修改逐字稿、標出精華片段了。')
  else if (now === 'failed') notify.message('分析失敗', video.value?.analysis.error ?? undefined)
})
useHead({ title: () => video.value?.title ?? '影片' })

const retrying = ref(false)
async function retry() {
  if (!video.value) return
  retrying.value = true
  try {
    set(await apiFetch<SourceVideo>(`/api/videos/${encodeURIComponent(video.value.id)}/retry`, { method: 'POST' }))
    notify.success('已重新排隊分析')
  }
  catch (err) {
    notify.error(err, '無法重試分析')
  }
  finally {
    retrying.value = false
  }
}

const deleteOpen = ref(false)
function onDeleted() {
  void navigateTo('/')
}
</script>

<template>
  <div class="mx-auto w-full max-w-[1600px] px-4 py-4 sm:px-6 sm:py-5">
    <UButton to="/" label="影片庫" icon="i-lucide-arrow-left" color="neutral" variant="link" size="sm" class="-ml-2.5 mb-2" />

    <div v-if="!loaded" class="space-y-4">
      <USkeleton class="h-8 w-2/3 max-w-xl" />
      <USkeleton class="h-4 w-1/2 max-w-md" />
      <USkeleton class="aspect-video w-full max-w-4xl rounded-lg" />
    </div>

    <UEmpty
      v-else-if="!video && error?.status === 404"
      icon="i-lucide-file-question"
      title="找不到這支影片"
      description="它可能已經從影片庫移除了。"
      variant="subtle"
      class="py-16"
      :actions="[{ label: '回到影片庫', icon: 'i-lucide-library', to: '/' }]"
    />

    <UAlert
      v-else-if="!video"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="無法讀取這支影片"
      :description="error?.message ?? '發生未知錯誤'"
      :actions="[{ label: '重試', icon: 'i-lucide-refresh-cw', color: 'error', variant: 'outline', loading, onClick: refresh }]"
    />

    <template v-else>
      <header class="mb-5 flex flex-wrap items-start gap-3">
        <div class="min-w-0 flex-1">
          <h1 class="text-xl font-semibold break-all text-highlighted sm:text-2xl">
            {{ video.title }}
          </h1>
          <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted">
            <AnalysisStatusBadge :analysis="video.analysis" />
            <SourceKindBadge :kind="video.sourceKind" />
            <span v-if="video.media" class="tabular-nums">{{ formatDuration(video.media.durationSec) }}</span>
            <span v-if="video.media" class="tabular-nums">
              {{ formatResolution(video.media.width, video.media.height) }}<template v-if="formatFps(video.media.fps)">・{{ formatFps(video.media.fps) }}</template>
            </span>
            <span>{{ languageLabels[video.language] }}</span>
            <span v-if="video.media && video.media.audioTracks.length > 1">分析用音軌 {{ video.audioTrack + 1 }}</span>
          </div>
        </div>
        <UButton label="移除" icon="i-lucide-trash-2" color="neutral" variant="ghost" @click="deleteOpen = true" />
      </header>

      <UAlert
        v-if="error"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :description="`無法更新狀態：${error.message}`"
        class="mb-5"
      />

      <UAlert
        v-if="video.fileMissing"
        color="warning"
        variant="subtle"
        icon="i-lucide-file-warning"
        title="找不到原始影片檔"
        class="mb-5"
      >
        <template #description>
          <p v-if="video.analysis.status === 'done'">
            原本的檔案可能被移動、改名或刪除，因此無法預覽，也無法輸出剪輯。逐字稿與精華片段仍然可以查看與修改。
          </p>
          <p v-else>
            原本的檔案可能被移動、改名或刪除，因此無法分析、預覽或輸出剪輯。
          </p>
          <p v-if="video.filePath" class="mt-1">
            原本的位置：<code class="break-all font-mono text-xs">{{ video.filePath }}</code>
          </p>
          <p class="mt-1">
            {{ video.analysis.status === 'failed' ? '把檔案放回原位置後，按下方的「重試」重新分析。' : '把檔案放回原位置後重新整理這一頁即可恢復。' }}
          </p>
        </template>
      </UAlert>

      <AnalysisProgressCard v-if="isAnalysisActive(video)" :video="video" class="max-w-4xl" />

      <UAlert
        v-else-if="video.analysis.status === 'failed'"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-x"
        title="分析失敗"
        :description="video.analysis.error || '發生未知錯誤。'"
        class="max-w-4xl"
        :actions="[{ label: '重試', icon: 'i-lucide-rotate-ccw', color: 'error', loading: retrying, onClick: retry }]"
      />

      <VideoWorkspace v-else-if="video.analysis.status === 'done'" :key="video.id" :video="video" />
    </template>

    <DeleteVideoModal v-model:open="deleteOpen" :video="video" @deleted="onDeleted" />
  </div>
</template>
