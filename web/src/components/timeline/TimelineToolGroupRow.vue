<script setup lang="ts">
import ToolRowShell from './ToolRowShell.vue'
import Icon from './icons/Icon.vue'

defineProps<{
  summary: string
}>()
</script>

<template>
  <ToolRowShell
    :title="summary"
    subtitle=""
    subtitle-visibility="collapsed"
    :default-expanded="false"
  >
    <template #icon>
      <Icon name="treelist_outlined" />
    </template>
    <div class="max-h-72 space-y-2 overflow-auto pr-1">
      <slot />
    </div>
  </ToolRowShell>
</template>
