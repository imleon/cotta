<script setup lang="ts">
import StatusView from '../components/status/StatusView.vue'

const emit = defineEmits<{
  (event: 'open-session', sessionId: string): void
}>()
</script>

<template>
  <div class="h-full">
    <StatusView class="h-full" @open-session="emit('open-session', $event)" />
  </div>
</template>
