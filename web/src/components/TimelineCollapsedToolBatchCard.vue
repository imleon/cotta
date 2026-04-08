<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import TimelineAssistantCard from './TimelineAssistantCard.vue'
import TimelineGroupedToolUseCard from './TimelineGroupedToolUseCard.vue'
import TimelineLivePreviewCard from './TimelineLivePreviewCard.vue'
import type { CollapsedToolBatchDisplayItem } from '../../../shared/message-types.js'

const props = withDefaults(defineProps<{
  item: CollapsedToolBatchDisplayItem
  showDebugMeta?: boolean
}>(), {
  showDebugMeta: false,
})

const expanded = ref(props.item.status === 'streaming')

watch(
  () => props.item.status,
  (status) => {
    if (status === 'streaming') {
      expanded.value = true
    }
  },
)

const totalOps = computed(() => props.item.summary.readCount + props.item.summary.searchCount + props.item.summary.listCount + props.item.summary.bashCount)
const toggleLabel = computed(() => (expanded.value ? 'Collapse' : 'Expand'))
</script>

<template>
  <div v-if="item.overlays?.length" class="mb-2 space-y-2">
    <TimelineLivePreviewCard
      v-for="overlay in item.overlays"
      :key="`${item.key}-overlay-${overlay.id}`"
      :item="overlay"
      compact
    />
  </div>
  <div class="space-y-2">
    <div class="text-slate-900">
      {{ totalOps }} low-signal tool calls
      <span v-if="item.summary.latestHint" class="text-slate-500"> · {{ item.summary.latestHint }}</span>
      <button class="timeline-cli-button ml-2" @click="expanded = !expanded">{{ toggleLabel }}</button>
    </div>
    <div class="timeline-cli-subrow text-slate-500">
      <span class="timeline-cli-subprefix">⎿</span>
      <div>
        Read {{ item.summary.readCount }} · Search {{ item.summary.searchCount }} · List {{ item.summary.listCount }} · Bash {{ item.summary.bashCount }}
      </div>
    </div>
    <div v-if="expanded" class="space-y-3">
      <template v-for="child in item.items" :key="child.key">
        <TimelineGroupedToolUseCard v-if="child.kind === 'grouped_tool_use'" :item="child" hide-footer :show-debug-meta="showDebugMeta" />
        <TimelineAssistantCard v-else :item="child" hide-footer :show-debug-meta="showDebugMeta" />
      </template>
    </div>
  </div>
</template>
