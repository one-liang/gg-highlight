<script setup lang="ts">
import type { SourceVideo } from '~~/shared/types/domain'
import { isAnalysisActive } from '~/utils/labels'

const props = defineProps<{ video: SourceVideo | null }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ deleted: [id: string] }>()

const notify = useNotify()
const deleting = ref(false)

async function confirmDelete() {
  const video = props.video
  if (!video) return
  deleting.value = true
  try {
    await apiFetch(`/api/videos/${encodeURIComponent(video.id)}`, { method: 'DELETE' })
    notify.success('已從影片庫移除', video.title)
    emit('deleted', video.id)
    open.value = false
  }
  catch (err) {
    notify.error(err, '移除失敗')
  }
  finally {
    deleting.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="從影片庫移除？"
    :dismissible="!deleting"
    :ui="{ footer: 'justify-end' }"
  >
    <template #body>
      <div v-if="video" class="space-y-4 text-sm">
        <p>
          確定要移除「<span class="font-medium break-all text-highlighted">{{ video.title }}</span>」嗎？這個動作無法復原。
        </p>
        <ul class="space-y-2.5">
          <li class="flex gap-2">
            <UIcon name="i-lucide-trash-2" class="mt-0.5 size-4 shrink-0 text-error" />
            <span>會一併刪除這支影片的逐字稿、所有精華片段，以及所有已輸出的剪輯（影片與字幕檔）。</span>
          </li>
          <li v-if="video.sourceKind === 'watch-folder'" class="flex gap-2">
            <UIcon name="i-lucide-shield-check" class="mt-0.5 size-4 shrink-0 text-success" />
            <span>
              影片資料夾裡的<strong class="text-highlighted">原始錄影檔不會被刪除</strong>，仍會留在
              <code v-if="video.filePath" class="break-all rounded bg-elevated px-1 py-0.5 font-mono text-xs">{{ video.filePath }}</code><template v-else>原本的位置</template>。
            </span>
          </li>
          <li v-else-if="video.sourceKind === 'upload'" class="flex gap-2">
            <UIcon name="i-lucide-file-x" class="mt-0.5 size-4 shrink-0 text-warning" />
            <span>上傳時存在 gg-highlight 資料夾裡的<strong class="text-highlighted">影片複本也會一起刪除</strong>；你電腦上原本的檔案不受影響。</span>
          </li>
          <li v-else class="flex gap-2">
            <UIcon name="i-lucide-file-x" class="mt-0.5 size-4 shrink-0 text-warning" />
            <span>從 YouTube 下載的影片檔也會一起刪除。</span>
          </li>
          <li v-if="isAnalysisActive(video)" class="flex gap-2">
            <UIcon name="i-lucide-circle-pause" class="mt-0.5 size-4 shrink-0 text-muted" />
            <span>正在進行的分析會先中止。</span>
          </li>
        </ul>
      </div>
    </template>

    <template #footer="{ close }">
      <UButton label="取消" color="neutral" variant="ghost" :disabled="deleting" @click="close" />
      <UButton label="移除" color="error" icon="i-lucide-trash-2" :loading="deleting" @click="confirmDelete" />
    </template>
  </UModal>
</template>
