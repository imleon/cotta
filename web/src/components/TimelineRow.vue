<script setup lang="ts">
import { computed } from 'vue'
import type { TimelineItem } from '../stores/session'
import {
  getTranscriptMessageId,
} from '../../../shared/transcript-normalizer.js'
import type {
  AssistantDisplayItem,
  CollapsedToolBatchDisplayItem,
  GroupedToolUseDisplayItem,
} from '../../../shared/message-types.js'
import TimelineMessageContent from './TimelineMessageContent.vue'

const props = withDefaults(defineProps<{
  item: TimelineItem
  showDebugMeta?: boolean
}>(), {
  showDebugMeta: false,
})

function getAnchorMessage(item: TimelineItem) {
  switch (item.kind) {
    case 'assistant':
    case 'grouped_tool_use':
    case 'collapsed_tool_batch':
    case 'summary':
      return item.anchorMessage
    case 'user':
      return item.message
    case 'live_preview':
      return null
  }
}

function getPrefix(item: TimelineItem): string {
  if (item.kind === 'user') return '❯'
  if (shouldHidePrefix(item)) return ''
  return '●'
}

function getPrefixClass(item: TimelineItem): string {
  if (shouldHidePrefix(item)) return 'timeline-cli-prefix timeline-cli-prefix-hidden'
  if (item.kind === 'user') return 'timeline-cli-prefix timeline-cli-prefix-user'
  return 'timeline-cli-prefix timeline-cli-prefix-assistant'
}

function getFirstVisibleAssistantFragment(item: AssistantDisplayItem) {
  return item.fragments.find((fragment) => {
    if (fragment.type === 'thinking') return !fragment.defaultHidden
    if (fragment.type === 'summary') return !fragment.defaultCollapsed
    return true
  })
}

function shouldHidePrefix(item: TimelineItem): boolean {
  if (item.kind === 'grouped_tool_use' || item.kind === 'live_preview') return true
  if (!isAssistantItem(item)) return false
  return getFirstVisibleAssistantFragment(item)?.type === 'tool_use'
}

function isGroupedItem(item: TimelineItem): item is GroupedToolUseDisplayItem {
  return item.kind === 'grouped_tool_use'
}

function isCollapsedItem(item: TimelineItem): item is CollapsedToolBatchDisplayItem {
  return item.kind === 'collapsed_tool_batch'
}

function isAssistantItem(item: TimelineItem): item is AssistantDisplayItem {
  return item.kind === 'assistant'
}

function getRowClass(item: TimelineItem): string {
  const baseClass = (() => {
    switch (item.kind) {
      case 'user':
        return 'timeline-cli-card timeline-cli-card-user'
      case 'live_preview':
        return 'timeline-cli-card timeline-cli-card-preview'
      default:
        return 'timeline-cli-card timeline-cli-card-assistant'
    }
  })()

  return shouldHidePrefix(item) ? `${baseClass} timeline-cli-row-no-prefix` : baseClass
}

const rowStatus = computed(() => {
  if (isGroupedItem(props.item) || isCollapsedItem(props.item)) {
    return props.item.status
  }
  if (isAssistantItem(props.item) && props.item.overlays?.length) {
    return 'streaming'
  }
  if (props.item.kind === 'live_preview') {
    return 'streaming'
  }
  return 'completed'
})

const debugMeta = computed(() => {
  const message = getAnchorMessage(props.item)
  if (!message) return ''
  const toolUseIds = (message.blocks || [])
    .flatMap((block) => block.type === 'tool_use' && typeof block.toolUseId === 'string' ? [block.toolUseId] : [])
  const toolResultForIds = (message.blocks || [])
    .flatMap((block) => block.type === 'tool_result' && typeof block.toolUseId === 'string' ? [block.toolUseId] : [])

  return [
    `uuid=${getTranscriptMessageId(message) || 'unknown'}`,
    toolUseIds.length ? `toolUse=${toolUseIds.join(',')}` : '',
    toolResultForIds.length ? `toolResultFor=${toolResultForIds.join(',')}` : '',
    rowStatus.value === 'streaming' ? 'streaming' : '',
  ].filter(Boolean).join(' · ')
})
</script>

<template>
  <div :class="['timeline-cli-row', getRowClass(item)]">
    <span :class="getPrefixClass(item)">{{ getPrefix(item) }}</span>
    <div class="timeline-cli-content">
      <TimelineMessageContent :item="item" />
      <div v-if="props.showDebugMeta && debugMeta" class="timeline-cli-meta mt-1">
        {{ debugMeta }}
      </div>
    </div>
  </div>
</template>
