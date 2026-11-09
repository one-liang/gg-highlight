<script setup lang="ts">
import type { Clip, ClipStatus, Highlight, SourceVideo, TranscriptSegment } from '~~/shared/types/domain'
import type { HighlightEditDraft } from '~/types/highlight-edit'
import { videoMediaUrl } from '~/utils/api-urls'
import { goneHighlightRefs, sortHighlights, upsertHighlight, validRange } from '~/utils/highlights'
import { isAnalysisActive, isClipActive, layoutLabels } from '~/utils/labels'
import { formatTime } from '~/utils/time'
import { replaceSegment } from '~/utils/transcript'

const props = defineProps<{
  video: SourceVideo
  /** Changes when an Analysis finished while this workspace stayed open (highlights-only run): reload the Highlights. */
  highlightsRefreshKey?: number
}>()

const base = computed(() => `/api/videos/${encodeURIComponent(props.video.id)}`)
const transcript = useApiData<TranscriptSegment[]>(() => `${base.value}/transcript`, '讀取逐字稿失敗')
const highlightsRes = useApiData<Highlight[]>(() => `${base.value}/highlights`, '讀取精華片段失敗')
const clipsRes = useApiData<Clip[]>(() => `${base.value}/clips`, '讀取剪輯失敗')

const segments = computed(() => transcript.data.value ?? [])
const highlights = computed(() => sortHighlights(highlightsRes.data.value ?? []))
const clips = computed(() => clipsRes.data.value ?? [])
usePolling(clipsRes.refresh, () => clips.value.some(isClipActive))
watch(() => props.highlightsRefreshKey, () => void highlightsRes.refresh())

const notify = useNotify()
let lastClipStatus = new Map<string, ClipStatus>()
watch(clips, (list) => {
  for (const c of list) {
    const before = lastClipStatus.get(c.id)
    if (before !== 'queued' && before !== 'running') continue
    if (c.status === 'done') notify.success('剪輯輸出完成', `${layoutLabels[c.layout]}・${formatTime(c.start)} – ${formatTime(c.end)}`)
    else if (c.status === 'failed') notify.message('剪輯輸出失敗', c.error ?? undefined)
  }
  lastClipStatus = new Map(list.map(c => [c.id, c.status]))
})

const videoEl = useTemplateRef<HTMLVideoElement>('video')
const player = createPlayer(videoEl)
providePlayer(player)
const { mediaError } = player

const duration = computed(() => props.video.media?.durationSec ?? 0)
const canPreview = computed(() => !props.video.fileMissing)
const mediaUrl = computed(() => videoMediaUrl(props.video.id))
const sourceAspect = computed(() => {
  const m = props.video.media
  return m && m.width > 0 && m.height > 0 ? m.width / m.height : 16 / 9
})

// Range being created, the Highlight being adjusted, and the last one the user touched.
const draft = reactive<{ start: number | null, end: number | null }>({ start: null, end: null })
const editing = ref<HighlightEditDraft | null>(null)
const focusedId = ref<string | null>(null)

const draftRange = computed(() => validRange(draft.start, draft.end))
const editRange = computed(() => (editing.value ? validRange(editing.value.start, editing.value.end) : null))
const markRange = computed(() => {
  if (editRange.value) return editRange.value
  if (draftRange.value) return draftRange.value
  const focused = highlights.value.find(h => h.id === focusedId.value)
  return focused ? { start: focused.start, end: focused.end } : null
})

const clipCounts = computed(() => {
  const counts: Record<string, number> = {}
  for (const c of clips.value) counts[c.highlightId] = (counts[c.highlightId] ?? 0) + 1
  return counts
})

function onHighlightSaved(h: Highlight) {
  highlightsRes.set(upsertHighlight(highlightsRes.data.value ?? [], h))
}

function onHighlightCreated(h: Highlight) {
  onHighlightSaved(h)
  focusedId.value = h.id
}

function playHighlight(h: Highlight, stopAtEnd: boolean) {
  focusedId.value = h.id
  player.playRange(h.start, h.end, h.id, stopAtEnd)
}

const exportOpen = ref(false)
const exportTarget = shallowRef<Highlight | null>(null)

function openExport(h: Highlight) {
  focusedId.value = h.id
  exportTarget.value = h
  exportOpen.value = true
}

// A highlights-only run replaces the candidates nobody picked, which may be the one being adjusted or
// exported: let go of it, or every 調整 stays locked and the export would answer 404.
watch(highlights, (list) => {
  if (!highlightsRes.loaded.value) return
  const gone = goneHighlightRefs(list, {
    editing: editing.value?.id ?? null,
    exporting: exportOpen.value ? exportTarget.value?.id ?? null : null,
    focused: focusedId.value,
  })
  if (gone.editing) editing.value = null
  if (gone.exporting) {
    exportOpen.value = false
    exportTarget.value = null
  }
  if (gone.focused) focusedId.value = null
  if (gone.editing || gone.exporting) notify.message('這個候選已被新的分析結果取代')
})

function onClipCreated(clip: Clip) {
  clipsRes.set([clip, ...clips.value.filter(c => c.id !== clip.id)])
}

function onSegmentUpdated(seg: TranscriptSegment) {
  transcript.set(replaceSegment(segments.value, seg))
}
</script>

<template>
  <!-- narrow: player → transcript → editing; wide: transcript is a sticky right column -->
  <div class="grid items-start gap-x-6 gap-y-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)] lg:grid-rows-[auto_1fr] xl:grid-cols-[minmax(0,1fr)_440px]">
    <section aria-label="預覽" class="min-w-0 lg:col-start-1 lg:row-start-1">
      <div class="relative aspect-video max-h-[62vh] w-full overflow-hidden rounded-lg bg-black">
        <video
          v-if="canPreview"
          ref="video"
          :src="mediaUrl"
          controls
          preload="metadata"
          playsinline
          class="size-full object-contain"
          @play="player.handlers.onPlay"
          @pause="player.handlers.onPause"
          @timeupdate="player.handlers.onTimeupdate"
          @seeked="player.handlers.onSeeked"
          @loadedmetadata="player.handlers.onLoadedmetadata"
          @error="player.handlers.onError"
        />
        <div v-else class="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-white/80">
          <UIcon name="i-lucide-video-off" class="size-8" />
          <p class="font-medium">
            找不到原始影片檔，無法預覽
          </p>
        </div>
        <div
          v-if="canPreview && mediaError"
          class="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center gap-2 bg-black/70 px-4 py-2 text-sm text-white"
        >
          <UIcon name="i-lucide-circle-alert" class="size-4 shrink-0" />{{ mediaError }}
        </div>
      </div>

      <VideoTimeline
        class="mt-4"
        :duration="duration"
        :highlights="highlights"
        :draft-range="draftRange"
        :edit-range="editRange"
        :editing-id="editing?.id ?? null"
        :focused-id="focusedId"
      />
    </section>

    <aside class="h-[70vh] min-h-[420px] lg:sticky lg:top-[4.5rem] lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:h-[calc(100dvh-5.5rem)]">
      <TranscriptPanel
        :video-id="video.id"
        :segments="segments"
        :loaded="transcript.loaded.value"
        :error="transcript.error.value?.message ?? null"
        :mark-range="markRange"
        @updated="onSegmentUpdated"
        @retry="transcript.refresh"
      />
    </aside>

    <div class="min-w-0 space-y-5 lg:col-start-1 lg:row-start-2">
      <HighlightCreator
        v-model:start="draft.start"
        v-model:end="draft.end"
        :video-id="video.id"
        :duration="duration"
        @created="onHighlightCreated"
      />

      <HighlightList
        v-model:editing="editing"
        :highlights="highlights"
        :duration="duration"
        :loaded="highlightsRes.loaded.value"
        :error="highlightsRes.error.value?.message ?? null"
        :can-preview="canPreview"
        :focused-id="focusedId"
        :clip-counts="clipCounts"
        :signals="video.analysis.signals ?? null"
        :analysis-active="isAnalysisActive(video)"
        @play="playHighlight"
        @export="openExport"
        @saved="onHighlightSaved"
        @focus="h => (focusedId = h.id)"
        @retry="highlightsRes.refresh"
      />

      <ClipList
        :clips="clips"
        :loaded="clipsRes.loaded.value"
        :error="clipsRes.error.value?.message ?? null"
        :source-aspect="sourceAspect"
        @retry="clipsRes.refresh"
      />
    </div>

    <ExportClipModal v-model:open="exportOpen" :highlight="exportTarget" :video="video" @created="onClipCreated" />
  </div>
</template>
