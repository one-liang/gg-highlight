<script setup lang="ts">
import { zh_tw } from '@nuxt/ui/locale'

useHead({
  titleTemplate: title => (title && title !== 'gg-highlight' ? `${title} · gg-highlight` : 'gg-highlight'),
})
</script>

<template>
  <UApp :locale="zh_tw" :toaster="{ position: 'bottom-right', duration: 5000 }">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
