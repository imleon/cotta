<script setup lang="ts">
import TimelineAssistantCard from './TimelineAssistantCard.vue'
import TimelineCollapsedToolBatchCard from './TimelineCollapsedToolBatchCard.vue'
import TimelineGroupedToolUseCard from './TimelineGroupedToolUseCard.vue'
import TimelineHiddenDebugAtomCard from './TimelineHiddenDebugAtomCard.vue'
import TimelineLivePreviewCard from './TimelineLivePreviewCard.vue'
import TimelineSummaryCard from './TimelineSummaryCard.vue'
import TimelineUserCard from './TimelineUserCard.vue'
import type { TimelineItem } from '../stores/session'

const props = defineProps<{
  item: TimelineItem
  showDebugMeta?: boolean
}>()
</script>

<template>
  <template v-if="props.item.kind === 'user'">
    <TimelineUserCard :item="props.item" :show-debug-meta="props.showDebugMeta" />
  </template>

  <template v-else-if="props.item.kind === 'summary'">
    <TimelineSummaryCard :item="props.item" />
  </template>

  <template v-else-if="props.item.kind === 'grouped_tool_use'">
    <TimelineGroupedToolUseCard :item="props.item" :show-debug-meta="props.showDebugMeta" />
  </template>

  <template v-else-if="props.item.kind === 'collapsed_tool_batch'">
    <TimelineCollapsedToolBatchCard :item="props.item" :show-debug-meta="props.showDebugMeta" />
  </template>

  <template v-else-if="props.item.kind === 'assistant'">
    <TimelineAssistantCard :item="props.item" :show-debug-meta="props.showDebugMeta" />
  </template>

  <template v-else-if="props.item.kind === 'live_preview'">
    <TimelineLivePreviewCard :item="props.item" />
  </template>

  <template v-else-if="props.item.kind === 'hidden_debug_atom'">
    <TimelineHiddenDebugAtomCard :item="props.item" />
  </template>
</template>
