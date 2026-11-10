<script setup lang="ts">
import type { AnalysisMode, SourceVideo, TranscriptSegment } from '~~/shared/types/domain'
import { countEditedSegments, defaultReanalyzeMode, reanalyzeOptions } from '~/utils/analysis'

const props = defineProps<{
  video: SourceVideo
  /** Mode to preselect instead of the default (e.g. 「重新分析全部」 on the old-video banner). */
  preset?: AnalysisMode | null
}>()

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ started: [video: SourceVideo] }>()

const { pending, start } = useReanalyze()
const mode = ref<AnalysisMode>('highlights')
/** Edited Transcript segments; null while loading or when the Transcript could not be read. */
const editedCount = ref<number | null>(null)
const loadingTranscript = ref(false)
const transcriptFailed = ref(false)
let touched = false
let loadSeq = 0

/**
 * 'full' transcribes the source file again: impossible while a local file is missing (the API answers
 * 422); a YouTube video's download step downloads a missing file again, so it only gets a note.
 */
const options = computed(() => reanalyzeOptions(props.video))
const fullUnavailable = computed(() => options.value.some(o => o.value === 'full' && o.disabled))
const isDisabled = (value: AnalysisMode) => options.value.some(o => o.value === value && o.disabled)

const recommended = computed<AnalysisMode | null>(() => (loadingTranscript.value ? null : defaultReanalyzeMode(props.video, editedCount.value)))

async function loadEditedCount(videoId: string) {
  const seq = ++loadSeq
  loadingTranscript.value = true
  transcriptFailed.value = false
  editedCount.value = null
  try {
    const segments = await apiFetch<TranscriptSegment[]>(`/api/videos/${encodeURIComponent(videoId)}/transcript`)
    if (seq !== loadSeq) return
    editedCount.value = countEditedSegments(Array.isArray(segments) ? segments : [])
  }
  catch {
    if (seq !== loadSeq) return
    transcriptFailed.value = true
  }
  finally {
    if (seq === loadSeq) {
      loadingTranscript.value = false
      if (!touched) mode.value = defaultReanalyzeMode(props.video, editedCount.value)
    }
  }
}

watch(open, (isOpen) => {
  if (!isOpen) return
  // a preset 'full' (the old-video banner) cannot apply without the source file
  const preset = props.preset && !isDisabled(props.preset) ? props.preset : null
  touched = !!preset
  mode.value = preset ?? 'highlights'
  void loadEditedCount(props.video.id)
}, { immediate: true })

watch(fullUnavailable, (unavailable) => {
  if (unavailable && mode.value === 'full') mode.value = 'highlights'
})

function choose(value: AnalysisMode) {
  if (isDisabled(value)) return
  touched = true
  mode.value = value
}

async function submit() {
  if (pending.value || isDisabled(mode.value)) return
  const video = await start(props.video.id, mode.value)
  if (!video) return
  emit('started', video)
  open.value = false
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="重新分析"
    description="選擇要重新做哪些部分。"
    :dismissible="!pending"
    :ui="{ content: 'sm:max-w-xl', footer: 'justify-end' }"
  >
    <template #body>
      <div class="space-y-5 text-sm">
        <fieldset>
          <legend class="sr-only">
            重新分析的方式
          </legend>
          <div class="space-y-3">
            <label
              v-for="o in options"
              :key="o.value"
              class="relative flex gap-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary"
              :class="[
                isDisabled(o.value) ? 'cursor-not-allowed border-default opacity-60' : 'cursor-pointer',
                !isDisabled(o.value) && (mode === o.value ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-default hover:bg-elevated/50'),
              ]"
            >
              <input
                type="radio"
                name="reanalyze-mode"
                :value="o.value"
                :checked="mode === o.value"
                :disabled="isDisabled(o.value)"
                :aria-disabled="isDisabled(o.value) || undefined"
                class="sr-only"
                @change="choose(o.value)"
              >
              <UIcon
                :name="mode === o.value ? 'i-lucide-circle-dot' : 'i-lucide-circle'"
                class="mt-0.5 size-4 shrink-0"
                :class="mode === o.value ? 'text-primary' : 'text-dimmed'"
              />
              <span class="min-w-0 flex-1 space-y-1">
                <span class="flex flex-wrap items-center gap-1.5">
                  <span class="font-medium text-highlighted">{{ o.title }}</span>
                  <UBadge v-if="recommended === o.value" label="建議" size="sm" color="neutral" variant="soft" />
                </span>
                <span class="block text-xs leading-relaxed text-muted">{{ o.description }}</span>
                <span v-if="o.note?.tone === 'warning'" class="flex items-start gap-1 text-xs text-warning">
                  <UIcon name="i-lucide-file-warning" class="mt-px size-3.5 shrink-0" />{{ o.note.text }}
                </span>
                <span v-else-if="o.note" class="flex items-start gap-1 text-xs text-toned" data-testid="reanalyze-redownload">
                  <UIcon name="i-lucide-download" class="mt-px size-3.5 shrink-0" />{{ o.note.text }}
                </span>
              </span>
            </label>
          </div>
        </fieldset>

        <p v-if="loadingTranscript" class="flex items-center gap-1.5 text-xs text-muted">
          <UIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin" />正在檢查逐字稿有沒有修改過…
        </p>
        <p v-else-if="transcriptFailed" class="flex items-start gap-1.5 text-xs text-warning">
          <UIcon name="i-lucide-triangle-alert" class="mt-px size-3.5 shrink-0" />無法讀取逐字稿，不確定有沒有修改過，所以預設只重新找精華片段。
        </p>
        <p v-else-if="editedCount && mode === 'full'" class="flex items-start gap-1.5 text-xs text-warning">
          <UIcon name="i-lucide-triangle-alert" class="mt-px size-3.5 shrink-0" />你改過 {{ editedCount }} 段逐字稿，重新辨識後這些修改會被覆蓋。
        </p>
        <p v-else-if="editedCount" class="flex items-start gap-1.5 text-xs text-muted">
          <UIcon name="i-lucide-pencil" class="mt-px size-3.5 shrink-0" />你改過 {{ editedCount }} 段逐字稿，會照常保留，AI 會讀修改後的文字。
        </p>

        <ul class="space-y-2 rounded-lg bg-elevated/50 p-3 text-xs">
          <li class="flex gap-2">
            <UIcon name="i-lucide-shield-check" class="mt-px size-3.5 shrink-0 text-success" />
            <span><span class="font-medium text-highlighted">會保留：</span>選用／捨棄／手動新增的精華片段、已輸出的剪輯</span>
          </li>
          <li class="flex gap-2">
            <UIcon name="i-lucide-refresh-cw" class="mt-px size-3.5 shrink-0 text-warning" />
            <span><span class="font-medium text-highlighted">會被取代：</span>還是候選、沒輸出過的片段（調整過起訖點但沒按「選用」的也會被取代）；新的候選不會和保留的片段重疊</span>
          </li>
        </ul>
      </div>
    </template>

    <template #footer="{ close }">
      <UButton label="取消" color="neutral" variant="ghost" :disabled="!!pending" @click="close" />
      <UButton label="開始重新分析" icon="i-lucide-refresh-cw" :loading="!!pending" @click="submit" />
    </template>
  </UModal>
</template>
