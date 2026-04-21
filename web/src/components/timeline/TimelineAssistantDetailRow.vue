<script setup lang="ts">
import { computed, useSlots } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const props = withDefaults(defineProps<{
  icon?: string
  title: string
  summary?: string
  content?: string
  contentMode?: 'markdown' | 'plain'
}>(), {
  icon: '',
  summary: '',
  content: '',
  contentMode: 'plain',
})

const hasExpandedContent = computed(() => Boolean(props.content) || Boolean(useSlots().default))

function renderMarkdown(content: string): string {
  const html = marked.parse(content, { async: false }) as string
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  })
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-start gap-2 text-[13px] leading-6 text-[var(--tt-text-muted)]">
      <span v-if="icon" class="shrink-0 text-[15px] leading-6">{{ icon }}</span>
      <div class="min-w-0 flex-1">
        <span class="font-medium text-[var(--tt-text)]">{{ title }}</span>
        <span v-if="summary" class="ml-2">{{ summary }}</span>
      </div>
    </div>
    <div
      v-if="hasExpandedContent"
      class="max-h-72 min-w-0 overflow-auto pr-1 pl-6"
    >
      <slot>
        <div
          v-if="contentMode === 'markdown'"
          class="markdown-body prose prose-sm max-w-none text-[var(--tt-text-subtle)]"
          v-html="renderMarkdown(content)"
        />
        <div v-else class="whitespace-pre-wrap text-[12px] leading-5 text-[var(--tt-text-subtle)]">{{ content }}</div>
      </slot>
    </div>
  </div>
</template>
