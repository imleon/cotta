<script setup lang="ts">
import { computed, ref } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const props = withDefaults(defineProps<{
  text: string
  redacted?: boolean
  maxHeightClass?: string
}>(), {
  redacted: false,
  maxHeightClass: 'max-h-56',
})

const expanded = ref(false)

function renderMarkdown(content: string): string {
  const html = marked.parse(content, { async: false }) as string
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  })
}

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
</script>

<template>
  <div class="rounded-xl border border-slate-200/70 overflow-hidden">
    <button
      type="button"
      class="group flex w-full cursor-pointer items-center gap-1 bg-slate-50/80 px-3 py-2 text-left text-[13px] leading-6 text-slate-700 hover:bg-slate-100/60"
      @click="expanded = !expanded"
    >
      <span class="shrink-0 inline-flex h-6 w-6 items-center justify-center text-[15px] leading-6 text-slate-600">✨</span>
      <span class="min-w-0 flex-1 flex items-center">
        <span class="font-medium text-slate-900">Thinking</span>
        <span v-if="!expanded && subtitle" class="ml-2 text-slate-500 truncate">{{ subtitle }}</span>
        <span
          class="ml-2 inline-flex h-6 w-4 items-center justify-center text-slate-400"
          :class="expanded ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
        >
          <svg v-if="expanded" class="block" viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
            <path d="M6 15l6-6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <svg v-else class="block" viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
            <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
      </span>
    </button>

    <div v-if="expanded" class="min-w-0 border-t border-slate-200/70 bg-white px-3 py-2">
      <div :class="[maxHeightClass, 'overflow-auto pr-1']">
        <div class="markdown-body prose prose-sm max-w-none text-slate-600" v-html="renderMarkdown(redacted ? 'redacted thinking' : text)" />
      </div>
    </div>
  </div>
</template>
