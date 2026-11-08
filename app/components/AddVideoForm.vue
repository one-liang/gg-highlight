<script setup lang="ts">
import type { AddVideoBody, Language, MediaInfo, SourceVideo } from '~~/shared/types/domain'
import type { PickedSource } from '~/types/picked-source'
import { apiErrorMessage } from '~/utils/api-error'
import { formatBytes, formatDateTime, formatFps, formatResolution } from '~/utils/format'
import { audioTrackLabel, languageLabels } from '~/utils/labels'
import { formatDuration } from '~/utils/time'

const props = defineProps<{ picked: PickedSource }>()
const emit = defineEmits<{
  back: []
  added: [video: SourceVideo]
}>()

const notify = useNotify()

const media = shallowRef<MediaInfo | null>(props.picked.kind === 'upload' ? props.picked.upload.media : null)
const probing = ref(false)
const probeError = ref<string | null>(null)
const language = ref<Language>('zh')
const audioTrack = ref(0)
const submitting = ref(false)

const fileName = computed(() => (props.picked.kind === 'upload' ? props.picked.upload.fileName : props.picked.file.name))

const languageItems = [
  { label: languageLabels.zh, value: 'zh', description: '台灣中文或中英夾雜，用 Breeze-ASR-25 辨識，並轉成台灣正體' },
  { label: languageLabels.en, value: 'en', description: '英文影片，用 Whisper large-v3-turbo 辨識' },
]

const trackItems = computed(() => (media.value?.audioTracks ?? []).map(t => ({ label: audioTrackLabel(t), value: t.index })))
const hasAudio = computed(() => (media.value?.audioTracks.length ?? 0) > 0)

async function probe() {
  if (props.picked.kind !== 'watch-folder') return
  probing.value = true
  probeError.value = null
  try {
    media.value = await apiFetch<MediaInfo>('/api/probe', { method: 'POST', body: { filePath: props.picked.file.path } })
  }
  catch (err) {
    probeError.value = apiErrorMessage(err, '無法讀取影片資訊')
  }
  finally {
    probing.value = false
  }
}

watch(media, (m) => {
  const first = m?.audioTracks[0]
  audioTrack.value = first ? first.index : 0
}, { immediate: true })

onMounted(() => {
  void probe()
})

async function submit() {
  if (!media.value || submitting.value) return
  const body: AddVideoBody = props.picked.kind === 'watch-folder'
    ? { sourceKind: 'watch-folder', filePath: props.picked.file.path, language: language.value, audioTrack: audioTrack.value }
    : { sourceKind: 'upload', uploadId: props.picked.upload.uploadId, language: language.value, audioTrack: audioTrack.value }
  submitting.value = true
  try {
    const video = await apiFetch<SourceVideo>('/api/videos', { method: 'POST', body })
    notify.success('已加入影片庫', `「${video.title}」開始排隊分析。`)
    emit('added', video)
  }
  catch (err) {
    notify.error(err, '無法加入影片')
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="space-y-5">
    <div class="flex items-start gap-3 rounded-lg border border-default bg-elevated/40 p-3">
      <UIcon name="i-lucide-file-video" class="mt-0.5 size-5 shrink-0 text-primary" />
      <div class="min-w-0 flex-1">
        <p class="break-all font-medium text-highlighted">
          {{ fileName }}
        </p>
        <p v-if="picked.kind === 'watch-folder'" class="mt-0.5 break-all text-xs text-muted">
          <span class="font-mono">{{ picked.file.folder }}</span>・{{ formatBytes(picked.file.sizeBytes) }}・{{ formatDateTime(picked.file.modifiedAt) }}
        </p>
        <p v-else class="mt-0.5 text-xs text-muted">
          已上傳・{{ formatBytes(picked.sizeBytes) }}
        </p>
      </div>
      <SourceKindBadge :kind="picked.kind" class="shrink-0" />
    </div>

    <div v-if="probing" class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <USkeleton v-for="i in 4" :key="i" class="h-14" />
    </div>

    <UAlert
      v-else-if="probeError"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="無法讀取影片資訊"
      :description="probeError"
      :actions="[{ label: '重試', icon: 'i-lucide-refresh-cw', color: 'error', variant: 'outline', onClick: probe }]"
    />

    <template v-else-if="media">
      <dl class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div class="rounded-lg border border-default px-3 py-2">
          <dt class="text-xs text-muted">
            長度
          </dt>
          <dd class="font-medium tabular-nums text-highlighted">
            {{ formatDuration(media.durationSec) }}
          </dd>
        </div>
        <div class="rounded-lg border border-default px-3 py-2">
          <dt class="text-xs text-muted">
            解析度
          </dt>
          <dd class="font-medium tabular-nums text-highlighted">
            {{ formatResolution(media.width, media.height) }}
          </dd>
        </div>
        <div class="rounded-lg border border-default px-3 py-2">
          <dt class="text-xs text-muted">
            影格率
          </dt>
          <dd class="font-medium tabular-nums text-highlighted">
            {{ formatFps(media.fps) || '—' }}
          </dd>
        </div>
        <div class="rounded-lg border border-default px-3 py-2">
          <dt class="text-xs text-muted">
            編碼
          </dt>
          <dd class="truncate font-medium text-highlighted" :title="media.container">
            {{ media.videoCodec || '—' }}
          </dd>
        </div>
      </dl>

      <UFormField label="語言" description="影片裡主要說的語言，決定用哪個語音辨識模型。">
        <URadioGroup
          v-model="language"
          :items="languageItems"
          variant="card"
          orientation="horizontal"
          class="mt-1"
          :ui="{ fieldset: 'grid gap-2 sm:grid-cols-2', item: 'p-3' }"
        />
      </UFormField>

      <UFormField
        v-if="hasAudio"
        label="分析用音軌"
        description="只用在語音辨識。預覽與輸出的剪輯一律使用音軌 1（完整混音）。"
        help="OBS 若有把麥克風分軌，選只有麥克風的那一軌辨識會更準。"
      >
        <USelect v-model="audioTrack" :items="trackItems" class="mt-1 w-full" />
      </UFormField>

      <UAlert
        v-else
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="這支影片沒有音軌"
        description="沒有聲音就無法產生逐字稿，請換一支影片。"
      />
    </template>

    <div class="flex items-center justify-between gap-2 border-t border-default pt-4">
      <UButton label="上一步" icon="i-lucide-arrow-left" color="neutral" variant="ghost" :disabled="submitting" @click="emit('back')" />
      <UButton
        label="開始分析"
        icon="i-lucide-sparkles"
        :loading="submitting"
        :disabled="!media || !hasAudio || probing"
        @click="submit"
      />
    </div>
  </div>
</template>
