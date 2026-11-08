<script setup lang="ts">
import type { SourceVideo } from '~~/shared/types/domain'
import { progressPercent } from '~/utils/format'
import { analysisStepLabel, analysisStepLabels, analysisStepsFor, analysisStepState } from '~/utils/labels'

const props = defineProps<{ video: SourceVideo }>()

const analysis = computed(() => props.video.analysis)
const queued = computed(() => analysis.value.status === 'queued')
const percent = computed(() => progressPercent(analysis.value.progress))
const steps = computed(() => analysisStepsFor(props.video).map(step => ({
  step,
  label: analysisStepLabels[step],
  state: analysisStepState(step, analysis.value.step, analysis.value.status),
})))
const title = computed(() => {
  if (queued.value) return '排隊等待分析'
  const label = analysisStepLabel(analysis.value.step)
  return label ? `正在${label}` : '分析中'
})
const hint = computed(() => {
  if (queued.value) return '一次只分析一支影片，前面的影片完成後就會自動開始。'
  if (analysis.value.step === 'transcribe') return '語音辨識最花時間，長影片可能需要數分鐘到數十分鐘。'
  return '完成後就能看逐字稿、標出精華片段並輸出剪輯。'
})
</script>

<template>
  <section class="rounded-lg border border-default p-5 sm:p-6" aria-live="polite">
    <div class="flex items-start gap-4">
      <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <UIcon v-if="queued" name="i-lucide-hourglass" class="size-5" />
        <UIcon v-else name="i-lucide-loader-circle" class="size-5 animate-spin" />
      </span>
      <div class="min-w-0 flex-1">
        <p class="font-semibold text-highlighted">
          {{ title }}
        </p>
        <p class="mt-0.5 text-sm text-muted">
          {{ hint }}
        </p>
      </div>
      <span v-if="!queued" class="text-2xl font-semibold tabular-nums text-highlighted">{{ percent }}%</span>
    </div>

    <UProgress :model-value="queued ? 0 : percent" class="mt-5" />

    <ol class="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm">
      <li v-for="s in steps" :key="s.step" class="flex items-center gap-1.5">
        <UIcon v-if="s.state === 'done'" name="i-lucide-circle-check" class="size-4 text-success" />
        <UIcon v-else-if="s.state === 'current'" name="i-lucide-loader-circle" class="size-4 animate-spin text-primary" />
        <UIcon v-else name="i-lucide-circle-dashed" class="size-4 text-dimmed" />
        <span :class="s.state === 'current' ? 'font-medium text-highlighted' : s.state === 'done' ? 'text-toned' : 'text-dimmed'">{{ s.label }}</span>
      </li>
    </ol>

    <p class="mt-5 flex items-center gap-1.5 border-t border-default pt-4 text-sm text-muted">
      <UIcon name="i-lucide-info" class="size-4 shrink-0" />
      分析在背景進行，可以關掉這個頁面，稍後再回來查看。
    </p>
  </section>
</template>
