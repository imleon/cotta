<script setup lang="ts">
import { computed } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { SessionMessage, SessionMessageBlock } from '../stores/session'
import { stringifyStructuredValue } from '../../../shared/transcript-normalizer.js'

interface HistoryMessageNodeItem {
  key: string
  timestamp: number
  message: SessionMessage
}

defineOptions({ name: 'HistoryMessageNode' })

const props = defineProps<{
  item: HistoryMessageNodeItem
}>()

const message = computed(() => props.item.message)

function formatTimelineTimestamp(timestamp?: number): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return 'time=unknown'

  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

function renderMarkdown(content: string): string {
  const html = marked.parse(content, { async: false }) as string
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  })
}

function hasBlocks(blocks?: SessionMessageBlock[]): boolean {
  return Array.isArray(blocks) && blocks.length > 0
}

function isRedactedThinkingMessage(message: SessionMessage): boolean {
  const raw = message.raw
  if (!raw || typeof raw !== 'object') return false

  const messageRecord = (raw as Record<string, unknown>).message
  if (!messageRecord || typeof messageRecord !== 'object') return false

  const content = (messageRecord as Record<string, unknown>).content
  if (Array.isArray(content)) {
    return content.length === 1
      && Boolean(content[0])
      && typeof content[0] === 'object'
      && (content[0] as Record<string, unknown>).type === 'redacted_thinking'
  }

  return Boolean(content && typeof content === 'object' && (content as Record<string, unknown>).type === 'redacted_thinking')
}

function getNodeClass(message: SessionMessage): string {
  return message.role === 'user'
    ? 'bg-[var(--tt-primary)] text-white'
    : message.role === 'system'
      ? 'border border-[color:color-mix(in_srgb,var(--tt-danger)_32%,white)] bg-[color:color-mix(in_srgb,var(--tt-danger)_10%,white)] text-[var(--tt-danger)]'
      : 'border border-[var(--tt-border)] bg-[var(--tt-card)] shadow-sm'
}

function getNodeType(message: SessionMessage): string {
  if (isRedactedThinkingMessage(message)) return 'redacted_thinking'
  return message.role
}
</script>

<template>
  <div class="max-w-[75%] rounded-2xl px-4 py-3" :class="getNodeClass(message)">
    <div class="mb-2 text-[11px] uppercase tracking-wide opacity-60">
      {{ getNodeType(message) }} · {{ formatTimelineTimestamp(item.timestamp) }}
    </div>

    <div
      v-if="isRedactedThinkingMessage(message)"
      class="rounded-lg border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_72%,white)] px-3 py-2 text-sm text-[var(--tt-text-muted)]"
    >
      redacted_thinking
    </div>

    <template v-else-if="message.role === 'assistant' && hasBlocks(message.blocks)">
      <div
        v-for="(block, blockIndex) in message.blocks || []"
        :key="`${item.key}-${blockIndex}`"
        class="mb-3 last:mb-0"
      >
        <div
          v-if="block.type === 'text'"
          class="markdown-body prose prose-sm max-w-none"
          v-html="renderMarkdown(block.text || '')"
        />
        <div
          v-else-if="block.type === 'tool_use'"
          class="rounded-lg border border-[color:color-mix(in_srgb,var(--tt-primary)_28%,white)] bg-[color:color-mix(in_srgb,var(--tt-primary)_12%,white)] px-3 py-2 text-sm text-[var(--tt-primary-strong)]"
        >
          <div class="font-medium">Tool: {{ block.name || 'unknown_tool' }}</div>
          <pre
            v-if="block.input"
            class="mt-2 whitespace-pre-wrap text-xs text-[var(--tt-accent)]"
          >{{ stringifyStructuredValue(block.input) }}</pre>
        </div>
        <div
          v-else-if="block.type === 'tool_result'"
          class="rounded-lg border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_72%,white)] px-3 py-2 text-sm text-[var(--tt-text-muted)]"
        >
          <div class="font-medium">Tool result</div>
          <pre
            v-if="block.output"
            class="mt-2 whitespace-pre-wrap text-xs text-[var(--tt-accent)]"
          >{{ stringifyStructuredValue(block.output) }}</pre>
        </div>
        <div
          v-else-if="block.type === 'thinking'"
          class="rounded-lg border border-[color:color-mix(in_srgb,var(--tt-coral)_34%,white)] bg-[color:color-mix(in_srgb,var(--tt-coral)_14%,white)] px-3 py-2 text-sm text-[var(--tt-primary-strong)]"
        >
          <div class="font-medium">Thinking</div>
          <pre class="mt-2 whitespace-pre-wrap text-xs text-[var(--tt-accent)]">{{ block.text }}</pre>
        </div>
        <div
          v-else
          class="rounded-lg border border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_72%,white)] px-3 py-2 text-sm text-[var(--tt-text-muted)]"
        >
          <div class="font-medium">Unknown block</div>
          <pre class="mt-2 whitespace-pre-wrap text-xs text-gray-800">{{ stringifyStructuredValue(block.raw) }}</pre>
        </div>
      </div>
    </template>

    <div
      v-else-if="message.role === 'assistant'"
      class="markdown-body prose prose-sm max-w-none"
      v-html="renderMarkdown(message.content || '')"
    />

    <div v-else class="whitespace-pre-wrap">{{ message.content }}</div>
  </div>
</template>
