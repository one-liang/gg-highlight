<script setup lang="ts">
import type { SourceVideo, UploadResult, WatchFolderFile } from '~~/shared/types/domain'
import type { PickedSource } from '~/types/picked-source'

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ added: [video: SourceVideo] }>()

const tab = ref<string | number>('folder')
const picked = shallowRef<PickedSource | null>(null)
const uploading = ref(false)

const tabs = [
  { label: '影片資料夾', value: 'folder', icon: 'i-lucide-folder-open' },
  { label: '上傳檔案', value: 'upload', icon: 'i-lucide-upload' },
  { label: 'YouTube', value: 'youtube', icon: 'i-lucide-youtube', disabled: true, badge: { label: '里程碑 3 推出', color: 'neutral' as const, variant: 'soft' as const, size: 'xs' as const } },
]

watch(open, (isOpen) => {
  if (!isOpen) {
    picked.value = null
    tab.value = 'folder'
  }
})

function pickFile(file: WatchFolderFile) {
  picked.value = { kind: 'watch-folder', file }
}

function pickUpload(upload: UploadResult, sizeBytes: number) {
  picked.value = { kind: 'upload', upload, sizeBytes }
}

function onAdded(video: SourceVideo) {
  emit('added', video)
  open.value = false
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="加入影片"
    :description="picked ? '確認影片資訊，選好語言與音軌後開始分析。' : '從影片資料夾挑選錄影檔，或上傳一個影片檔。'"
    :dismissible="!uploading"
    :ui="{ content: 'sm:max-w-3xl' }"
  >
    <template #body>
      <AddVideoForm v-if="picked" :picked="picked" @back="picked = null" @added="onAdded" />
      <div v-else class="space-y-4">
        <UTabs v-model="tab" :items="tabs" :content="false" variant="link" class="w-full" />
        <WatchFolderPicker v-if="tab === 'folder'" @select="pickFile" @navigate="open = false" />
        <UploadPicker v-show="tab === 'upload'" v-model:busy="uploading" @uploaded="pickUpload" />
      </div>
    </template>
  </UModal>
</template>
