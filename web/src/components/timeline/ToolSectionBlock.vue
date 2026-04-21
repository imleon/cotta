<script setup lang="ts">
defineProps<{
  label?: string
}>()
</script>

<template>
  <div class="space-y-1.5">
    <div v-if="label" class="text-[11px] font-medium leading-4 text-slate-400">{{ label }}</div>
    <slot />
  </div>
</template>
