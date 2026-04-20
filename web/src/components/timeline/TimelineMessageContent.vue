<script setup lang="ts">
import TimelineAssistantCard from './TimelineAssistantCard.vue'
import TimelineLivePreviewCard from './TimelineLivePreviewCard.vue'
import TimelineUserCard from './TimelineUserCard.vue'
import type { TimelineItemModel } from '../../models/session'

const props = defineProps<{
  item: TimelineItemModel
}>()
</script>

<template>
  <template v-if="props.item.kind === 'user'">
    <TimelineUserCard :item="props.item" />
  </template>

  <template v-else-if="props.item.kind === 'assistant'">
    <TimelineAssistantCard :item="props.item" />
  </template>

  <template v-else-if="props.item.kind === 'live_preview'">
    <TimelineLivePreviewCard :item="props.item" />
  </template>
</template>
