<script setup lang="ts">
import { zh_tw } from '@nuxt/ui/locale'
import { installFileDropGuard } from '~/utils/file-drop-guard'

useHead({
  titleTemplate: title => (title && title !== 'gg-highlight' ? `${title} · gg-highlight` : 'gg-highlight'),
})

// A video dropped anywhere but the upload drop zone must not make the browser open it instead of the app.
let removeDropGuard: (() => void) | null = null
onMounted(() => {
  removeDropGuard = installFileDropGuard(window)
})
onBeforeUnmount(() => removeDropGuard?.())

// Tooltips open on keyboard focus only (not on the focus a closing dialog gives back to its button),
// so they do not stay over the list after a dialog opened with the mouse closes.
const tooltip = { ignoreNonKeyboardFocus: true }
</script>

<template>
  <UApp :locale="zh_tw" :tooltip="tooltip" :toaster="{ position: 'bottom-right', duration: 5000 }">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
