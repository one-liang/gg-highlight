<script setup lang="ts">
import { formatTimeInput, parseTime } from '~/utils/time'

const props = withDefaults(defineProps<{
  modelValue: number | null
  label: string
  placeholder?: string
  size?: 'xs' | 'sm' | 'md'
  /** Shows the "設為目前時間" button. */
  setCurrent?: boolean
  kbd?: string
}>(), {
  placeholder: '0:00.0',
  size: 'md',
  setCurrent: true,
  kbd: undefined,
})

const emit = defineEmits<{
  'update:modelValue': [value: number | null]
  'set-current': []
}>()

const text = ref(props.modelValue === null ? '' : formatTimeInput(props.modelValue))
const invalid = computed(() => text.value.trim() !== '' && parseTime(text.value) === null)

// Follow outside changes (e.g. 設為目前時間) without fighting what the user is typing.
watch(() => props.modelValue, (value) => {
  const typed = parseTime(text.value)
  if (value === null) {
    if (typed !== null) text.value = ''
    return
  }
  if (typed === null || Math.abs(typed - value) > 0.0005) text.value = formatTimeInput(value)
})

function onInput(value: string | number | null | undefined) {
  text.value = String(value ?? '')
  emit('update:modelValue', parseTime(text.value))
}

function onBlur() {
  const value = parseTime(text.value)
  if (value !== null) text.value = formatTimeInput(value)
}
</script>

<template>
  <div class="flex items-center gap-1">
    <UInput
      :model-value="text"
      :placeholder="placeholder"
      :size="size"
      :color="invalid ? 'error' : 'primary'"
      :highlight="invalid"
      :aria-label="label"
      :aria-invalid="invalid || undefined"
      inputmode="decimal"
      autocomplete="off"
      class="w-28"
      :ui="{ base: 'font-mono tabular-nums' }"
      @update:model-value="onInput"
      @blur="onBlur"
      @keydown.enter="onBlur"
    />
    <UTooltip v-if="setCurrent" :text="`把${label}設為目前播放時間`" :kbds="kbd ? [kbd] : undefined">
      <UButton
        icon="i-lucide-crosshair"
        color="neutral"
        variant="outline"
        :size="size"
        :aria-label="`${label}設為目前時間`"
        @click="emit('set-current')"
      />
    </UTooltip>
  </div>
</template>
