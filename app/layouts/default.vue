<script setup lang="ts">
const route = useRoute()

const nav = computed(() => [
  {
    label: '影片庫',
    to: '/',
    icon: 'i-lucide-library',
    active: route.path === '/' || route.path.startsWith('/videos'),
  },
  {
    label: '設定',
    to: '/settings',
    icon: 'i-lucide-settings',
    active: route.path.startsWith('/settings'),
  },
])
</script>

<template>
  <div class="min-h-dvh flex flex-col bg-default text-default">
    <header class="sticky top-0 z-40 border-b border-default bg-default/85 backdrop-blur">
      <div class="mx-auto flex h-14 w-full max-w-[1600px] items-center gap-3 px-4 sm:gap-6 sm:px-6">
        <NuxtLink to="/" class="flex shrink-0 items-center gap-2 font-semibold text-highlighted">
          <span class="flex size-7 items-center justify-center rounded-md bg-primary text-inverted">
            <UIcon name="i-lucide-clapperboard" class="size-4" />
          </span>
          <span class="hidden sm:inline">gg-highlight</span>
        </NuxtLink>

        <nav class="flex items-center gap-1" aria-label="主要導覽">
          <UButton
            v-for="item in nav"
            :key="item.to"
            :to="item.to"
            :icon="item.icon"
            :label="item.label"
            color="neutral"
            :variant="item.active ? 'soft' : 'ghost'"
            :aria-current="item.active ? 'page' : undefined"
            size="sm"
          />
        </nav>

        <div class="ml-auto flex items-center">
          <UColorModeButton color="neutral" variant="ghost" size="sm" />
        </div>
      </div>
    </header>

    <main class="flex-1">
      <slot />
    </main>
  </div>
</template>
