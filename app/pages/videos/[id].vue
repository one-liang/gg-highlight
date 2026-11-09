<script setup lang="ts">
import type { AnalysisMode, Highlight, SourceVideo } from '~~/shared/types/domain'
import {
  analysisDoneNotice,
  analysisFailedTitle,
  canReanalyze,
  countCandidates,
  failedRunFootnote,
  isFailedRerun,
  isTranscriptReady,
  missingFileNextStep,
  needsHighlightsUpgrade,
} from '~/utils/analysis'
import { formatFps, formatResolution } from '~/utils/format'
import { isAnalysisActive, languageLabels } from '~/utils/labels'
import { formatDuration } from '~/utils/time'

const route = useRoute()
const notify = useNotify()

const id = computed(() => String(route.params.id ?? ''))
const { data: video, error, loaded, loading, refresh, set } = useApiData<SourceVideo>(
  () => (id.value ? `/api/videos/${encodeURIComponent(id.value)}` : null),
  '讀取影片失敗',
)

usePolling(refresh, () => !!video.value && isAnalysisActive(video.value))

/** Bumped when a run finishes, so a workspace that stayed open (highlights-only run) reloads its Highlights. */
const highlightsRefreshKey = ref(0)

async function countFoundCandidates(videoId: string): Promise<number | null> {
  try {
    const list = await apiFetch<Highlight[]>(`/api/videos/${encodeURIComponent(videoId)}/highlights`)
    return Array.isArray(list) ? countCandidates(list) : null
  }
  catch {
    return null
  }
}

// tell the user when the analysis they are watching finishes, with how many candidates it found
watch(() => video.value?.analysis.status, async (now, before) => {
  if (before !== 'queued' && before !== 'running') return
  const current = video.value
  if (!current) return
  const mode = current.analysis.mode
  if (now === 'done') {
    highlightsRefreshKey.value++
    const notice = analysisDoneNotice(mode, await countFoundCandidates(current.id))
    notify.success(notice.title, notice.description)
  }
  else if (now === 'failed') {
    notify.message(analysisFailedTitle(current.analysis), current.analysis.error ?? undefined)
  }
})
useHead({ title: () => video.value?.title ?? '影片' })

const transcriptReady = computed(() => !!video.value && isTranscriptReady(video.value))

const retrying = ref(false)
async function retry() {
  if (!video.value) return
  retrying.value = true
  try {
    set(await apiFetch<SourceVideo>(`/api/videos/${encodeURIComponent(video.value.id)}/retry`, { method: 'POST' }))
    notify.success('已重新排隊分析')
  }
  catch (err) {
    notify.error(err, '無法重試分析')
  }
  finally {
    retrying.value = false
  }
}

const reanalyzeOpen = ref(false)
const reanalyzePreset = ref<AnalysisMode | null>(null)
const { pending: reanalyzing, start: startReanalyze } = useReanalyze()

function openReanalyze(preset: AnalysisMode | null = null) {
  reanalyzePreset.value = preset
  reanalyzeOpen.value = true
}

/** 「找精華片段」 on the old-video banner: keeps the Transcript, so it needs no confirmation. */
async function findHighlights() {
  if (!video.value) return
  const queued = await startReanalyze(video.value.id, 'highlights')
  if (queued) set(queued)
}

function onReanalyzeStarted(queued: SourceVideo) {
  set(queued)
}

const deleteOpen = ref(false)
function onDeleted() {
  void navigateTo('/')
}
</script>

<template>
  <div class="mx-auto w-full max-w-[1600px] px-4 py-4 sm:px-6 sm:py-5">
    <UButton to="/" label="影片庫" icon="i-lucide-arrow-left" color="neutral" variant="link" size="sm" class="-ml-2.5 mb-2" />

    <div v-if="!loaded" class="space-y-4">
      <USkeleton class="h-8 w-2/3 max-w-xl" />
      <USkeleton class="h-4 w-1/2 max-w-md" />
      <USkeleton class="aspect-video w-full max-w-4xl rounded-lg" />
    </div>

    <UEmpty
      v-else-if="!video && error?.status === 404"
      icon="i-lucide-file-question"
      title="找不到這支影片"
      description="它可能已經從影片庫移除了。"
      variant="subtle"
      class="py-16"
      :actions="[{ label: '回到影片庫', icon: 'i-lucide-library', to: '/' }]"
    />

    <UAlert
      v-else-if="!video"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="無法讀取這支影片"
      :description="error?.message ?? '發生未知錯誤'"
      :actions="[{ label: '重試', icon: 'i-lucide-refresh-cw', color: 'error', variant: 'outline', loading, onClick: refresh }]"
    />

    <template v-else>
      <header class="mb-5 flex flex-wrap items-start gap-3">
        <div class="min-w-0 flex-1">
          <h1 class="text-xl font-semibold break-all text-highlighted sm:text-2xl">
            {{ video.title }}
          </h1>
          <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted">
            <AnalysisStatusBadge :analysis="video.analysis" />
            <SourceKindBadge :kind="video.sourceKind" />
            <span v-if="video.media" class="tabular-nums">{{ formatDuration(video.media.durationSec) }}</span>
            <span v-if="video.media" class="tabular-nums">
              {{ formatResolution(video.media.width, video.media.height) }}<template v-if="formatFps(video.media.fps)">・{{ formatFps(video.media.fps) }}</template>
            </span>
            <span>{{ languageLabels[video.language] }}</span>
            <span v-if="video.media && video.media.audioTracks.length > 1">分析用音軌 {{ video.audioTrack + 1 }}</span>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <UButton
            v-if="canReanalyze(video)"
            label="重新分析"
            icon="i-lucide-refresh-cw"
            color="neutral"
            variant="outline"
            :disabled="!!reanalyzing"
            @click="openReanalyze()"
          />
          <UButton label="移除" icon="i-lucide-trash-2" color="neutral" variant="ghost" @click="deleteOpen = true" />
        </div>
      </header>

      <UAlert
        v-if="error"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :description="`無法更新狀態：${error.message}`"
        class="mb-5"
      />

      <UAlert
        v-if="video.fileMissing"
        color="warning"
        variant="subtle"
        icon="i-lucide-file-warning"
        title="找不到原始影片檔"
        class="mb-5"
        data-testid="file-missing"
      >
        <template #description>
          <p v-if="transcriptReady">
            原本的檔案可能被移動、改名或刪除，因此無法預覽，也無法輸出剪輯。逐字稿與精華片段仍然可以查看與修改。
          </p>
          <p v-else>
            原本的檔案可能被移動、改名或刪除，因此無法分析、預覽或輸出剪輯。
          </p>
          <p v-if="video.filePath" class="mt-1">
            原本的位置：<code class="break-all font-mono text-xs">{{ video.filePath }}</code>
          </p>
          <p class="mt-1">
            {{ missingFileNextStep(video) }}
          </p>
        </template>
      </UAlert>

      <UAlert
        v-if="needsHighlightsUpgrade(video)"
        color="primary"
        variant="subtle"
        icon="i-lucide-sparkles"
        title="這支影片分析時還沒有自動找精華"
        description="現在可以依音量與逐字稿（本機 AI）自動找出候選精華片段。「找精華片段」會保留逐字稿與你的修改；「重新分析全部」會重新辨識語音，順便套用新版的逐字稿清理。"
        class="mb-5"
        :actions="[
          { label: '找精華片段', icon: 'i-lucide-sparkles', color: 'primary', loading: reanalyzing === 'highlights', disabled: !!reanalyzing, onClick: findHighlights },
          { label: '重新分析全部', icon: 'i-lucide-refresh-cw', color: 'neutral', variant: 'outline', disabled: !!reanalyzing || video.fileMissing, onClick: () => openReanalyze('full') },
        ]"
      />

      <!-- a highlights-only run, or a failed full re-run, keeps the Transcript: show it above the workspace -->
      <template v-if="transcriptReady">
        <AnalysisProgressCard v-if="isAnalysisActive(video)" :video="video" class="mb-5" />
        <UAlert
          v-else-if="video.analysis.status === 'failed'"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-x"
          :title="analysisFailedTitle(video.analysis)"
          class="mb-5"
          data-testid="analysis-failed"
          :actions="[
            { label: '重試', icon: 'i-lucide-rotate-ccw', color: 'error', loading: retrying, onClick: retry },
            ...(isFailedRerun(video) ? [{ label: '重新分析…', icon: 'i-lucide-refresh-cw', color: 'neutral' as const, variant: 'outline' as const, disabled: !!reanalyzing, onClick: () => openReanalyze() }] : []),
          ]"
        >
          <template #description>
            <p>{{ video.analysis.error || '發生未知錯誤。' }}</p>
            <p v-for="line in failedRunFootnote(video)" :key="line" class="mt-1">
              {{ line }}
            </p>
          </template>
        </UAlert>
        <VideoWorkspace :key="video.id" :video="video" :highlights-refresh-key="highlightsRefreshKey" />
      </template>

      <AnalysisProgressCard v-else-if="isAnalysisActive(video)" :video="video" class="max-w-4xl" />

      <UAlert
        v-else-if="video.analysis.status === 'failed'"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-x"
        :title="analysisFailedTitle(video.analysis)"
        :description="video.analysis.error || '發生未知錯誤。'"
        class="max-w-4xl"
        :actions="[{ label: '重試', icon: 'i-lucide-rotate-ccw', color: 'error', loading: retrying, onClick: retry }]"
      />

      <ReanalyzeModal v-model:open="reanalyzeOpen" :video="video" :preset="reanalyzePreset" @started="onReanalyzeStarted" />
    </template>

    <DeleteVideoModal v-model:open="deleteOpen" :video="video" @deleted="onDeleted" />
  </div>
</template>
