<script setup lang="ts">
import type { SourceKind } from '~~/shared/types/domain'
import { sourceKindLabels } from '~/utils/labels'

const props = defineProps<{ kind: SourceKind }>()

const icon = computed(() => {
  switch (props.kind) {
    case 'watch-folder': return 'i-lucide-folder-open'
    case 'upload': return 'i-lucide-upload'
    default: return 'i-lucide-youtube'
  }
})
</script>

<template>
  <UBadge :icon="icon" :label="sourceKindLabels[kind]" color="neutral" variant="subtle" size="sm" />
</template>
