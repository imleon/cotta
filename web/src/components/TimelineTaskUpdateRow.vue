<script setup lang="ts">
const props = withDefaults(defineProps<{
  subtitle?: string
}>(), {
  subtitle: '',
})
</script>

<template>
  <div class="rounded-xl border border-slate-200/70 overflow-hidden">
    <div class="flex w-full items-center gap-1 bg-slate-50/80 px-3 py-2 text-left text-[13px] leading-6 text-slate-700">
      <span class="shrink-0 inline-flex h-6 w-6 items-center justify-center text-[15px] leading-6 text-slate-600">📋</span>
      <span class="min-w-0 flex-1 flex items-center">
        <span class="font-medium text-slate-900">TaskUpdate</span>
        <span v-if="subtitle" class="ml-2 text-slate-500 truncate">{{ subtitle }}</span>
      </span>
    </div>
  </div>
</template>
