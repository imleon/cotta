<script setup lang="ts">
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import TimelineCliSubrow from './TimelineCliSubrow.vue'
import type { SummaryDisplayItem } from '../../../shared/message-types.js'

const props = defineProps<{
  item: SummaryDisplayItem
}>()

function renderMarkdown(content: string): string {
  const html = marked.parse(content, { async: false }) as string
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  })
}
</script>

<template>
  <TimelineCliSubrow muted>
    <div
      v-if="props.item.summaryType === 'compact'"
      class="whitespace-pre-wrap text-sm leading-6 text-slate-500"
    >{{ props.item.content }}</div>
    <div
      v-else
      class="markdown-body prose prose-sm max-w-none text-slate-500"
      v-html="renderMarkdown(props.item.content)"
    />
  </TimelineCliSubrow>
</template>
