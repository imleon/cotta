<script setup lang="ts">
import TimelineAtomDebugMeta from './TimelineAtomDebugMeta.vue'
import type { HiddenDebugAtomItem } from '../../../shared/message-types.js'

const props = defineProps<{
  item: HiddenDebugAtomItem
}>()

function getPreview(item: HiddenDebugAtomItem): string {
  const content = item.atom.message.content?.trim() || ''
  if (!content) return ''
  return content.length > 240 ? `${content.slice(0, 240)}…` : content
}
</script>

<template>
  <div class="rounded-lg border border-amber-200/70 bg-amber-50/60 px-3 py-2 space-y-1.5">
    <div class="text-[12px] font-medium text-amber-900">
      hidden atom · {{ item.reason }}
    </div>
    <div v-if="getPreview(item)" class="whitespace-pre-wrap text-[12px] leading-5 text-amber-900/80">
      {{ getPreview(item) }}
    </div>
    <TimelineAtomDebugMeta :debug="{
      atomId: item.atom.id,
      uuid: item.atom.linkage.messageId,
      role: item.atom.role,
      semanticKind: item.atom.semanticKind,
      order: item.atom.order,
      source: item.atom.source,
      linkage: item.atom.linkage,
      assistant: item.atom.assistant,
    }" />
  </div>
</template>
