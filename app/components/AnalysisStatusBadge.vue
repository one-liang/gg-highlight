<script setup lang="ts">
import type { AnalysisState } from '~~/shared/types/domain'
import { analysisStatusColors, analysisStatusLabels } from '~/utils/labels'

const props = defineProps<{ analysis: AnalysisState }>()

const icon = computed(() => {
  switch (props.analysis.status) {
    case 'queued': return 'i-lucide-hourglass'
    case 'running': return 'i-lucide-loader-circle'
    case 'done': return 'i-lucide-circle-check'
    default: return 'i-lucide-circle-x'
  }
})
</script>

<template>
  <UBadge
    :icon="icon"
    :label="analysisStatusLabels[analysis.status]"
    :color="analysisStatusColors[analysis.status]"
    variant="subtle"
    size="sm"
    :ui="{ leadingIcon: analysis.status === 'running' ? 'animate-spin' : '' }"
  />
</template>
