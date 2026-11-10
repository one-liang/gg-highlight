<script setup lang="ts">
import type { SourceVideo } from '~~/shared/types/domain'
import { analysisProgressText } from '~/utils/analysis'
import { progressPercent } from '~/utils/format'
import { analysisStepLabel, analysisStepsFor, analysisStepState } from '~/utils/labels'

const props = defineProps<{ video: SourceVideo }>()

const analysis = computed(() => props.video.analysis)
const queued = computed(() => analysis.value.status === 'queued')
const percent = computed(() => progressPercent(analysis.value.progress))
const steps = computed(() => analysisStepsFor(props.video).map(step => ({
  step,
  label: analysisStepLabel(step, props.video.sourceKind),
  state: analysisStepState(step, analysis.value.step, analysis.value.status),
})))
const text = computed(() => analysisProgressText(props.video))
</script>

<template>
  <section class="rounded-lg border border-default p-5 sm:p-6" aria-live="polite" data-testid="analysis-progress">
    <div class="flex items-start gap-4">
      <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <UIcon v-if="queued" name="i-lucide-hourglass" class="size-5" />
        <UIcon v-else name="i-lucide-loader-circle" class="size-5 animate-spin" />
      </span>
      <div class="min-w-0 flex-1">
        <p class="font-semibold text-highlighted">
          {{ text.title }}
        </p>
        <p class="mt-0.5 text-sm text-muted">
          {{ text.hint }}
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

    <p class="mt-5 flex items-start gap-1.5 border-t border-default pt-4 text-sm text-muted">
      <UIcon name="i-lucide-info" class="mt-0.5 size-4 shrink-0" />
      {{ text.footer }}
    </p>
  </section>
</template>
