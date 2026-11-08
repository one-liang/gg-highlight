<script setup lang="ts">
import type { Settings, WatchFolderFile } from '~~/shared/types/domain'
import { formatBytes, formatDateTime } from '~/utils/format'
import { filterWatchFolderFiles } from '~/utils/watch-folder'

const emit = defineEmits<{
  select: [file: WatchFolderFile]
  navigate: []
}>()

const files = useApiData<WatchFolderFile[]>('/api/watch-folders/files', '讀取影片資料夾失敗')
const settings = useApiData<Settings>('/api/settings', '讀取設定失敗')
const query = ref('')

const allFiles = computed(() => files.data.value ?? [])
const shown = computed(() => filterWatchFolderFiles(allFiles.value, query.value))
const folders = computed(() => settings.data.value?.watchFolders ?? [])
const noFolders = computed(() => settings.loaded.value && !settings.error.value && folders.value.length === 0)
const firstLoad = computed(() => !files.loaded.value || (!settings.loaded.value && allFiles.value.length === 0))

function reload() {
  void files.refresh()
  void settings.refresh()
}

function choose(file: WatchFolderFile) {
  if (!file.inLibrary) emit('select', file)
}
</script>

<template>
  <div>
    <div v-if="firstLoad" class="space-y-2">
      <USkeleton class="h-9 w-full" />
      <USkeleton v-for="i in 4" :key="i" class="h-14 w-full" />
    </div>

    <UAlert
      v-else-if="files.error.value && !allFiles.length"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="無法列出影片資料夾裡的檔案"
      :description="files.error.value.message"
      :actions="[{ label: '重試', icon: 'i-lucide-refresh-cw', color: 'error', variant: 'outline', onClick: reload }]"
    />

    <UEmpty
      v-else-if="noFolders"
      icon="i-lucide-folder-plus"
      title="還沒有設定影片資料夾"
      description="在設定頁加入 OBS 的錄影資料夾，就能直接從這裡挑選錄影檔，不必另外複製一份。"
      variant="naked"
      :actions="[{ label: '前往設定', icon: 'i-lucide-settings', to: '/settings', onClick: () => emit('navigate') }]"
    />

    <UEmpty
      v-else-if="!allFiles.length"
      icon="i-lucide-file-video"
      title="影片資料夾裡沒有影片檔"
      description="只會列出資料夾第一層的影片檔（mp4、mkv、mov 等）。錄好新影片後按重新整理。"
      variant="naked"
      :actions="[{ label: '重新整理', icon: 'i-lucide-refresh-cw', color: 'neutral', variant: 'outline', loading: files.loading.value, onClick: reload }]"
    >
      <template v-if="folders.length" #footer>
        <ul class="space-y-1 text-xs text-muted">
          <li v-for="f in folders" :key="f" class="flex items-center justify-center gap-1.5">
            <UIcon name="i-lucide-folder" class="size-3.5 shrink-0" />
            <span class="break-all font-mono">{{ f }}</span>
          </li>
        </ul>
      </template>
    </UEmpty>

    <div v-else class="space-y-3">
      <div class="flex items-center gap-2">
        <UInput
          v-model="query"
          icon="i-lucide-search"
          placeholder="搜尋檔名或資料夾"
          class="flex-1"
          autofocus
        />
        <UTooltip text="重新整理">
          <UButton
            icon="i-lucide-refresh-cw"
            color="neutral"
            variant="outline"
            aria-label="重新整理"
            :loading="files.loading.value"
            @click="reload"
          />
        </UTooltip>
      </div>

      <p v-if="!shown.length" class="py-8 text-center text-sm text-muted">
        沒有符合「{{ query.trim() }}」的影片
      </p>

      <ul v-else class="max-h-[50vh] divide-y divide-default overflow-y-auto rounded-lg border border-default">
        <li v-for="file in shown" :key="file.path">
          <button
            type="button"
            class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors enabled:hover:bg-elevated/60 focus-visible:bg-elevated/60 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="file.inLibrary"
            :title="file.path"
            @click="choose(file)"
          >
            <UIcon name="i-lucide-file-video" class="size-5 shrink-0 text-muted" />
            <span class="min-w-0 flex-1">
              <span class="block truncate font-medium text-highlighted">{{ file.name }}</span>
              <span class="block truncate font-mono text-xs text-dimmed">{{ file.folder }}</span>
            </span>
            <span class="hidden shrink-0 text-right text-xs tabular-nums text-muted sm:block">
              <span class="block">{{ formatBytes(file.sizeBytes) }}</span>
              <span class="block">{{ formatDateTime(file.modifiedAt) }}</span>
            </span>
            <UBadge v-if="file.inLibrary" label="已在影片庫" color="neutral" variant="soft" size="sm" class="shrink-0" />
            <UIcon v-else name="i-lucide-chevron-right" class="size-4 shrink-0 text-dimmed" />
          </button>
        </li>
      </ul>

      <p class="text-xs text-dimmed">
        共 {{ allFiles.length }} 個影片檔，新的在前。加入時直接引用原檔，不會複製。
      </p>
    </div>
  </div>
</template>
