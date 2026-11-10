<script setup lang="ts">
// Shown instead of the app for unknown routes (404) and unexpected errors, inside the usual header.
import type { NuxtError } from '#app'
import { zh_tw } from '@nuxt/ui/locale'

const props = defineProps<{ error: NuxtError }>()

const notFound = computed(() => props.error.statusCode === 404)
const route = useRoute()

useHead({
  title: () => (notFound.value ? '找不到頁面' : '發生錯誤'),
  titleTemplate: title => `${title} · gg-highlight`,
})

function home() {
  void clearError({ redirect: '/' })
}
</script>

<template>
  <UApp :locale="zh_tw">
    <NuxtLayout>
      <UContainer class="py-6 sm:py-8">
        <UEmpty
          :icon="notFound ? 'i-lucide-file-question' : 'i-lucide-circle-alert'"
          :title="notFound ? '找不到這個頁面' : '發生錯誤'"
          :description="notFound ? `網址「${route.fullPath}」不是 gg-highlight 的頁面。` : (error.statusMessage || error.message || '請重新整理頁面再試一次。')"
          variant="subtle"
          size="lg"
          class="py-16"
          :actions="[{ label: '回到影片庫', icon: 'i-lucide-library', onClick: home }]"
        />
      </UContainer>
    </NuxtLayout>
  </UApp>
</template>
