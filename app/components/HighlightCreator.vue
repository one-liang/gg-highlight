<script setup lang="ts">
import type { CreateHighlightBody, Highlight } from '~~/shared/types/domain'
import { isOverShortsLimit, SHORTS_WARNING, validateHighlightRange } from '~/utils/highlights'
import { formatSpan, snapTime } from '~/utils/time'

const props = defineProps<{
  videoId: string
  duration: number
}>()

const start = defineModel<number | null>('start', { required: true })
const end = defineModel<number | null>('end', { required: true })
const emit = defineEmits<{ created: [highlight: Highlight] }>()

const player = usePlayer()
const notify = useNotify()
const saving = ref(false)

const touched = computed(() => start.value !== null || end.value !== null)
const problem = computed(() => (touched.value ? validateHighlightRange(start.value, end.value, props.duration) : null))
const length = computed(() => (start.value !== null && end.value !== null && end.value > start.value ? end.value - start.value : null))
const overShorts = computed(() => start.value !== null && end.value !== null && isOverShortsLimit(start.value, end.value))

function setStart() {
  start.value = snapTime(player.currentTime.value, props.duration)
}

function setEnd() {
  end.value = snapTime(player.currentTime.value, props.duration)
}

function clear() {
  start.value = null
  end.value = null
}

async function create() {
  if (start.value === null || end.value === null || problem.value || saving.value) return
  const body: CreateHighlightBody = { start: start.value, end: end.value }
  saving.value = true
  try {
    const highlight = await apiFetch<Highlight>(`/api/videos/${encodeURIComponent(props.videoId)}/highlights`, { method: 'POST', body })
    emit('created', highlight)
    notify.success('已新增精華片段', '手動新增的精華片段預設為「選用」。')
    clear()
  }
  catch (err) {
    notify.error(err, '無法新增精華片段')
  }
  finally {
    saving.value = false
  }
}

defineShortcuts({
  i: setStart,
  o: setEnd,
})
</script>

<template>
  <section class="rounded-lg border border-default p-4">
    <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="font-semibold text-highlighted">
        新增精華片段
      </h2>
      <p class="text-xs text-dimmed">
        播放到想剪的地方按 <UKbd value="I" size="sm" /> 設起點、<UKbd value="O" size="sm" /> 設終點
      </p>
    </div>

    <form class="flex flex-wrap items-end gap-x-4 gap-y-3" @submit.prevent="create">
      <UFormField label="起點" size="sm">
        <TimeInput v-model="start" label="起點" kbd="I" size="sm" @set-current="setStart" />
      </UFormField>
      <UFormField label="終點" size="sm">
        <TimeInput v-model="end" label="終點" kbd="O" size="sm" @set-current="setEnd" />
      </UFormField>
      <div class="pb-1.5 text-sm">
        <span class="text-muted">長度</span>
        <span class="ml-1.5 font-medium tabular-nums text-highlighted">{{ length !== null ? formatSpan(length) : '—' }}</span>
      </div>
      <div class="ml-auto flex items-center gap-2">
        <UButton v-if="touched" label="清除" color="neutral" variant="ghost" size="sm" :disabled="saving" @click="clear" />
        <UButton
          type="submit"
          label="新增精華片段"
          icon="i-lucide-plus"
          size="sm"
          :loading="saving"
          :disabled="!touched || !!problem"
        />
      </div>
    </form>

    <p v-if="problem && start !== null && end !== null" class="mt-2.5 flex items-center gap-1.5 text-sm text-error">
      <UIcon name="i-lucide-circle-alert" class="size-4 shrink-0" />{{ problem }}
    </p>
    <p v-else-if="problem" class="mt-2.5 text-sm text-muted">
      {{ problem }}
    </p>
    <p v-else-if="overShorts" class="mt-2.5 flex items-center gap-1.5 text-sm text-warning">
      <UIcon name="i-lucide-triangle-alert" class="size-4 shrink-0" />{{ SHORTS_WARNING }}
    </p>
  </section>
</template>
