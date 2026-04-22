<script setup lang="ts">
import type { TimelineItemModel } from '../../models/session'
import type { TimelineAssistantItem } from '../../models/timeline'
import TimelineMessageContent from './TimelineMessageContent.vue'

defineProps<{
  item: TimelineItemModel
  debugSegment?: string
}>()

function getPrefix(item: TimelineItemModel): string {
  if (item.kind === 'user') return '❯'
  if (shouldHidePrefix(item)) return ''
  return ''
}

function getPrefixClass(item: TimelineItemModel): string {
  if (shouldHidePrefix(item)) return 'timeline-cli-prefix timeline-cli-prefix-hidden'
  if (item.kind === 'user') return 'timeline-cli-prefix timeline-cli-prefix-user'
  return 'timeline-cli-prefix timeline-cli-prefix-assistant'
}

function getFirstVisibleAssistantFragment(item: TimelineAssistantItem) {
  return item.fragments.find((fragment) => {
    if (fragment.type === 'thinking') return !fragment.defaultHidden
    return true
  })
}

function shouldHidePrefix(item: TimelineItemModel): boolean {
  if (item.kind !== 'user') return true
  if (!isAssistantItem(item)) return false
  return getFirstVisibleAssistantFragment(item)?.type === 'tool_use'
}

function isAssistantItem(item: TimelineItemModel): item is TimelineAssistantItem {
  return item.kind === 'assistant'
}

function getRowClass(item: TimelineItemModel): string {
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
      <div
        v-if="debugSegment"
        class="mb-1 inline-flex rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] leading-none text-amber-700"
      >
        {{ debugSegment }}
      </div>
      <TimelineMessageContent :item="item" />
    </div>
  </div>
</template>
