<script setup lang="ts">
import type { SourceVideo } from '~~/shared/types/domain'
import { analysisStepLabel, languageLabels, missingFileLabel, showsMissingFileLine } from '~/utils/labels'
import { formatDateTime, formatPercent, formatResolution, progressPercent } from '~/utils/format'
import { formatDuration } from '~/utils/time'
import { videoDurationSec, youtubeWatchUrl } from '~/utils/youtube'

const props = defineProps<{ video: SourceVideo }>()
const emit = defineEmits<{ delete: [video: SourceVideo] }>()

const analysis = computed(() => props.video.analysis)
const to = computed(() => `/videos/${encodeURIComponent(props.video.id)}`)
const duration = computed(() => videoDurationSec(props.video))
const watchUrl = computed(() => youtubeWatchUrl(props.video))
</script>

<template>
  <li
    class="group relative flex items-start gap-3 rounded-lg border border-default bg-default px-4 py-3 transition-colors hover:border-accented hover:bg-elevated/40 focus-within:ring-2 focus-within:ring-primary sm:gap-4"
  >
    <div class="mt-0.5 hidden size-10 shrink-0 items-center justify-center rounded-md bg-elevated text-muted sm:flex">
      <UIcon name="i-lucide-film" class="size-5" />
    </div>

    <div class="min-w-0 flex-1">
      <div class="flex min-w-0 items-center gap-2">
        <NuxtLink
          :to="to"
          class="truncate font-medium text-highlighted after:absolute after:inset-0 after:rounded-lg focus:outline-none"
          :title="video.title"
        >
          {{ video.title }}
        </NuxtLink>
        <SourceKindBadge :kind="video.sourceKind" class="shrink-0" />
      </div>

      <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-muted">
        <span v-if="duration !== null" class="inline-flex items-center gap-1 tabular-nums">
          <UIcon name="i-lucide-clock" class="size-3.5" />{{ formatDuration(duration) }}
        </span>
        <span v-if="video.media" class="tabular-nums">{{ formatResolution(video.media.width, video.media.height) }}</span>
        <span v-if="video.youtube?.channel" class="inline-flex min-w-0 items-center gap-1">
          <UIcon name="i-lucide-tv" class="size-3.5 shrink-0" /><span class="truncate">{{ video.youtube.channel }}</span>
        </span>
        <span>{{ languageLabels[video.language] }}</span>
        <span class="tabular-nums">加入於 {{ formatDateTime(video.createdAt) }}</span>
      </div>

      <div v-if="analysis.status === 'running'" class="mt-2 max-w-md">
        <div class="mb-1 flex items-center justify-between text-xs">
          <span class="text-toned">{{ analysisStepLabel(analysis.step, video.sourceKind) || '分析中' }}</span>
          <span class="tabular-nums text-muted">{{ formatPercent(analysis.progress) }}</span>
        </div>
        <UProgress :model-value="progressPercent(analysis.progress)" size="xs" />
      </div>
      <p v-else-if="analysis.status === 'queued'" class="mt-1.5 text-xs text-dimmed">
        等待前面的影片分析完成（一次只分析一支）
      </p>
      <p v-else-if="analysis.status === 'failed'" class="mt-1.5 line-clamp-2 text-sm text-error">
        {{ analysis.error || '分析失敗，請到影片頁重試。' }}
      </p>

      <p v-if="showsMissingFileLine(video)" class="mt-1.5 flex items-center gap-1 text-sm text-warning">
        <UIcon name="i-lucide-triangle-alert" class="size-4 shrink-0" />
        {{ missingFileLabel(video) }}
      </p>
    </div>

    <div class="relative z-10 flex shrink-0 items-center gap-1 sm:gap-2">
      <AnalysisStatusBadge :analysis="analysis" />
      <UTooltip v-if="watchUrl" text="在 YouTube 開啟">
        <UButton
          :to="watchUrl"
          target="_blank"
          rel="noopener noreferrer"
          external
          icon="i-lucide-external-link"
          color="neutral"
          variant="ghost"
          size="sm"
          aria-label="在 YouTube 開啟"
        />
      </UTooltip>
      <UTooltip text="從影片庫移除">
        <UButton
          icon="i-lucide-trash-2"
          color="neutral"
          variant="ghost"
          size="sm"
          aria-label="從影片庫移除"
          @click="emit('delete', video)"
        />
      </UTooltip>
    </div>
  </li>
</template>
