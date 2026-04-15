<script setup lang="ts">
import { computed } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import TimelineCliSubrow from './TimelineCliSubrow.vue'
import type { TimelineLivePreviewItem } from '../../../runtime/protocol/message-types.js'

const props = withDefaults(defineProps<{
  item: TimelineLivePreviewItem
  compact?: boolean
}>(), {
  compact: false,
})

function renderMarkdown(content: string): string {
  const html = marked.parse(content, { async: false }) as string
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  })
}

const overlayToneClass = computed(() => {
  switch (props.item.overlayKind) {
    case 'streaming_thinking':
      return 'timeline-cli-dot timeline-cli-dot-streaming text-[var(--tt-accent)]'
    case 'streaming_tool_use':
      return 'timeline-cli-dot timeline-cli-dot-streaming text-[var(--tt-primary)]'
    case 'streaming_progress':
      return 'timeline-cli-dot timeline-cli-dot-streaming text-[var(--tt-coral)]'
    default:
      return 'timeline-cli-dot timeline-cli-dot-streaming text-[var(--tt-primary)]'
  }
})

const overlayLabel = computed(() => {
  switch (props.item.overlayKind) {
    case 'streaming_thinking':
      return 'Thinking'
    case 'streaming_tool_use':
      return 'Running'
    case 'streaming_progress':
      return 'Working'
    default:
      return 'Drafting'
  }
})

const combinedPreviewText = computed(() =>
  props.item.preview.blocks
    .filter((block) => block.kind === 'text' || block.kind === 'thinking')
    .map((block) => block.kind === 'text' ? block.shownText : block.shownText)
    .filter(Boolean)
    .join('\n\n')
)
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-start gap-3 text-[var(--tt-text)]">
      <span :class="overlayToneClass">●</span>
      <span class="font-medium">{{ overlayLabel }}…</span>
    </div>
    <div v-for="block in item.preview.blocks" :key="`${item.key}-preview-${block.kind}-${block.index}`" class="space-y-2">
      <TimelineCliSubrow v-if="block.kind === 'text'" muted>
        <div class="markdown-body prose prose-sm max-w-none text-[var(--tt-text-subtle)]" v-html="renderMarkdown(block.shownText)" />
      </TimelineCliSubrow>
      <TimelineCliSubrow v-else-if="block.kind === 'thinking'" muted>
        <div v-if="block.redacted" class="italic">∴ Thinking</div>
        <div v-else class="markdown-body prose prose-sm max-w-none text-slate-500" v-html="renderMarkdown(block.shownText)" />
      </TimelineCliSubrow>
      <TimelineCliSubrow v-else muted>
        <div>{{ block.name }}<span v-if="block.shownInput">({{ block.shownInput.trim().replace(/\s+/g, ' ').slice(0, 72) }}{{ block.shownInput.trim().replace(/\s+/g, ' ').length > 72 ? '…' : '' }})</span></div>
      </TimelineCliSubrow>
    </div>
    <TimelineCliSubrow v-if="combinedPreviewText && item.preview.blocks.every((block) => block.kind !== 'text' && block.kind !== 'thinking')" muted>
      <div class="markdown-body prose prose-sm max-w-none text-slate-500" v-html="renderMarkdown(combinedPreviewText)" />
    </TimelineCliSubrow>
  </div>
</template>
