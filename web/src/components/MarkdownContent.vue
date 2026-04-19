<script setup lang="ts">
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const props = withDefaults(defineProps<{
  content: string
  muted?: boolean
}>(), {
  muted: false,
})

function renderMarkdown(content: string): string {
  const html = marked.parse(content, {
    async: false,
    breaks: true,
    gfm: true,
  }) as string
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  })
}
</script>

<template>
  <div
    class="markdown-body prose prose-sm max-w-none"
    :class="props.muted ? 'markdown-muted text-slate-500' : 'text-[var(--tt-text)]'"
    v-html="renderMarkdown(props.content)"
  />
</template>

<style scoped>
.markdown-muted:deep(*) {
  color: inherit;
}

.markdown-muted:deep(code),
.markdown-muted:deep(pre),
.markdown-muted:deep(strong),
.markdown-muted:deep(em),
.markdown-muted:deep(a) {
  color: inherit;
}
</style>
