<script setup lang="ts">
import type { Clip, CreateClipBody, Highlight, Layout, SourceVideo } from '~~/shared/types/domain'
import { isOverShortsLimit, SHORTS_WARNING } from '~/utils/highlights'
import { layoutDescriptions, layoutLabels, LAYOUTS } from '~/utils/labels'
import { formatSpan, formatTime } from '~/utils/time'

const props = defineProps<{
  highlight: Highlight | null
  video: SourceVideo
}>()

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ created: [clip: Clip] }>()

const notify = useNotify()
const layout = ref<Layout>('blurred-background')
const burnSubtitles = ref(true)
const submitting = ref(false)

watch(open, (isOpen) => {
  if (isOpen) {
    layout.value = 'blurred-background'
    burnSubtitles.value = true
  }
})

const overShorts = computed(() => !!props.highlight && isOverShortsLimit(props.highlight.start, props.highlight.end))
const multiTrack = computed(() => (props.video.media?.audioTracks.length ?? 0) > 1)

async function submit() {
  const h = props.highlight
  if (!h || submitting.value) return
  const body: CreateClipBody = { layout: layout.value, burnSubtitles: burnSubtitles.value }
  submitting.value = true
  try {
    const clip = await apiFetch<Clip>(`/api/highlights/${encodeURIComponent(h.id)}/clips`, { method: 'POST', body })
    emit('created', clip)
    notify.success('已加入輸出佇列', '完成後可以在「剪輯」預覽與下載。')
    open.value = false
  }
  catch (err) {
    notify.error(err, '無法開始輸出')
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="輸出剪輯"
    :description="highlight ? `${formatTime(highlight.start)} – ${formatTime(highlight.end)}（${formatSpan(highlight.end - highlight.start)}）` : undefined"
    :dismissible="!submitting"
    :ui="{ content: 'sm:max-w-2xl', footer: 'justify-end' }"
  >
    <template #body>
      <div class="space-y-6">
        <fieldset>
          <legend class="mb-2 text-sm font-medium text-highlighted">
            版型
          </legend>
          <div class="grid gap-3 sm:grid-cols-3">
            <label
              v-for="l in LAYOUTS"
              :key="l"
              class="relative flex cursor-pointer flex-col gap-2 rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary"
              :class="layout === l ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-default hover:bg-elevated/50'"
            >
              <input v-model="layout" type="radio" name="clip-layout" :value="l" class="sr-only">
              <span class="flex h-20 items-center justify-center rounded-md bg-elevated/70 text-toned">
                <LayoutSchematic :layout="l" class="h-16 w-auto" />
              </span>
              <span class="flex items-center gap-1.5">
                <span class="font-medium text-highlighted">{{ layoutLabels[l] }}</span>
                <UBadge v-if="l === 'blurred-background'" label="預設" size="xs" color="neutral" variant="soft" />
                <UIcon v-if="layout === l" name="i-lucide-circle-check" class="ml-auto size-4 text-primary" />
              </span>
              <span class="text-xs leading-relaxed text-muted">{{ layoutDescriptions[l] }}</span>
            </label>
          </div>
        </fieldset>

        <USwitch
          v-model="burnSubtitles"
          label="燒錄字幕"
          description="把逐字稿字幕直接燒進畫面（大字、白字黑邊、置中偏下）。不論是否燒錄，都會另外產生一個 .srt 字幕檔。"
        />

        <ul class="space-y-1.5 text-xs text-muted">
          <li v-if="overShorts && layout !== 'original'" class="flex gap-1.5 text-warning">
            <UIcon name="i-lucide-triangle-alert" class="mt-px size-3.5 shrink-0" />{{ SHORTS_WARNING }}
          </li>
          <li class="flex gap-1.5">
            <UIcon name="i-lucide-captions" class="mt-px size-3.5 shrink-0" />字幕使用目前的逐字稿；之後再修改逐字稿或起訖點，不會影響這支剪輯。
          </li>
          <li v-if="multiTrack" class="flex gap-1.5">
            <UIcon name="i-lucide-audio-lines" class="mt-px size-3.5 shrink-0" />剪輯的聲音使用音軌 1（完整混音）。
          </li>
          <li class="flex gap-1.5">
            <UIcon name="i-lucide-list-video" class="mt-px size-3.5 shrink-0" />輸出會排隊進行，一次一支；可以關掉頁面，稍後再回來下載。
          </li>
        </ul>
      </div>
    </template>

    <template #footer="{ close }">
      <UButton label="取消" color="neutral" variant="ghost" :disabled="submitting" @click="close" />
      <UButton label="開始輸出" icon="i-lucide-scissors" :loading="submitting" :disabled="!highlight" @click="submit" />
    </template>
  </UModal>
</template>
