<script setup lang="ts">
import type { Highlight, SignalState } from '~~/shared/types/domain'
import type { HighlightEditDraft } from '~/types/highlight-edit'
import { summarizeSignals } from '~/utils/analysis'
import { countHighlights, emptyListText, emptyTabText, highlightsForTab, type HighlightFilter } from '~/utils/highlights'

const props = defineProps<{
  highlights: Highlight[]
  duration: number
  loaded: boolean
  error: string | null
  canPreview: boolean
  /** Tooltip of 輸出 while the video file is missing (wording depends on the source). */
  cannotExportText?: string
  focusedId: string | null
  clipCounts: Record<string, number>
  /** Signals of the last run that found candidates; null before any (milestone 1 videos). */
  signals: SignalState[] | null
  /** A highlights-only run is queued or running. */
  analysisActive: boolean
}>()

const editing = defineModel<HighlightEditDraft | null>('editing', { default: null })

const emit = defineEmits<{
  play: [highlight: Highlight, stopAtEnd: boolean]
  export: [highlight: Highlight]
  saved: [highlight: Highlight]
  focus: [highlight: Highlight]
  retry: []
}>()

// UTabs emits string | number
const filter = ref<string | number>('all')
const activeFilter = computed(() => filter.value as HighlightFilter)
const stopAtEnd = ref(true)

const counts = computed(() => countHighlights(props.highlights))
const tabs = computed(() => [
  { label: '全部', value: 'all', badge: counts.value.all },
  { label: '候選', value: 'candidate', badge: counts.value.candidate },
  { label: '選用', value: 'selected', badge: counts.value.selected },
  { label: '捨棄', value: 'dismissed', badge: counts.value.dismissed },
])
// 候選 by Highlight Score (best first); the other tabs by start
const shown = computed(() => highlightsForTab(props.highlights, activeFilter.value))

const listState = computed(() => ({ analysisRan: props.signals !== null, analysisActive: props.analysisActive }))
const emptyList = computed(() => emptyListText(listState.value))
const emptyTab = computed(() => (activeFilter.value === 'all' ? '' : emptyTabText(activeFilter.value, props.highlights, listState.value)))
const signalSummary = computed(() => summarizeSignals(props.signals))

function startEdit(h: Highlight) {
  editing.value = { id: h.id, start: h.start, end: h.end }
  emit('focus', h)
}
</script>

<template>
  <section class="rounded-lg border border-default p-4">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <h2 class="font-semibold text-highlighted">
        精華片段
      </h2>
      <USwitch v-model="stopAtEnd" label="播放到終點自動停止" size="sm" />
    </div>

    <div v-if="signalSummary" class="mb-3 space-y-1 text-sm" data-testid="signal-summary">
      <p class="flex items-start gap-1.5 text-muted">
        <UIcon name="i-lucide-audio-waveform" class="mt-0.5 size-4 shrink-0" />
        <span>這次的候選依據：<span class="font-medium text-toned">{{ signalSummary.used || '沒有可用的訊號' }}</span></span>
      </p>
      <p
        v-for="note in signalSummary.notes"
        :key="note.kind"
        class="flex items-start gap-1.5"
        :class="note.missing ? 'text-warning' : 'text-muted'"
      >
        <UIcon v-if="note.missing" name="i-lucide-triangle-alert" class="mt-0.5 size-4 shrink-0" />
        <UIcon v-else name="i-lucide-info" class="mt-0.5 size-4 shrink-0" />
        <span>{{ note.text }}</span>
      </p>
    </div>

    <UTabs
      v-model="filter"
      :items="tabs"
      :content="false"
      variant="pill"
      size="xs"
      color="neutral"
      class="mb-3 w-full sm:w-auto"
    />

    <div v-if="!loaded" class="space-y-2">
      <USkeleton v-for="i in 2" :key="i" class="h-16 w-full" />
    </div>

    <UAlert
      v-else-if="error && !highlights.length"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="無法讀取精華片段"
      :description="error"
      :actions="[{ label: '重試', icon: 'i-lucide-refresh-cw', color: 'error', variant: 'outline', onClick: () => emit('retry') }]"
    />

    <UEmpty
      v-else-if="!highlights.length"
      :icon="analysisActive ? 'i-lucide-hourglass' : 'i-lucide-scissors'"
      :title="emptyList.title"
      :description="emptyList.description"
      variant="naked"
      size="sm"
    />

    <p v-else-if="!shown.length" class="py-6 text-center text-sm text-muted">
      {{ emptyTab }}
    </p>

    <ul v-else class="space-y-2">
      <HighlightItem
        v-for="h in shown"
        :key="h.id"
        :highlight="h"
        :duration="duration"
        :editing="editing && editing.id === h.id ? editing : null"
        :edit-locked="!!editing && editing.id !== h.id"
        :focused="focusedId === h.id"
        :can-preview="canPreview"
        :cannot-export-text="cannotExportText"
        :clip-count="clipCounts[h.id] ?? 0"
        @play="emit('play', $event, stopAtEnd)"
        @export="emit('export', $event)"
        @saved="emit('saved', $event)"
        @focus="emit('focus', $event)"
        @edit-start="startEdit"
        @edit-change="editing = $event"
        @edit-end="editing = null"
      />
    </ul>
  </section>
</template>
