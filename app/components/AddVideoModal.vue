<script setup lang="ts">
import type { SourceVideo, UploadResult, WatchFolderFile, YoutubeInfo } from '~~/shared/types/domain'
import type { PickedSource } from '~/types/picked-source'

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ added: [video: SourceVideo] }>()

const tab = ref<string | number>('folder')
const picked = shallowRef<PickedSource | null>(null)
const uploading = ref(false)
/** The YouTube link being typed; kept while the preview is shown so 「上一步」 can edit it. */
const youtubeUrl = ref('')

const tabs = [
  { label: '影片資料夾', value: 'folder', icon: 'i-lucide-folder-open', testid: 'folder-tab' },
  { label: '上傳檔案', value: 'upload', icon: 'i-lucide-upload', testid: 'upload-tab' },
  { label: 'YouTube', value: 'youtube', icon: 'i-lucide-youtube', testid: 'youtube-tab' },
]

const description = computed(() => {
  if (!picked.value) return '從影片資料夾挑選錄影檔、上傳一個影片檔，或貼上 YouTube 連結。'
  return picked.value.kind === 'youtube'
    ? '確認影片資訊，選好語言後下載並開始分析。'
    : '確認影片資訊，選好語言與音軌後開始分析。'
})

watch(open, (isOpen) => {
  if (!isOpen) {
    picked.value = null
    tab.value = 'folder'
    uploading.value = false
    youtubeUrl.value = ''
  }
})

function pickFile(file: WatchFolderFile) {
  picked.value = { kind: 'watch-folder', file }
}

function pickUpload(upload: UploadResult, sizeBytes: number) {
  picked.value = { kind: 'upload', upload, sizeBytes }
}

function pickYoutube(info: YoutubeInfo) {
  picked.value = { kind: 'youtube', info }
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
    :description="description"
    :dismissible="!uploading"
    :ui="{ content: 'sm:max-w-3xl' }"
  >
    <template #body>
      <AddVideoForm v-if="picked" :picked="picked" @back="picked = null" @added="onAdded" @navigate="open = false" />
      <div v-else class="space-y-4">
        <UTabs v-model="tab" :items="tabs" :content="false" variant="link" class="w-full">
          <template #default="{ item }">
            <span :data-testid="item.testid">{{ item.label }}</span>
          </template>
        </UTabs>
        <WatchFolderPicker v-if="tab === 'folder'" @select="pickFile" @navigate="open = false" />
        <UploadPicker v-show="tab === 'upload'" v-model:busy="uploading" @uploaded="pickUpload" />
        <YoutubePicker v-if="tab === 'youtube'" v-model:url="youtubeUrl" @probed="pickYoutube" />
      </div>
    </template>
  </UModal>
</template>
