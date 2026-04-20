<script setup lang="ts">
withDefaults(defineProps<{
  prefix?: string
  muted?: boolean
  noPrefix?: boolean
}>(), {
  prefix: '⎿',
  muted: false,
  noPrefix: false,
})
</script>

<template>
  <div :class="['timeline-cli-subrow', { 'text-slate-500': muted, 'text-slate-600': !muted }]">
    <span class="timeline-cli-subprefix">{{ noPrefix ? '' : prefix }}</span>
    <div class="min-w-0 flex-1">
      <slot />
    </div>
  </div>
</template>
