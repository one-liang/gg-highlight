<script setup lang="ts">
import type { Settings, SystemInfo } from '~~/shared/types/domain'
import { apiErrorMessage } from '~/utils/api-error'
import { ollamaFixHint, ollamaStatusColors, ollamaStatusLabels, videoEncoderLabels } from '~/utils/labels'
import { normalizeFolderInput, validateFolderInput } from '~/utils/watch-folder'

useHead({ title: '設定' })

const notify = useNotify()
const settings = useApiData<Settings>('/api/settings', '讀取設定失敗')
const system = useApiData<SystemInfo>('/api/system', '讀取系統資訊失敗')

const folders = computed(() => settings.data.value?.watchFolders ?? [])
const ollama = computed(() => system.data.value?.ollama ?? null)
const ollamaHint = computed(() => (ollama.value ? ollamaFixHint(ollama.value) : null))
const newFolder = ref('')
const addError = ref<string | null>(null)
const saving = ref(false)
const removing = ref<string | null>(null)

/** PUT the whole list; throws so callers can show the server's validation message. */
async function save(watchFolders: string[]) {
  saving.value = true
  try {
    settings.set(await apiFetch<Settings>('/api/settings', { method: 'PUT', body: { watchFolders } }))
  }
  finally {
    saving.value = false
  }
}

async function addFolder() {
  const problem = validateFolderInput(newFolder.value, folders.value)
  if (problem) {
    addError.value = problem
    return
  }
  addError.value = null
  const path = normalizeFolderInput(newFolder.value)
  try {
    await save([...folders.value, path])
    newFolder.value = ''
    notify.success('已加入影片資料夾', path)
  }
  catch (err) {
    addError.value = apiErrorMessage(err, '無法加入這個資料夾')
  }
}

async function removeFolder(path: string) {
  removing.value = path
  try {
    await save(folders.value.filter(f => f !== path))
  }
  catch (err) {
    notify.error(err, '無法移除資料夾')
  }
  finally {
    removing.value = null
  }
}

watch(newFolder, () => {
  addError.value = null
})

const copied = ref(false)
async function copyDataDir() {
  const dir = system.data.value?.dataDir
  if (!dir) return
  try {
    await navigator.clipboard.writeText(dir)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  }
  catch {
    notify.message('無法複製', '瀏覽器不允許存取剪貼簿，請手動選取文字複製。')
  }
}
</script>

<template>
  <UContainer class="max-w-4xl py-6 sm:py-8">
    <h1 class="mb-6 text-2xl font-semibold text-highlighted">
      設定
    </h1>

    <div class="space-y-6">
      <UCard>
        <template #header>
          <div class="flex items-start gap-3">
            <UIcon name="i-lucide-folder-open" class="mt-0.5 size-5 shrink-0 text-primary" />
            <div>
              <h2 class="font-semibold text-highlighted">
                影片資料夾
              </h2>
              <p class="mt-1 text-sm text-muted">
                「加入影片」時會列出這些資料夾第一層的影片檔，加入後直接引用原檔，不會另外複製。
              </p>
            </div>
          </div>
        </template>

        <div class="space-y-5">
          <div v-if="!settings.loaded.value" class="space-y-2">
            <USkeleton v-for="i in 2" :key="i" class="h-11 w-full" />
          </div>

          <UAlert
            v-else-if="settings.error.value && !settings.data.value"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-alert"
            title="無法讀取設定"
            :description="settings.error.value.message"
            :actions="[{ label: '重試', icon: 'i-lucide-refresh-cw', color: 'error', variant: 'outline', onClick: settings.refresh }]"
          />

          <template v-else>
            <ul v-if="folders.length" class="divide-y divide-default rounded-lg border border-default">
              <li v-for="folder in folders" :key="folder" class="flex items-center gap-3 px-3 py-2">
                <UIcon name="i-lucide-folder" class="size-4 shrink-0 text-muted" />
                <span class="min-w-0 flex-1 break-all font-mono text-sm text-highlighted">{{ folder }}</span>
                <UTooltip text="移除這個資料夾（不會刪除裡面的檔案）">
                  <UButton
                    icon="i-lucide-x"
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    :aria-label="`移除 ${folder}`"
                    :loading="removing === folder"
                    :disabled="saving && removing !== folder"
                    @click="removeFolder(folder)"
                  />
                </UTooltip>
              </li>
            </ul>
            <p v-else class="rounded-lg border border-dashed border-accented px-4 py-6 text-center text-sm text-muted">
              還沒有影片資料夾。加入 OBS 的錄影資料夾後，就能直接挑選錄影檔。
            </p>

            <form class="space-y-1" @submit.prevent="addFolder">
              <UFormField label="新增資料夾" :error="addError ?? undefined">
                <div class="flex gap-2">
                  <UInput
                    v-model="newFolder"
                    placeholder="例如 C:\Users\你的名稱\Videos"
                    icon="i-lucide-folder-plus"
                    class="flex-1"
                    :ui="{ base: 'font-mono' }"
                    autocomplete="off"
                    spellcheck="false"
                  />
                  <UButton type="submit" label="加入" icon="i-lucide-plus" :loading="saving && !removing" :disabled="!newFolder.trim()" />
                </div>
              </UFormField>
            </form>

            <div class="rounded-lg bg-elevated/50 p-4 text-sm">
              <p class="flex items-center gap-1.5 font-medium text-highlighted">
                <UIcon name="i-lucide-info" class="size-4 text-info" />
                OBS 的錄影資料夾在哪裡？
              </p>
              <ul class="mt-2 space-y-1 text-muted">
                <li>
                  預設通常是 <code class="rounded bg-default px-1 py-0.5 font-mono text-xs text-highlighted">C:\Users\&lt;你&gt;\Videos</code>
                </li>
                <li>
                  在 OBS 的「設定 → 輸出 → 錄影 → 錄影路徑」可以看到實際位置，直接複製貼上即可（引號會自動去掉）。
                </li>
                <li>請貼上完整路徑；只會列出資料夾第一層的檔案，不會往子資料夾找。</li>
              </ul>
            </div>
          </template>
        </div>
      </UCard>

      <UCard>
        <template #header>
          <div class="flex items-start gap-3">
            <UIcon name="i-lucide-cpu" class="mt-0.5 size-5 shrink-0 text-primary" />
            <div>
              <h2 class="font-semibold text-highlighted">
                系統資訊
              </h2>
              <p class="mt-1 text-sm text-muted">
                輸出剪輯用的編碼器、資料存放位置、字幕字型，以及自動找精華用的本機 AI（Ollama）狀態。
              </p>
            </div>
          </div>
        </template>

        <div v-if="!system.loaded.value" class="space-y-2">
          <USkeleton v-for="i in 3" :key="i" class="h-8 w-full" />
        </div>

        <UAlert
          v-else-if="system.error.value && !system.data.value"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          title="無法讀取系統資訊"
          :description="system.error.value.message"
          :actions="[{ label: '重試', icon: 'i-lucide-refresh-cw', color: 'error', variant: 'outline', onClick: system.refresh }]"
        />

        <dl v-else-if="system.data.value" class="divide-y divide-default text-sm">
          <div class="grid gap-1 py-3 first:pt-0 sm:grid-cols-[10rem_1fr] sm:gap-4">
            <dt class="text-muted">
              影片編碼
            </dt>
            <dd class="space-y-1">
              <UBadge
                :label="videoEncoderLabels[system.data.value.videoEncoder]"
                :color="system.data.value.videoEncoder === 'h264_nvenc' ? 'success' : 'warning'"
                :icon="system.data.value.videoEncoder === 'h264_nvenc' ? 'i-lucide-zap' : 'i-lucide-cpu'"
                variant="subtle"
              />
              <p v-if="system.data.value.videoEncoderForced" class="text-xs text-muted">
                由環境變數 <code class="font-mono">GG_VIDEO_ENCODER</code> 指定。
              </p>
              <p v-else-if="system.data.value.videoEncoder === 'libx264'" class="text-xs text-muted">
                沒有偵測到可用的 NVIDIA 硬體編碼器，輸出剪輯會用 CPU 編碼，速度比較慢。
              </p>
            </dd>
          </div>

          <div class="grid gap-1 py-3 sm:grid-cols-[10rem_1fr] sm:gap-4">
            <dt class="text-muted">
              資料存放位置
            </dt>
            <dd class="flex items-start gap-2">
              <code class="min-w-0 flex-1 break-all font-mono text-xs leading-6 text-highlighted">{{ system.data.value.dataDir }}</code>
              <UTooltip :text="copied ? '已複製' : '複製路徑'">
                <UButton
                  :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  aria-label="複製路徑"
                  @click="copyDataDir"
                />
              </UTooltip>
            </dd>
          </div>

          <div class="grid gap-1 py-3 sm:grid-cols-[10rem_1fr] sm:gap-4">
            <dt class="text-muted">
              字幕字型
            </dt>
            <dd>
              <UBadge
                v-if="system.data.value.fontsReady"
                label="已就緒（Noto Sans CJK TC）"
                color="success"
                variant="subtle"
                icon="i-lucide-circle-check"
              />
              <div v-else class="space-y-1.5">
                <UBadge label="找不到字幕字型" color="error" variant="subtle" icon="i-lucide-circle-alert" />
                <p class="text-xs leading-relaxed text-muted">
                  燒錄字幕需要 Noto Sans CJK TC。請在專案資料夾執行 <code class="rounded bg-elevated px-1 py-0.5 font-mono text-highlighted">pnpm fonts</code>，或重新執行專案資料夾裡的安裝腳本 <code class="rounded bg-elevated px-1 py-0.5 font-mono text-highlighted">setup.bat</code>，完成後重新整理這一頁。
                </p>
              </div>
            </dd>
          </div>

          <div v-if="ollama" class="grid gap-1 py-3 sm:grid-cols-[10rem_1fr] sm:gap-4">
            <dt class="text-muted">
              AI 讀逐字稿
            </dt>
            <dd class="space-y-1.5">
              <div class="flex flex-wrap items-center gap-2">
                <UBadge
                  v-if="ollama.status === 'ready'"
                  :label="`已就緒（Ollama ${ollama.version ?? ''}・${ollama.model}）`"
                  :color="ollamaStatusColors.ready"
                  variant="subtle"
                  icon="i-lucide-circle-check"
                />
                <UBadge
                  v-else
                  :label="ollamaStatusLabels[ollama.status]"
                  :color="ollamaStatusColors[ollama.status]"
                  variant="subtle"
                  :icon="ollama.status === 'disabled' ? 'i-lucide-circle-minus' : 'i-lucide-triangle-alert'"
                />
                <UButton
                  label="重新檢查"
                  icon="i-lucide-refresh-cw"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :loading="system.loading.value"
                  @click="system.refresh"
                />
              </div>
              <p v-if="ollama.status !== 'ready'" class="text-xs text-muted">
                模型 <code class="font-mono">{{ ollama.model }}</code><template v-if="ollama.version">・Ollama {{ ollama.version }}</template><template v-if="ollama.url">・<code class="break-all font-mono">{{ ollama.url }}</code></template>
              </p>
              <template v-if="ollamaHint">
                <p class="text-xs leading-relaxed text-muted">
                  {{ ollamaHint.text }}
                </p>
                <code v-if="ollamaHint.command" class="inline-block rounded bg-elevated px-1.5 py-0.5 font-mono text-xs text-highlighted">{{ ollamaHint.command }}</code>
              </template>
              <p v-else class="text-xs text-muted">
                分析時本機 AI 會讀逐字稿找精華，用完立刻從顯示卡記憶體卸載。
              </p>
            </dd>
          </div>

          <div class="grid gap-1 py-3 last:pb-0 sm:grid-cols-[10rem_1fr] sm:gap-4">
            <dt class="text-muted">
              版本
            </dt>
            <dd class="font-mono text-xs leading-6 text-highlighted">
              {{ system.data.value.version }}
            </dd>
          </div>
        </dl>
      </UCard>
    </div>
  </UContainer>
</template>
