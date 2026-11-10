<script setup lang="ts">
import type { YoutubeInfo, YoutubeProbeBody } from '~~/shared/types/domain'
import { apiErrorMessage } from '~/utils/api-error'
import { YOUTUBE_PROBE_LOADING_TEXT, YOUTUBE_URL_PLACEHOLDER, youtubeInputState } from '~/utils/youtube'

const emit = defineEmits<{ probed: [info: YoutubeInfo] }>()
/** The typed link; kept by the dialog so 「上一步」 from the preview shows it again. */
const url = defineModel<string>('url', { default: '' })

const input = computed(() => youtubeInputState(url.value))
const loading = ref(false)
const error = ref<string | null>(null)
let seq = 0
let mounted = true

watch(url, () => {
  error.value = null
})

async function probe() {
  const state = input.value
  if (state.kind !== 'valid' || loading.value) return
  const id = ++seq
  loading.value = true
  error.value = null
  try {
    const body: YoutubeProbeBody = { url: state.url }
    const info = await apiFetch<YoutubeInfo>('/api/youtube/probe', { method: 'POST', body })
    if (id !== seq || !mounted) return
    emit('probed', info)
  }
  catch (err) {
    if (id !== seq || !mounted) return
    error.value = apiErrorMessage(err, '無法讀取影片資訊')
  }
  finally {
    if (id === seq) loading.value = false
  }
}

onBeforeUnmount(() => {
  mounted = false
})
</script>

<template>
  <form class="space-y-4" novalidate @submit.prevent="probe">
    <UFormField
      label="YouTube 連結"
      name="youtube-url"
      :error="input.kind === 'invalid' ? input.message : undefined"
      help="貼上單一影片的連結（一般影片或直播重播），不支援播放清單或頻道。"
    >
      <div class="mt-1 flex flex-col gap-2 sm:flex-row">
        <UInput
          v-model="url"
          type="url"
          inputmode="url"
          autocomplete="off"
          spellcheck="false"
          icon="i-lucide-link"
          :placeholder="YOUTUBE_URL_PLACEHOLDER"
          :disabled="loading"
          class="min-w-0 flex-1"
          autofocus
          data-testid="youtube-url-input"
        />
        <UButton
          type="submit"
          label="讀取影片資訊"
          icon="i-lucide-search"
          :loading="loading"
          :disabled="input.kind !== 'valid'"
          class="justify-center"
          data-testid="youtube-probe-button"
        />
      </div>
    </UFormField>

    <p v-if="loading" class="flex items-center gap-1.5 text-sm text-muted" aria-live="polite">
      <UIcon name="i-lucide-loader-circle" class="size-4 shrink-0 animate-spin" />{{ YOUTUBE_PROBE_LOADING_TEXT }}
    </p>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="無法讀取影片資訊"
      :description="error"
      :actions="[{ label: '重試', icon: 'i-lucide-refresh-cw', color: 'error', variant: 'outline', onClick: probe }]"
      data-testid="youtube-probe-error"
    />

    <p class="flex gap-1.5 text-xs text-dimmed">
      <UIcon name="i-lucide-info" class="mt-0.5 size-3.5 shrink-0" />
      <span>影片檔在分析的第一步才下載（最高 1080p）。不支援私人影片、會員限定影片與需要登入才能看的影片；不公開的影片可以。</span>
    </p>
  </form>
</template>
