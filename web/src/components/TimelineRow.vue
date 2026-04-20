<script setup lang="ts">
import type { TimelineItem } from '../stores/session'
import type { AssistantDisplayItem } from '../../../runtime/protocol/message-types.js'
import TimelineMessageContent from './TimelineMessageContent.vue'

defineProps<{
  item: TimelineItem
}>()

function getPrefix(item: TimelineItem): string {
  if (item.kind === 'user') return '❯'
  if (shouldHidePrefix(item)) return ''
  return ''
}

function getPrefixClass(item: TimelineItem): string {
  if (shouldHidePrefix(item)) return 'timeline-cli-prefix timeline-cli-prefix-hidden'
  if (item.kind === 'user') return 'timeline-cli-prefix timeline-cli-prefix-user'
  return 'timeline-cli-prefix timeline-cli-prefix-assistant'
}

function getFirstVisibleAssistantFragment(item: AssistantDisplayItem) {
  return item.fragments.find((fragment) => {
    if (fragment.type === 'thinking') return !fragment.defaultHidden
    return true
  })
}

function shouldHidePrefix(item: TimelineItem): boolean {
  if (item.kind !== 'user') return true
  if (!isAssistantItem(item)) return false
  return getFirstVisibleAssistantFragment(item)?.type === 'tool_use'
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

</script>

<template>
  <div :class="['timeline-cli-row', getRowClass(item)]">
    <span :class="getPrefixClass(item)">{{ getPrefix(item) }}</span>
    <div class="timeline-cli-content">
      <TimelineMessageContent :item="item" />
    </div>
  </div>
</template>
