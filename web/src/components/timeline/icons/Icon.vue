<script setup lang="ts">
import { computed } from 'vue'
import { ICON_REGISTRY } from './icon-registry'

const props = withDefaults(defineProps<{
  name: keyof typeof ICON_REGISTRY
  size?: number | string
}>(), {
  size: 16,
})

const icon = computed(() => ICON_REGISTRY[props.name])
const iconSize = computed(() => typeof props.size === 'number' ? `${props.size}px` : props.size)
</script>

<template>
  <svg
    v-if="icon"
    :viewBox="icon.viewBox"
    :width="iconSize"
    :height="iconSize"
    fill="none"
    aria-hidden="true"
  >
    <path
      v-for="(path, index) in icon.paths"
      :key="index"
      v-bind="path"
    />
  </svg>
</template>
