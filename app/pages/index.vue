<script setup lang="ts">
import type { SourceVideo } from '~~/shared/types/domain'
import { isAnalysisActive } from '~/utils/labels'

useHead({ title: '影片庫' })

const { data, error, loaded, loading, refresh, set } = useApiData<SourceVideo[]>('/api/videos', '讀取影片庫失敗')

const videos = computed(() => (Array.isArray(data.value) ? data.value : []))
usePolling(refresh, () => videos.value.some(isAnalysisActive))

const addOpen = ref(false)
const deleteOpen = ref(false)
const deleting = shallowRef<SourceVideo | null>(null)

function askDelete(video: SourceVideo) {
  deleting.value = video
  deleteOpen.value = true
}

function onDeleted(id: string) {
  set(videos.value.filter(v => v.id !== id))
  void refresh()
}

function onAdded(video: SourceVideo) {
  set([video, ...videos.value.filter(v => v.id !== video.id)])
  void refresh()
}

const activeCount = computed(() => videos.value.filter(isAnalysisActive).length)
</script>

<template>
  <UContainer class="py-6 sm:py-8">
    <div class="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold text-highlighted">
          影片庫
        </h1>
        <p class="mt-1 text-sm text-muted">
          <template v-if="videos.length">
            共 {{ videos.length }} 支影片<template v-if="activeCount">，{{ activeCount }} 支正在分析或排隊</template>
          </template>
          <template v-else>
            加入影片後會在背景分析，產生可編輯的逐字稿。
          </template>
        </p>
      </div>
      <UButton label="加入影片" icon="i-lucide-plus" @click="addOpen = true" />
    </div>

    <div v-if="!loaded" class="space-y-3">
      <USkeleton v-for="i in 3" :key="i" class="h-[76px] w-full rounded-lg" />
    </div>

    <UAlert
      v-else-if="error && !videos.length"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="無法讀取影片庫"
      :description="error.message"
      :actions="[{ label: '重試', icon: 'i-lucide-refresh-cw', color: 'error', variant: 'outline', loading, onClick: refresh }]"
    />

    <UEmpty
      v-else-if="!videos.length"
      icon="i-lucide-film"
      title="影片庫還是空的"
      description="從影片資料夾挑選 OBS 錄影檔，或直接上傳影片。分析完成後就能修改逐字稿、標出精華片段並輸出帶字幕的剪輯。"
      variant="subtle"
      size="lg"
      :actions="[{ label: '加入影片', icon: 'i-lucide-plus', onClick: () => { addOpen = true } }]"
      class="py-16"
    />

    <template v-else>
      <UAlert
        v-if="error"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :description="`無法更新影片庫：${error.message}`"
        class="mb-4"
      />
      <ul class="space-y-2.5">
        <VideoListItem v-for="video in videos" :key="video.id" :video="video" @delete="askDelete" />
      </ul>
    </template>

    <AddVideoModal v-model:open="addOpen" @added="onAdded" />
    <DeleteVideoModal v-model:open="deleteOpen" :video="deleting" @deleted="onDeleted" />
  </UContainer>
</template>
