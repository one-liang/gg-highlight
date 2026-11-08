<script setup lang="ts">
import type { UploadResult } from '~~/shared/types/domain'
import { apiErrorMessage } from '~/utils/api-error'
import { formatBytes, formatPercent } from '~/utils/format'
import { uploadFile, type UploadHandle } from '~/utils/upload'

const emit = defineEmits<{ uploaded: [result: UploadResult, sizeBytes: number] }>()
const busy = defineModel<boolean>('busy', { default: false })
const notify = useNotify()

const VIDEO_EXT_RE = /\.(?:mp4|m4v|mkv|mov|webm|flv|ts|mts|m2ts|avi|wmv|mpg|mpeg)$/i
const ACCEPT = 'video/*,.mkv,.flv,.ts,.mts,.m2ts,.mov,.mp4,.m4v,.webm,.avi,.wmv'

const file = shallowRef<File | null>(null)
const loaded = ref(0)
const total = ref(0)
const error = ref<string | null>(null)
const dragDepth = ref(0)
let handle: UploadHandle<UploadResult> | null = null

const progress = computed(() => (total.value > 0 ? loaded.value / total.value : 0))
const processing = computed(() => busy.value && total.value > 0 && loaded.value >= total.value)

function looksLikeVideo(f: File): boolean {
  return f.type.startsWith('video/') || VIDEO_EXT_RE.test(f.name)
}

async function start(f: File) {
  if (busy.value) return
  error.value = null
  if (!looksLikeVideo(f)) {
    error.value = `「${f.name}」看起來不是影片檔。`
    return
  }
  file.value = f
  loaded.value = 0
  total.value = f.size
  busy.value = true
  handle = uploadFile<UploadResult>(f, {
    onProgress: (l, t) => {
      loaded.value = l
      total.value = t || f.size
    },
  })
  try {
    const result = await handle.promise
    emit('uploaded', result, f.size)
  }
  catch (err) {
    const message = apiErrorMessage(err, '上傳失敗')
    if (message !== '已取消') {
      error.value = message
      notify.error(err, '上傳失敗')
    }
    file.value = null
  }
  finally {
    handle = null
    busy.value = false
  }
}

function cancel() {
  handle?.abort()
}

function pickFiles(list: FileList | null | undefined) {
  if (!list || !list.length) return
  if (list.length > 1) error.value = '一次只能上傳一個檔案，已選擇第一個。'
  void start(list[0]!)
}

function onInputChange(e: Event) {
  const el = e.target as HTMLInputElement
  pickFiles(el.files)
  el.value = ''
}

function onDragEnter(e: DragEvent) {
  if (!e.dataTransfer?.types.includes('Files')) return
  dragDepth.value++
}

function onDragLeave() {
  dragDepth.value = Math.max(0, dragDepth.value - 1)
}

function onDrop(e: DragEvent) {
  dragDepth.value = 0
  if (busy.value) return
  pickFiles(e.dataTransfer?.files)
}

onBeforeUnmount(() => {
  handle?.abort()
})
</script>

<template>
  <div class="space-y-3">
    <div v-if="busy && file" class="rounded-lg border border-default p-4">
      <div class="flex items-start gap-3">
        <UIcon
          :name="processing ? 'i-lucide-loader-circle' : 'i-lucide-cloud-upload'"
          class="mt-0.5 size-5 shrink-0 text-primary"
          :class="{ 'animate-spin': processing }"
        />
        <div class="min-w-0 flex-1">
          <p class="truncate font-medium text-highlighted" :title="file.name">
            {{ file.name }}
          </p>
          <p class="mt-0.5 text-sm tabular-nums text-muted">
            <template v-if="processing">
              上傳完成，正在讀取影片資訊…
            </template>
            <template v-else>
              已上傳 {{ formatBytes(loaded) }} / {{ formatBytes(total) }}（{{ formatPercent(progress) }}）
            </template>
          </p>
          <UProgress :model-value="processing ? null : Math.floor(progress * 100)" size="sm" class="mt-3" />
        </div>
        <UButton label="取消" color="neutral" variant="outline" size="sm" @click="cancel" />
      </div>
    </div>

    <label
      v-else
      class="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-6 py-12 text-center transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary"
      :class="dragDepth > 0 ? 'border-primary bg-primary/5' : 'border-accented hover:border-primary/60 hover:bg-elevated/40'"
      @dragenter.prevent="onDragEnter"
      @dragover.prevent
      @dragleave.prevent="onDragLeave"
      @drop.prevent="onDrop"
    >
      <span class="flex size-12 items-center justify-center rounded-full bg-elevated">
        <UIcon name="i-lucide-upload" class="size-6 text-primary" />
      </span>
      <span>
        <span class="block font-medium text-highlighted">把影片拖到這裡，或點一下選擇檔案</span>
        <span class="mt-1 block text-sm text-muted">支援 mp4、mkv、mov、webm 等格式</span>
      </span>
      <input type="file" :accept="ACCEPT" class="sr-only" @change="onInputChange">
    </label>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :description="error"
      :close="true"
      @update:open="error = null"
    />

    <p class="flex gap-1.5 text-xs text-dimmed">
      <UIcon name="i-lucide-info" class="mt-0.5 size-3.5 shrink-0" />
      <span>上傳會在 gg-highlight 的 data 資料夾存一份複本，佔用同樣的硬碟空間。OBS 錄影建議改用「影片資料夾」，直接引用原檔。</span>
    </p>
  </div>
</template>
