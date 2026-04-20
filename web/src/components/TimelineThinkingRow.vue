<script setup lang="ts">
import { computed } from 'vue'
import MarkdownContent from './MarkdownContent.vue'
import ToolRowShell from './ToolRowShell.vue'

const props = withDefaults(defineProps<{
  text: string
  redacted?: boolean
  maxHeightClass?: string
}>(), {
  redacted: false,
  maxHeightClass: 'max-h-56',
})

function extractSubtitle(raw: string, maxChars = 36): string {
  const text = raw.trim()
  if (!text) return ''

  // If it starts with a markdown heading, use the heading text.
  const headingMatch = text.match(/^#{1,6}\s+(.+?)\s*#*\s*(?:\n|$)/)
  if (headingMatch?.[1]) return headingMatch[1].trim()

  // Otherwise, prefer a leading bold section title.
  const boldMatch = text.match(/^\*\*(.+?)\*\*(?:\s|:|：|\n|$)/)
  if (boldMatch?.[1]) return boldMatch[1].trim()

  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars)}...`
}

const subtitle = computed(() => {
  if (props.redacted) return 'redacted'
  return extractSubtitle(props.text)
})

const thinkingText = computed(() => props.redacted ? 'redacted thinking' : props.text)
</script>

<template>
  <ToolRowShell
    title="思考中"
    :subtitle="subtitle"
    subtitle-visibility="collapsed"
    :default-expanded="false"
  >
    <template #icon>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
        <path d="M9.5 4.5c-1.3 0-2.3.9-2.5 2.1A3.2 3.2 0 0 0 4 9.8c0 1 .4 1.9 1.1 2.5a3 3 0 0 0-.5 1.6c0 1.7 1.3 3 3 3 .2 1.3 1.3 2.3 2.7 2.3 1 0 1.8-.4 2.4-1.1.5.7 1.4 1.1 2.4 1.1 1.4 0 2.5-1 2.7-2.3 1.7 0 3-1.3 3-3 0-.6-.2-1.2-.5-1.7a3.2 3.2 0 0 0 1-2.4c0-1.6-1.2-3-2.8-3.2-.2-1.2-1.3-2.1-2.5-2.1-.9 0-1.8.4-2.3 1-.5-.6-1.4-1-2.3-1Z" stroke="currentColor" stroke-width="1.55" stroke-linejoin="round" />
        <path d="M9.3 7.8c-.7.4-1.1 1-1.1 1.8 0 .6.3 1.2.8 1.6" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" />
        <path d="M14.7 7.8c.7.4 1.1 1 1.1 1.8 0 .6-.3 1.2-.8 1.6" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" />
        <path d="M12 5.8v11.4" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
        <path d="M8.9 12.3c.5-.4 1.1-.6 1.7-.6.5 0 1 .2 1.4.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
        <path d="M15.1 12.3c-.5-.4-1.1-.6-1.7-.6-.5 0-1 .2-1.4.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
      </svg>
    </template>
    <div :class="[maxHeightClass, 'overflow-auto pr-1']">
      <MarkdownContent :content="thinkingText" muted />
    </div>
  </ToolRowShell>
</template>
