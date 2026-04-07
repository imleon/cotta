<script setup lang="ts">
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import TimelineCliSubrow from './TimelineCliSubrow.vue'
import type { SystemDisplayItem } from '../../../shared/message-types.js'

defineProps<{
  item: SystemDisplayItem
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
    <div class="markdown-body prose prose-sm max-w-none text-slate-600" v-html="renderMarkdown(item.content)" />
  </TimelineCliSubrow>
</template>
