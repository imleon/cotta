<script setup lang="ts">
import ToolRowShell from './ToolRowShell.vue'

defineProps<{
  summary: string
}>()
</script>

<template>
  <ToolRowShell
    title="调用工具"
    :subtitle="summary"
    subtitle-visibility="collapsed"
    :default-expanded="false"
  >
    <template #icon>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
        <path d="M18.8 4.8a3.8 3.8 0 0 0-4.6 4.7l-6.9 6.9a1.8 1.8 0 0 0 0 2.5l.8.8a1.8 1.8 0 0 0 2.5 0l6.9-6.9a3.8 3.8 0 0 0 4.7-4.6l-2.6 2.1-1.8-.2-.2-1.8 2.1-2.5Z" stroke="currentColor" stroke-width="1.55" stroke-linejoin="round" />
        <path d="M8.7 17.3l-1.5-1.5" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" />
      </svg>
    </template>
    <div class="space-y-2">
      <slot />
    </div>
  </ToolRowShell>
</template>
