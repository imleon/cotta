<script setup lang="ts">
import TimelineAssistantCard from './TimelineAssistantCard.vue'
import TimelineCollapsedToolBatchCard from './TimelineCollapsedToolBatchCard.vue'
import TimelineGroupedToolUseCard from './TimelineGroupedToolUseCard.vue'
import TimelineLivePreviewCard from './TimelineLivePreviewCard.vue'
import TimelineSummaryCard from './TimelineSummaryCard.vue'
import TimelineUserCard from './TimelineUserCard.vue'
import type { TimelineItem } from '../stores/session'

defineProps<{
  item: TimelineItem
}>()
</script>

<template>
  <template v-if="item.kind === 'user'">
    <TimelineUserCard :item="item" />
  </template>

  <template v-else-if="item.kind === 'summary'">
    <TimelineSummaryCard :item="item" />
  </template>

  <template v-else-if="item.kind === 'grouped_tool_use'">
    <TimelineGroupedToolUseCard :item="item" />
  </template>

  <template v-else-if="item.kind === 'collapsed_tool_batch'">
    <TimelineCollapsedToolBatchCard :item="item" />
  </template>

  <template v-else-if="item.kind === 'assistant'">
    <TimelineAssistantCard :item="item" />
  </template>

  <template v-else-if="item.kind === 'live_preview'">
    <TimelineLivePreviewCard :item="item" />
  </template>
</template>
