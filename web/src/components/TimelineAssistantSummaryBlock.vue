<script setup lang="ts">
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import TimelineCliSubrow from './TimelineCliSubrow.vue'
import type { DisplayFragmentSummary } from '../../../shared/message-types.js'

const props = defineProps<{
  fragment: DisplayFragmentSummary
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
    <div class="whitespace-pre-wrap text-sm leading-6 text-slate-500">{{ props.fragment.text }}</div>
  </TimelineCliSubrow>
</template>
