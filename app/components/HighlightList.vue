<script setup lang="ts">
import type { Highlight } from '~~/shared/types/domain'
import type { HighlightEditDraft } from '~/types/highlight-edit'
import { countHighlights, filterHighlights, type HighlightFilter } from '~/utils/highlights'
import { highlightStatusLabels } from '~/utils/labels'

const props = defineProps<{
  highlights: Highlight[]
  duration: number
  loaded: boolean
  error: string | null
  canPreview: boolean
  focusedId: string | null
  clipCounts: Record<string, number>
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
  { label: '選用', value: 'selected', badge: counts.value.selected },
  { label: '候選', value: 'candidate', badge: counts.value.candidate },
  { label: '捨棄', value: 'dismissed', badge: counts.value.dismissed },
])
const shown = computed(() => filterHighlights(props.highlights, activeFilter.value))
const filterLabel = computed(() => (activeFilter.value === 'all' ? '' : highlightStatusLabels[activeFilter.value]))

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
      icon="i-lucide-scissors"
      title="還沒有精華片段"
      description="用上方的起點／終點標出想剪的段落；點逐字稿的時間可以快速跳到那裡。"
      variant="naked"
      size="sm"
    />

    <p v-else-if="!shown.length" class="py-6 text-center text-sm text-muted">
      沒有「{{ filterLabel }}」的精華片段
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
