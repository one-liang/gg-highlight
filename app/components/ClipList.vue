<script setup lang="ts">
import type { Clip } from '~~/shared/types/domain'

defineProps<{
  clips: Clip[]
  loaded: boolean
  error: string | null
  sourceAspect: number
}>()

const emit = defineEmits<{ retry: [] }>()
</script>

<template>
  <section class="rounded-lg border border-default p-4">
    <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="font-semibold text-highlighted">
        剪輯
        <span v-if="clips.length" class="ml-1 text-sm font-normal text-muted">{{ clips.length }}</span>
      </h2>
      <p class="text-xs text-dimmed">
        每次輸出都是一支新剪輯，新的在前
      </p>
    </div>

    <div v-if="!loaded" class="space-y-2">
      <USkeleton class="h-24 w-full" />
    </div>

    <UAlert
      v-else-if="error && !clips.length"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="無法讀取剪輯"
      :description="error"
      :actions="[{ label: '重試', icon: 'i-lucide-refresh-cw', color: 'error', variant: 'outline', onClick: () => emit('retry') }]"
    />

    <UEmpty
      v-else-if="!clips.length"
      icon="i-lucide-clapperboard"
      title="還沒有輸出的剪輯"
      description="在精華片段按「輸出」，選好版型就會開始製作。"
      variant="naked"
      size="sm"
    />

    <ul v-else class="space-y-2">
      <ClipItem v-for="clip in clips" :key="clip.id" :clip="clip" :source-aspect="sourceAspect" />
    </ul>
  </section>
</template>
