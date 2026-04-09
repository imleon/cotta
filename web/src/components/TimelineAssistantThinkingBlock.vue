<script setup lang="ts">
import { computed, ref } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { DisplayFragmentThinking } from '../../../shared/message-types.js'

const props = defineProps<{
  fragment: DisplayFragmentThinking
}>()

const expanded = ref(true)
const isRedacted = computed(() => Boolean(props.fragment.redacted))
const label = computed(() => isRedacted.value ? 'Redacted thinking' : 'Thinking')
const thinkingText = computed(() => props.fragment.redacted ? '' : (props.fragment.text || ''))

function renderMarkdown(content: string): string {
  const html = marked.parse(content, { async: false }) as string
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  })
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center gap-2 text-[var(--tt-text-muted)]">
      <span>{{ label }}</span>
      <button class="timeline-cli-button" @click="expanded = !expanded">{{ expanded ? 'hide' : 'show' }}</button>
    </div>
    <div
      v-if="expanded"
      class="flex items-start gap-3"
    >
      <span class="timeline-cli-subprefix">⎿</span>
      <div class="min-w-0 flex-1 rounded-xl border border-[color:color-mix(in_srgb,var(--tt-border)_72%,white)] bg-[color:color-mix(in_srgb,var(--tt-surface)_72%,white)] px-3 py-2">
        <div class="markdown-body prose prose-sm max-w-none text-[var(--tt-text-subtle)]" v-html="renderMarkdown(thinkingText)" />
      </div>
    </div>
  </div>
</template>
