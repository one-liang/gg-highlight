<script setup lang="ts">
import type { Highlight, HighlightStatus } from '~~/shared/types/domain'
import { formatDuration, formatTime } from '~/utils/time'
import { buildTicks, clampNumber, pointerToTime, rangeStyle, timeToPercent } from '~/utils/timeline'

interface Range { start: number, end: number }

const props = defineProps<{
  duration: number
  highlights: Highlight[]
  /** Range being created (起點／終點 inputs). */
  draftRange: Range | null
  /** Range of the Highlight being adjusted. */
  editRange: Range | null
  editingId: string | null
  focusedId: string | null
}>()

const player = usePlayer()
const track = useTemplateRef<HTMLDivElement>('track')
const width = ref(800)
const hoverTime = ref<number | null>(null)
const dragging = ref(false)
let resizeObserver: ResizeObserver | null = null
let pendingSeek: number | null = null
let seekFrame = 0

onMounted(() => {
  if (!track.value) return
  width.value = track.value.clientWidth
  resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[0]
    if (entry) width.value = entry.contentRect.width
  })
  resizeObserver.observe(track.value)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  if (seekFrame) cancelAnimationFrame(seekFrame)
})

const ticks = computed(() => buildTicks(props.duration, Math.max(2, Math.floor(width.value / 90))).map((t) => {
  const pct = timeToPercent(t, props.duration)
  return { t, pct, align: pct < 3 ? 'translate-x-0' : pct > 97 ? '-translate-x-full' : '-translate-x-1/2' }
}))

const STATUS_CLASS: Record<HighlightStatus, string> = {
  selected: 'bg-primary',
  candidate: 'bg-primary/25 ring-1 ring-inset ring-primary/60',
  dismissed: 'tl-striped ring-1 ring-inset ring-accented',
}

const blocks = computed(() => props.highlights
  .filter(h => h.id !== props.editingId)
  .map(h => ({
    id: h.id,
    style: rangeStyle(h.start, h.end, props.duration),
    cls: STATUS_CLASS[h.status],
    focused: h.id === props.focusedId,
  })))

const playheadPct = computed(() => timeToPercent(player.currentTime.value, props.duration))
const hoverPct = computed(() => (hoverTime.value === null ? 0 : timeToPercent(hoverTime.value, props.duration)))

function timeAt(e: PointerEvent): number {
  const rect = track.value?.getBoundingClientRect()
  return rect ? pointerToTime(e.clientX, rect.left, rect.width, props.duration) : 0
}

// coalesce drag seeks to one per frame; seeking is expensive for the decoder
function seekSoon(t: number) {
  pendingSeek = t
  if (seekFrame) return
  seekFrame = requestAnimationFrame(() => {
    seekFrame = 0
    if (pendingSeek !== null) player.seek(pendingSeek)
    pendingSeek = null
  })
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0 || !(props.duration > 0)) return
  dragging.value = true
  track.value?.setPointerCapture(e.pointerId)
  player.stopRange()
  seekSoon(timeAt(e))
}

function onPointerMove(e: PointerEvent) {
  const t = timeAt(e)
  hoverTime.value = t
  if (dragging.value) seekSoon(t)
}

function onPointerUp(e: PointerEvent) {
  if (!dragging.value) return
  dragging.value = false
  if (track.value?.hasPointerCapture(e.pointerId)) track.value.releasePointerCapture(e.pointerId)
}

function onPointerLeave() {
  if (!dragging.value) hoverTime.value = null
}

function onKeydown(e: KeyboardEvent) {
  const step = e.shiftKey ? 5 : 1
  let t: number | null = null
  if (e.key === 'ArrowLeft') t = player.currentTime.value - step
  else if (e.key === 'ArrowRight') t = player.currentTime.value + step
  else if (e.key === 'Home') t = 0
  else if (e.key === 'End') t = props.duration
  if (t === null) return
  e.preventDefault()
  player.stopRange()
  player.seek(clampNumber(t, 0, props.duration))
}
</script>

<template>
  <div>
    <div
      ref="track"
      class="relative h-10 cursor-pointer touch-none select-none rounded-md bg-elevated ring ring-inset ring-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      role="slider"
      tabindex="0"
      aria-label="時間軸"
      :aria-valuemin="0"
      :aria-valuemax="Math.round(duration)"
      :aria-valuenow="Math.round(player.currentTime.value)"
      :aria-valuetext="formatTime(player.currentTime.value)"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @pointerleave="onPointerLeave"
      @keydown="onKeydown"
    >
      <div
        v-for="tick in ticks"
        :key="`g${tick.t}`"
        class="pointer-events-none absolute inset-y-0 w-px bg-border"
        :style="{ left: `${tick.pct}%` }"
      />

      <div
        v-for="b in blocks"
        :key="b.id"
        class="pointer-events-none absolute inset-y-1.5 min-w-[3px] rounded-sm"
        :class="[b.cls, b.focused ? 'outline-2 outline-offset-1 outline-primary' : '']"
        :style="b.style"
      />

      <div
        v-if="editRange"
        class="pointer-events-none absolute inset-y-0.5 min-w-[3px] rounded-sm border-2 border-dashed border-info bg-info/20"
        :style="rangeStyle(editRange.start, editRange.end, duration)"
      />
      <div
        v-if="draftRange"
        class="pointer-events-none absolute inset-y-0.5 min-w-[3px] rounded-sm border-2 border-dashed border-warning bg-warning/20"
        :style="rangeStyle(draftRange.start, draftRange.end, duration)"
      />

      <div
        v-if="hoverTime !== null"
        class="pointer-events-none absolute inset-y-0 w-px bg-inverted/40"
        :style="{ left: `${hoverPct}%` }"
      />

      <div
        class="pointer-events-none absolute -inset-y-1 w-0.5 -translate-x-1/2 bg-error"
        :style="{ left: `${playheadPct}%` }"
      >
        <span class="absolute -top-1 left-1/2 size-2.5 -translate-x-1/2 rounded-full bg-error" />
      </div>
    </div>

    <div class="relative mt-1 h-4 text-[11px] tabular-nums text-dimmed">
      <span
        v-for="tick in ticks"
        :key="`l${tick.t}`"
        class="absolute"
        :class="tick.align"
        :style="{ left: `${tick.pct}%` }"
      >{{ formatDuration(tick.t) }}</span>
      <span
        v-if="hoverTime !== null"
        class="absolute z-10 -translate-x-1/2 rounded bg-inverted px-1.5 font-mono text-inverted"
        :style="{ left: `${clampNumber(hoverPct, 3, 97)}%` }"
      >{{ formatTime(hoverTime) }}</span>
    </div>

    <div class="mt-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
      <span class="font-mono tabular-nums text-highlighted">
        {{ formatTime(player.currentTime.value) }}
        <span class="text-dimmed">/ {{ formatTime(duration) }}</span>
      </span>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted">
        <span class="flex items-center gap-1.5"><span class="h-2.5 w-4 rounded-sm bg-primary" />選用</span>
        <span class="flex items-center gap-1.5"><span class="h-2.5 w-4 rounded-sm bg-primary/25 ring-1 ring-inset ring-primary/60" />候選</span>
        <span class="flex items-center gap-1.5"><span class="tl-striped h-2.5 w-4 rounded-sm ring-1 ring-inset ring-accented" />捨棄</span>
        <span class="flex items-center gap-1.5"><span class="h-2.5 w-4 rounded-sm border-2 border-dashed border-warning bg-warning/20" />新增中</span>
      </div>
    </div>
  </div>
</template>
