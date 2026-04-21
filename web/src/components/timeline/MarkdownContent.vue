<script setup lang="ts">
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const props = withDefaults(defineProps<{
  content: string
  muted?: boolean
  compact?: boolean
}>(), {
  muted: false,
  compact: false,
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
    :class="[
      props.muted ? 'markdown-muted text-slate-500' : 'text-[var(--tt-text)]',
      props.compact ? 'markdown-compact text-[12px] leading-5' : '',
    ]"
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

.markdown-compact:deep(*) {
  font-size: inherit;
  line-height: inherit;
}

.markdown-compact:deep(h1),
.markdown-compact:deep(h2),
.markdown-compact:deep(h3),
.markdown-compact:deep(h4),
.markdown-compact:deep(h5),
.markdown-compact:deep(h6) {
  font-weight: 600;
}
</style>
