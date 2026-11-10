<script setup lang="ts">
import type { Layout } from '~~/shared/types/domain'

defineProps<{ layout: Layout }>()

const blurId = useId()

// 9:16 phone frame, 44 units tall, centered in a 64×48 box
const PHONE = { x: 20.125, y: 2, w: 24.75, h: 44 }
// 16:9 picture scaled to the phone width
const STRIP_H = (PHONE.w * 9) / 16
const STRIP_Y = PHONE.y + (PHONE.h - STRIP_H) / 2
// center-crop: wide source drawn 60 units wide, the 9:16 crop taken from its middle
const SRC = { x: 2, w: 60, h: (60 * 9) / 16 }
const SRC_Y = (48 - SRC.h) / 2
const CROP_W = (SRC.h * 9) / 16
</script>

<template>
  <svg viewBox="0 0 64 48" fill="none" aria-hidden="true">
    <template v-if="layout === 'blurred-background'">
      <defs>
        <filter :id="blurId" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.6" />
        </filter>
      </defs>
      <rect :x="PHONE.x" :y="PHONE.y" :width="PHONE.w" :height="PHONE.h" rx="3" class="fill-current opacity-15" />
      <g :filter="`url(#${blurId})`" class="fill-primary opacity-45">
        <rect :x="PHONE.x + 2" :y="PHONE.y + 3" :width="PHONE.w - 4" :height="STRIP_Y - PHONE.y - 5" rx="2" />
        <rect :x="PHONE.x + 2" :y="STRIP_Y + STRIP_H + 2" :width="PHONE.w - 4" :height="STRIP_Y - PHONE.y - 5" rx="2" />
      </g>
      <rect :x="PHONE.x" :y="STRIP_Y" :width="PHONE.w" :height="STRIP_H" class="fill-primary" />
      <path :d="`M${PHONE.x + 3} ${STRIP_Y + STRIP_H - 2} l5 -5 l3.5 3 l4 -5 l6.5 7 z`" class="fill-white opacity-60" />
      <rect :x="PHONE.x" :y="PHONE.y" :width="PHONE.w" :height="PHONE.h" rx="3" class="stroke-current" stroke-width="1.5" />
      <rect :x="PHONE.x + 5" :y="STRIP_Y + STRIP_H + 4" :width="PHONE.w - 10" height="2" rx="1" class="fill-current opacity-70" />
    </template>

    <template v-else-if="layout === 'center-crop'">
      <rect :x="SRC.x" :y="SRC_Y" :width="SRC.w" :height="SRC.h" rx="1.5" class="fill-primary opacity-20" />
      <rect :x="SRC.x" :y="SRC_Y" :width="SRC.w" :height="SRC.h" rx="1.5" class="stroke-current opacity-50" stroke-width="1" stroke-dasharray="2 2" />
      <rect :x="32 - CROP_W / 2" :y="SRC_Y" :width="CROP_W" :height="SRC.h" class="fill-primary" />
      <path :d="`M${32 - CROP_W / 2 + 2} ${SRC_Y + SRC.h - 3} l4 -6 l3 3 l3.5 -5 l3.5 8 z`" class="fill-white opacity-60" />
      <rect :x="32 - CROP_W / 2" :y="SRC_Y" :width="CROP_W" :height="SRC.h" rx="1.5" class="stroke-current" stroke-width="1.5" />
      <rect :x="32 - CROP_W / 2 + 3.5" :y="SRC_Y + SRC.h - 6" :width="CROP_W - 7" height="2" rx="1" class="fill-current opacity-70" />
    </template>

    <template v-else>
      <rect x="4" :y="(48 - 31.5) / 2" width="56" height="31.5" rx="2" class="fill-primary" />
      <path :d="`M8 ${(48 + 31.5) / 2 - 3} l9 -10 l6 5 l8 -10 l12 15 z`" class="fill-white opacity-60" />
      <rect x="4" :y="(48 - 31.5) / 2" width="56" height="31.5" rx="2" class="stroke-current" stroke-width="1.5" />
      <rect x="20" :y="(48 + 31.5) / 2 - 6" width="24" height="2" rx="1" class="fill-current opacity-70" />
    </template>
  </svg>
</template>
