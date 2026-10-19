export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  ssr: false,
  devtools: { enabled: false },
  telemetry: false,
  ui: {
    fonts: false,
  },
  icon: {
    provider: 'none',
    clientBundle: { scan: true },
    serverBundle: { collections: ['lucide'] },
  },
  app: {
    head: {
      title: 'gg-highlight',
      htmlAttrs: { lang: 'zh-Hant-TW' },
    },
  },
  nitro: {
    experimental: { tasks: false },
  },
})
