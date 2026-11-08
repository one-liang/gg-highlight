<script setup lang="ts">
import type { Highlight, HighlightStatus, UpdateHighlightBody } from '~~/shared/types/domain'
import type { HighlightEditDraft } from '~/types/highlight-edit'
import { formatScore } from '~/utils/format'
import { isOverShortsLimit, SHORTS_WARNING, statusActionLabels, statusTransitions, validateHighlightRange } from '~/utils/highlights'
import { highlightOriginLabels, highlightStatusColors, highlightStatusLabels } from '~/utils/labels'
import { formatSpan, formatTime, snapTime } from '~/utils/time'

const props = defineProps<{
  highlight: Highlight
  duration: number
  /** Edit draft when this Highlight is being adjusted. */
  editing: HighlightEditDraft | null
  /** Another Highlight is being adjusted. */
  editLocked: boolean
  focused: boolean
  canPreview: boolean
  clipCount: number
}>()

const emit = defineEmits<{
  'play': [highlight: Highlight]
  'export': [highlight: Highlight]
  'saved': [highlight: Highlight]
  'focus': [highlight: Highlight]
  'edit-start': [highlight: Highlight]
  'edit-change': [draft: HighlightEditDraft]
  'edit-end': []
}>()

const player = usePlayer()
const notify = useNotify()
const pendingStatus = ref<HighlightStatus | null>(null)
const savingRange = ref(false)

const h = computed(() => props.highlight)
const playingThis = computed(() => player.playing.value && player.rangeOwner.value === h.value.id)
const overShorts = computed(() => isOverShortsLimit(h.value.start, h.value.end))

const STATUS_BAR: Record<HighlightStatus, string> = {
  selected: 'bg-primary',
  candidate: 'bg-primary/35',
  dismissed: 'tl-striped',
}

const STATUS_ICON: Record<HighlightStatus, string> = {
  selected: 'i-lucide-check',
  dismissed: 'i-lucide-eye-off',
  candidate: 'i-lucide-undo-2',
}

const editProblem = computed(() => (props.editing ? validateHighlightRange(props.editing.start, props.editing.end, props.duration) : null))
const editLength = computed(() => {
  const e = props.editing
  return e && e.start !== null && e.end !== null && e.end > e.start ? e.end - e.start : null
})
const editOverShorts = computed(() => {
  const e = props.editing
  return !!e && e.start !== null && e.end !== null && isOverShortsLimit(e.start, e.end)
})

async function patch(body: UpdateHighlightBody): Promise<Highlight> {
  const updated = await apiFetch<Highlight>(`/api/highlights/${encodeURIComponent(h.value.id)}`, { method: 'PATCH', body })
  emit('saved', updated)
  return updated
}

async function setStatus(status: HighlightStatus) {
  pendingStatus.value = status
  try {
    await patch({ status })
  }
  catch (err) {
    notify.error(err, '無法更新精華片段狀態')
  }
  finally {
    pendingStatus.value = null
  }
}

function togglePlay() {
  if (playingThis.value) {
    player.pause()
    player.stopRange()
  }
  else {
    emit('play', h.value)
  }
}

function seekToStart() {
  emit('focus', h.value)
  player.stopRange()
  player.seek(h.value.start)
}

function changeEdit(patchDraft: Partial<Pick<HighlightEditDraft, 'start' | 'end'>>) {
  if (props.editing) emit('edit-change', { ...props.editing, ...patchDraft })
}

function setEditToCurrent(which: 'start' | 'end') {
  changeEdit({ [which]: snapTime(player.currentTime.value, props.duration) })
}

async function saveRange() {
  const e = props.editing
  if (!e || e.start === null || e.end === null || editProblem.value) return
  savingRange.value = true
  try {
    await patch({ start: e.start, end: e.end })
    emit('edit-end')
  }
  catch (err) {
    notify.error(err, '無法儲存起訖點')
  }
  finally {
    savingRange.value = false
  }
}
</script>

<template>
  <li
    class="rounded-lg border p-3 transition-colors"
    :class="[
      focused || editing ? 'border-primary/50 bg-primary/5' : 'border-default',
      h.status === 'dismissed' && !editing ? 'opacity-70 hover:opacity-100' : '',
    ]"
  >
    <div class="flex flex-wrap items-start gap-x-3 gap-y-2">
      <span class="mt-1 h-9 w-1 shrink-0 rounded-full" :class="STATUS_BAR[h.status]" aria-hidden="true" />

      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <button
            type="button"
            class="rounded font-mono text-sm tabular-nums text-highlighted hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
            title="跳到起點"
            @click="seekToStart"
          >
            {{ formatTime(h.start) }} – {{ formatTime(h.end) }}
          </button>
          <span class="text-sm tabular-nums text-muted">{{ formatSpan(h.end - h.start) }}</span>
          <UBadge :label="highlightStatusLabels[h.status]" :color="highlightStatusColors[h.status]" variant="subtle" size="sm" />
          <UBadge :label="highlightOriginLabels[h.origin]" color="neutral" variant="outline" size="sm" />
          <UTooltip v-if="overShorts" :text="SHORTS_WARNING">
            <UIcon name="i-lucide-triangle-alert" class="size-4 text-warning" :aria-label="SHORTS_WARNING" />
          </UTooltip>
          <span v-if="clipCount" class="text-xs text-dimmed">已輸出 {{ clipCount }} 次</span>
        </div>
        <p v-if="h.score !== null || h.reason" class="mt-1 text-sm text-muted">
          <span v-if="h.score !== null" class="mr-2 inline-flex items-center gap-1 font-medium text-toned">
            <UIcon name="i-lucide-sparkles" class="size-3.5 text-primary" />精華分數 {{ formatScore(h.score) }}
          </span>
          <span v-if="h.reason">{{ h.reason }}</span>
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-1">
        <UButton
          :icon="playingThis ? 'i-lucide-square' : 'i-lucide-play'"
          :label="playingThis ? '停止' : '播放'"
          size="xs"
          color="neutral"
          variant="outline"
          :disabled="!canPreview"
          @click="togglePlay"
        />
        <UButton
          v-for="s in statusTransitions(h.status)"
          :key="s"
          :label="statusActionLabels[s]"
          :icon="STATUS_ICON[s]"
          size="xs"
          color="neutral"
          variant="ghost"
          :loading="pendingStatus === s"
          :disabled="pendingStatus !== null && pendingStatus !== s"
          @click="setStatus(s)"
        />
        <UButton
          label="調整"
          icon="i-lucide-pencil"
          size="xs"
          color="neutral"
          variant="ghost"
          :disabled="!!editing || editLocked"
          @click="emit('edit-start', h)"
        />
        <UTooltip :text="canPreview ? '用這段輸出一支剪輯' : '找不到原始影片檔，無法輸出'">
          <UButton
            label="輸出"
            icon="i-lucide-scissors"
            size="xs"
            variant="soft"
            :disabled="!canPreview"
            @click="emit('export', h)"
          />
        </UTooltip>
      </div>
    </div>

    <form v-if="editing" class="mt-3 rounded-md bg-elevated/60 p-3" @submit.prevent="saveRange">
      <div class="flex flex-wrap items-end gap-x-4 gap-y-3">
        <UFormField label="起點" size="sm">
          <TimeInput
            :model-value="editing.start"
            label="起點"
            size="sm"
            @update:model-value="v => changeEdit({ start: v })"
            @set-current="setEditToCurrent('start')"
          />
        </UFormField>
        <UFormField label="終點" size="sm">
          <TimeInput
            :model-value="editing.end"
            label="終點"
            size="sm"
            @update:model-value="v => changeEdit({ end: v })"
            @set-current="setEditToCurrent('end')"
          />
        </UFormField>
        <div class="pb-1.5 text-sm">
          <span class="text-muted">長度</span>
          <span class="ml-1.5 font-medium tabular-nums text-highlighted">{{ editLength !== null ? formatSpan(editLength) : '—' }}</span>
        </div>
        <div class="ml-auto flex items-center gap-2">
          <UButton label="取消" color="neutral" variant="ghost" size="sm" :disabled="savingRange" @click="emit('edit-end')" />
          <UButton type="submit" label="儲存" icon="i-lucide-check" size="sm" :loading="savingRange" :disabled="!!editProblem" />
        </div>
      </div>
      <p v-if="editProblem" class="mt-2 flex items-center gap-1.5 text-sm text-error">
        <UIcon name="i-lucide-circle-alert" class="size-4 shrink-0" />{{ editProblem }}
      </p>
      <p v-else-if="editOverShorts" class="mt-2 flex items-center gap-1.5 text-sm text-warning">
        <UIcon name="i-lucide-triangle-alert" class="size-4 shrink-0" />{{ SHORTS_WARNING }}
      </p>
      <p class="mt-2 text-xs text-dimmed">
        修改起訖點不會影響已經輸出的剪輯。
      </p>
    </form>
  </li>
</template>
