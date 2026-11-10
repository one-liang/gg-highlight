<script setup lang="ts">
import type { TranscriptSegment } from '~~/shared/types/domain'
import { apiErrorMessage } from '~/utils/api-error'
import { formatTime } from '~/utils/time'
import {
  findSegmentAt,
  highlightParts,
  MAX_SEGMENT_CHARS,
  searchSegments,
  segmentOverlaps,
  singleLine,
  validateSegmentText,
} from '~/utils/transcript'

const props = defineProps<{
  videoId: string
  segments: TranscriptSegment[]
  loaded: boolean
  error: string | null
  /** Range to mark subtly (Highlight being created / adjusted / focused). */
  markRange: { start: number, end: number } | null
}>()

const emit = defineEmits<{
  updated: [segment: TranscriptSegment]
  retry: []
}>()

const player = usePlayer()
const list = useTemplateRef<HTMLDivElement>('list')
const query = ref('')
// filtering re-renders thousands of rows, so wait until typing pauses (clearing is immediate)
const activeQuery = ref('')
let queryTimer: ReturnType<typeof setTimeout> | undefined
watch(query, (q) => {
  clearTimeout(queryTimer)
  if (!q.trim()) activeQuery.value = ''
  else queryTimer = setTimeout(() => (activeQuery.value = q), 180)
})

const searching = computed(() => activeQuery.value.trim() !== '')
const shown = computed(() => searchSegments(props.segments, activeQuery.value))
const editedCount = computed(() => props.segments.reduce((n, s) => n + (s.edited ? 1 : 0), 0))
// only changes when playback crosses a segment boundary, so rows re-render rarely
const currentIdx = computed(() => {
  const pos = findSegmentAt(props.segments, player.currentTime.value)
  return pos >= 0 ? props.segments[pos]!.idx : -1
})

function isMarked(seg: TranscriptSegment): boolean {
  const r = props.markRange
  return !!r && segmentOverlaps(seg, r.start, r.end)
}

// ---- follow playback without fighting the user's scrolling ----

const FOLLOW_PAUSE_MS = 4000
let userScrolledAt = 0
let scrollFrame = 0
const outOfView = ref(false)

function noteUserScroll() {
  userScrolledAt = Date.now()
}

function onListPointerDown(e: PointerEvent) {
  // a pointerdown on the container itself (not a row) is the scrollbar
  if (e.target === list.value) noteUserScroll()
}

function onListKeydown(e: KeyboardEvent) {
  if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) noteUserScroll()
}

function rowEl(idx: number): HTMLElement | null {
  return list.value?.querySelector<HTMLElement>(`[data-idx="${idx}"]`) ?? null
}

function updateOutOfView() {
  const box = list.value
  const row = currentIdx.value >= 0 && !searching.value ? rowEl(currentIdx.value) : null
  if (!box || !row) {
    outOfView.value = false
    return
  }
  outOfView.value = row.offsetTop + row.offsetHeight < box.scrollTop || row.offsetTop > box.scrollTop + box.clientHeight
}

function onListScroll() {
  if (scrollFrame) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0
    updateOutOfView()
  })
}

function scrollToIdx(idx: number, onlyIfNeeded: boolean) {
  const box = list.value
  const row = rowEl(idx)
  if (!box || !row) return
  const margin = box.clientHeight * 0.12
  const top = row.offsetTop
  const bottom = top + row.offsetHeight
  if (onlyIfNeeded && top >= box.scrollTop + margin && bottom <= box.scrollTop + box.clientHeight - margin) return
  box.scrollTo({ top: Math.max(0, top - box.clientHeight / 3), behavior: 'smooth' })
}

function jumpToCurrent() {
  userScrolledAt = 0
  if (currentIdx.value >= 0) scrollToIdx(currentIdx.value, false)
}

watch(currentIdx, async (idx) => {
  await nextTick()
  updateOutOfView()
  if (idx < 0 || !player.playing.value || searching.value || editingIdx.value !== null) return
  if (Date.now() - userScrolledAt < FOLLOW_PAUSE_MS) return
  scrollToIdx(idx, true)
})

onBeforeUnmount(() => {
  if (scrollFrame) cancelAnimationFrame(scrollFrame)
  clearTimeout(queryTimer)
})

function seekTo(seg: TranscriptSegment) {
  userScrolledAt = 0
  player.stopRange()
  player.seek(seg.start)
}

// ---- in-place editing ----

const editingIdx = ref<number | null>(null)
const draft = ref('')
const editError = ref<string | null>(null)
const saving = ref(false)
let editorEl: HTMLTextAreaElement | null = null

const draftLength = computed(() => draft.value.trim().length)
/** Changes whenever the editing row must re-render (v-memo key). */
const editKey = computed(() => `${draft.value}\u0000${editError.value ?? ''}\u0000${saving.value}`)

function setEditor(el: unknown) {
  editorEl = (el as HTMLTextAreaElement | null) ?? null
}

function autosize(el: HTMLTextAreaElement) {
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

function startEdit(seg: TranscriptSegment) {
  if (saving.value) return
  editingIdx.value = seg.idx
  draft.value = seg.text
  editError.value = null
  void nextTick(() => {
    const el = editorEl
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    autosize(el)
  })
}

function cancelEdit() {
  editingIdx.value = null
  editError.value = null
}

/** `fromKeyboard`: refocus the editor after a failed save (not after a blur-triggered save). */
async function saveEdit(fromKeyboard = true) {
  const idx = editingIdx.value
  if (idx === null || saving.value) return
  const seg = props.segments.find(s => s.idx === idx)
  if (!seg) {
    cancelEdit()
    return
  }
  const text = draft.value.trim()
  const problem = validateSegmentText(text)
  if (problem) {
    editError.value = problem
    return
  }
  if (text === seg.text) {
    cancelEdit()
    return
  }
  saving.value = true
  editError.value = null
  try {
    const updated = await apiFetch<TranscriptSegment>(
      `/api/videos/${encodeURIComponent(props.videoId)}/transcript/${idx}`,
      { method: 'PATCH', body: { text } },
    )
    emit('updated', updated)
    if (editingIdx.value === idx) editingIdx.value = null
  }
  catch (err) {
    editError.value = apiErrorMessage(err, '儲存失敗')
    // keep Enter / Esc working without another click
    if (fromKeyboard && editingIdx.value === idx) editorEl?.focus()
  }
  finally {
    saving.value = false
  }
}

function onEditInput(e: Event) {
  const el = e.target as HTMLTextAreaElement
  draft.value = singleLine(el.value)
  editError.value = null
  autosize(el)
}

function onEditKeydown(e: KeyboardEvent) {
  // let the IME finish composing (Enter confirms the candidate there)
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'Enter') {
    e.preventDefault()
    if (!e.shiftKey) void saveEdit()
  }
  else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    cancelEdit()
  }
}

function onEditBlur() {
  if (editingIdx.value === null || saving.value) return
  const seg = props.segments.find(s => s.idx === editingIdx.value)
  if (!seg || draft.value.trim() === seg.text) cancelEdit()
  else void saveEdit(false)
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-default bg-default">
    <div class="space-y-2 border-b border-default p-3">
      <div class="flex items-baseline justify-between gap-2">
        <h2 class="font-semibold text-highlighted">
          逐字稿
        </h2>
        <span v-if="segments.length" class="text-xs tabular-nums text-muted">
          {{ segments.length }} 段<template v-if="editedCount">・已修改 {{ editedCount }} 段</template>
        </span>
      </div>
      <UInput
        v-model="query"
        icon="i-lucide-search"
        placeholder="搜尋逐字稿"
        size="sm"
        class="w-full"
        :disabled="!segments.length"
      >
        <template v-if="query" #trailing>
          <UButton icon="i-lucide-x" color="neutral" variant="link" size="xs" aria-label="清除搜尋" @click="query = ''" />
        </template>
      </UInput>
      <p class="text-xs text-dimmed">
        {{ searching ? `找到 ${shown.length} 段・` : '' }}點文字可以直接修改；修改只會套用到之後輸出的剪輯。
      </p>
    </div>

    <div v-if="!loaded" class="space-y-3 p-3">
      <USkeleton v-for="i in 8" :key="i" class="h-10 w-full" />
    </div>

    <div v-else-if="error && !segments.length" class="p-3">
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        title="無法讀取逐字稿"
        :description="error"
        :actions="[{ label: '重試', icon: 'i-lucide-refresh-cw', color: 'error', variant: 'outline', onClick: () => emit('retry') }]"
      />
    </div>

    <UEmpty
      v-else-if="!segments.length"
      icon="i-lucide-mic-off"
      title="沒有辨識到說話內容"
      description="這支影片的分析用音軌裡沒有可以辨識的語音。"
      variant="naked"
      size="sm"
      class="flex-1"
    />

    <div v-else class="relative min-h-0 flex-1">
      <div
        ref="list"
        class="relative h-full overflow-y-auto overscroll-contain py-1"
        @wheel.passive="noteUserScroll"
        @touchmove.passive="noteUserScroll"
        @keydown="onListKeydown"
        @pointerdown="onListPointerDown"
        @scroll.passive="onListScroll"
      >
        <p v-if="!shown.length" class="px-4 py-10 text-center text-sm text-muted">
          沒有符合「{{ activeQuery.trim() }}」的段落
        </p>
        <div
          v-for="seg in shown"
          :key="seg.idx"
          v-memo="[seg, seg.idx === currentIdx, isMarked(seg), editingIdx === seg.idx ? editKey : '', activeQuery]"
          :data-idx="seg.idx"
          class="transcript-row flex gap-3 border-l-2 px-3 py-1.5"
          :class="seg.idx === currentIdx
            ? 'border-primary bg-primary/10'
            : isMarked(seg) ? 'border-warning/60 bg-warning/5' : 'border-transparent hover:bg-elevated/50'"
        >
          <button
            type="button"
            class="h-fit shrink-0 rounded pt-0.5 font-mono text-xs tabular-nums hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary"
            :class="seg.idx === currentIdx ? 'text-primary' : 'text-muted'"
            :title="`跳到 ${formatTime(seg.start)}`"
            @click="seekTo(seg)"
          >
            {{ formatTime(seg.start) }}
          </button>

          <div v-if="editingIdx === seg.idx" class="min-w-0 flex-1">
            <textarea
              :ref="setEditor"
              :value="draft"
              rows="1"
              :readonly="saving"
              :aria-busy="saving || undefined"
              aria-label="修改這段逐字稿"
              class="block w-full resize-none rounded-md bg-default px-2 py-1 text-sm leading-relaxed text-highlighted ring ring-primary focus:outline-none read-only:opacity-70"
              :class="editError ? 'ring-error' : ''"
              @input="onEditInput"
              @keydown="onEditKeydown"
              @blur="onEditBlur"
            />
            <div class="mt-1 flex items-center justify-between gap-2 text-xs">
              <span :class="editError ? 'text-error' : 'text-dimmed'">
                <template v-if="saving">儲存中…</template>
                <template v-else>{{ editError || 'Enter 儲存・Esc 取消' }}</template>
              </span>
              <span class="tabular-nums" :class="draftLength > MAX_SEGMENT_CHARS ? 'text-error' : 'text-dimmed'">{{ draftLength }}/{{ MAX_SEGMENT_CHARS }}</span>
            </div>
          </div>

          <p
            v-else
            class="min-w-0 flex-1 cursor-text rounded text-sm leading-relaxed break-words focus-visible:outline-2 focus-visible:outline-primary"
            :class="seg.idx === currentIdx ? 'text-highlighted' : 'text-default'"
            role="button"
            tabindex="0"
            title="點一下修改文字"
            @click="startEdit(seg)"
            @keydown.enter.prevent="startEdit(seg)"
          >
            <template v-for="(part, i) in highlightParts(seg.text, activeQuery)" :key="i"><mark v-if="part.match" class="rounded-sm bg-warning/30 text-inherit">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template>
          </p>

          <UBadge v-if="seg.edited && editingIdx !== seg.idx" label="已修改" color="info" variant="soft" size="sm" class="h-fit shrink-0" />
        </div>
      </div>

      <!-- v-show, not v-if: remounting the button on every toggle restyles the whole page -->
      <UButton
        v-show="outOfView"
        label="回到目前段落"
        icon="i-lucide-locate-fixed"
        size="xs"
        color="neutral"
        variant="solid"
        class="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md"
        @click="jumpToCurrent"
      />
    </div>
  </section>
</template>
