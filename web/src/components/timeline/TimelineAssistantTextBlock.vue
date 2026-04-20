<script setup lang="ts">
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { TimelineTextFragment } from '../../models/timeline'

const props = defineProps<{
  fragment: TimelineTextFragment
}>()

function renderMarkdown(content: string): string {
  const html = marked.parse(content, { async: false }) as string
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  })
}
</script>

<template>
  <div class="markdown-body prose prose-sm max-w-none text-[var(--tt-text)]" v-html="renderMarkdown(props.fragment.text)" />
</template>
