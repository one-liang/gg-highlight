<script setup lang="ts">
import type { Clip } from '~~/shared/types/domain'
import { clipFileUrl, clipSrtUrl } from '~/utils/api-urls'
import { formatDateTime, formatPercent, progressPercent } from '~/utils/format'
import { clipStatusColors, clipStatusLabels, layoutLabels } from '~/utils/labels'
import { formatSpan, formatTime } from '~/utils/time'

const props = defineProps<{
  clip: Clip
  /** Source width / height, for sizing "original" layout previews. */
  sourceAspect: number
}>()

const portrait = computed(() => props.clip.layout !== 'original' || props.sourceAspect < 1)
const previewStyle = computed(() => (props.clip.layout === 'original' && props.sourceAspect > 0
  ? { aspectRatio: String(props.sourceAspect) }
  : { aspectRatio: '9 / 16' }))
</script>

<template>
  <li
    class="flex gap-3 rounded-lg border border-default p-3"
    :class="clip.status === 'done' && clip.hasFile ? 'flex-col sm:flex-row' : 'flex-row'"
  >
    <div
      v-if="clip.status === 'done' && clip.hasFile"
      class="shrink-0"
      :class="portrait ? 'w-32' : 'w-full sm:w-64'"
    >
      <video
        :src="clipFileUrl(clip.id)"
        controls
        preload="metadata"
        playsinline
        class="w-full rounded-md bg-black object-contain"
        :style="previewStyle"
      />
    </div>
    <div v-else class="flex size-12 shrink-0 items-center justify-center rounded-md bg-elevated text-dimmed">
      <UIcon v-if="clip.status === 'failed'" name="i-lucide-video-off" class="size-5 text-error" />
      <UIcon v-else-if="clip.status === 'running'" name="i-lucide-loader-circle" class="size-5 animate-spin text-primary" />
      <UIcon v-else-if="clip.status === 'queued'" name="i-lucide-hourglass" class="size-5" />
      <UIcon v-else name="i-lucide-file-x" class="size-5" />
    </div>

    <div class="min-w-0 flex-1 space-y-2">
      <div class="flex flex-wrap items-center gap-2">
        <UBadge :label="layoutLabels[clip.layout]" color="neutral" variant="subtle" size="sm" />
        <span class="font-mono text-sm tabular-nums text-highlighted">{{ formatTime(clip.start) }} – {{ formatTime(clip.end) }}</span>
        <span class="text-sm tabular-nums text-muted">{{ formatSpan(clip.end - clip.start) }}</span>
        <UBadge
          :label="clipStatusLabels[clip.status]"
          :color="clipStatusColors[clip.status]"
          variant="subtle"
          size="sm"
          class="ml-auto"
        />
      </div>

      <p class="text-xs text-muted">
        {{ clip.burnSubtitles ? '已燒錄字幕' : '未燒錄字幕' }}・輸出於 {{ formatDateTime(clip.createdAt) }}
      </p>

      <div v-if="clip.status === 'running'" class="max-w-sm">
        <div class="mb-1 flex justify-between text-xs">
          <span class="text-toned">輸出中</span>
          <span class="tabular-nums text-muted">{{ formatPercent(clip.progress) }}</span>
        </div>
        <UProgress :model-value="progressPercent(clip.progress)" size="xs" />
      </div>
      <p v-else-if="clip.status === 'queued'" class="text-xs text-dimmed">
        等待前面的剪輯輸出完成（一次輸出一支）
      </p>
      <p v-else-if="clip.status === 'failed'" class="text-sm text-error">
        {{ clip.error || '輸出失敗' }}
      </p>

      <div v-if="clip.status === 'done'" class="flex flex-wrap gap-2 pt-1">
        <UButton
          :to="clip.hasFile ? clipFileUrl(clip.id, true) : undefined"
          external
          download
          label="下載影片"
          icon="i-lucide-download"
          size="xs"
          :disabled="!clip.hasFile"
        />
        <UButton
          :to="clip.hasSrt ? clipSrtUrl(clip.id) : undefined"
          external
          download
          label="下載字幕"
          icon="i-lucide-captions"
          size="xs"
          color="neutral"
          variant="outline"
          :disabled="!clip.hasSrt"
        />
      </div>
      <p v-if="clip.status === 'done' && !clip.hasFile" class="text-xs text-warning">
        找不到剪輯檔案，可能已被刪除。
      </p>
    </div>
  </li>
</template>
