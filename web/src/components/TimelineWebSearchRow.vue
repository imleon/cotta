<script setup lang="ts">
import { computed, ref } from 'vue'
import MarkdownContent from './MarkdownContent.vue'
import { stringifyStructuredValue } from '../../../runtime/protocol/transcript-normalizer.js'

const props = withDefaults(defineProps<{
  query?: string
  input?: unknown
  output?: unknown
  raw?: unknown
}>(), {
  query: '',
  input: undefined,
  output: undefined,
  raw: undefined,
})

const expanded = ref(false)

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function getArrayValues(value: unknown, field: string): string[] {
  const record = getObject(value)
  const raw = record?.[field]
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function getNestedValue(value: unknown, path: string[]): unknown {
  let current: unknown = value
  for (const segment of path) {
    const record = getObject(current)
    if (!record) return undefined
    current = record[segment]
  }
  return current
}

function toDisplayText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => typeof item === 'string' ? item : stringifyStructuredValue(item))
      .filter(Boolean)
      .join('\n')
  }
  if (value == null) return ''
  return stringifyStructuredValue(value)
}

const allowedDomainsText = computed(() => {
  const values = getArrayValues(props.input, 'allowed_domains')
  return values.length > 0 ? values.join('\n') : ''
})

const blockedDomainsText = computed(() => {
  const values = getArrayValues(props.input, 'blocked_domains')
  return values.length > 0 ? values.join('\n') : ''
})

function getToolResultMessageContent(value: unknown): string {
  const directRecord = getObject(value)
  if (directRecord?.type === 'tool_result') {
    return toDisplayText(directRecord.content)
  }

  const messageContent = getNestedValue(value, ['message', 'content'])
  if (!Array.isArray(messageContent)) return ''

  const parts = messageContent
    .map((block) => {
      const record = getObject(block)
      if (!record || record.type !== 'tool_result') return ''
      return toDisplayText(record.content)
    })
    .filter(Boolean)

  return parts.join('\n')
}

const resultContentText = computed(() =>
  getToolResultMessageContent(props.raw)
  || getToolResultMessageContent(props.output)
  || toDisplayText(getObject(props.raw)?.content)
  || toDisplayText(props.output)
  || toDisplayText(getNestedValue(props.raw, ['toolUseResult']))
  || toDisplayText(getNestedValue(props.output, ['toolUseResult']))
)
</script>

<template>
  <div class="rounded-xl border border-slate-200/70 overflow-hidden">
    <button
      type="button"
      class="group flex w-full cursor-pointer items-center gap-1 bg-slate-50/80 px-3 py-2 text-left text-[13px] leading-6 text-slate-700 hover:bg-slate-100/60"
      @click="expanded = !expanded"
    >
      <span class="shrink-0 inline-flex h-6 w-6 items-center justify-center text-[15px] leading-6 text-slate-600">🔍</span>
      <span class="min-w-0 flex-1 flex items-center">
        <span class="font-medium text-slate-900">WebSearch</span>
        <span v-if="query" class="ml-2 truncate text-slate-500">{{ query }}</span>
        <span class="ml-2 inline-flex h-6 w-4 items-center justify-center text-slate-400" :class="expanded ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'">
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
      <div class="max-h-72 space-y-3 overflow-auto pr-1">
        <div>
          <div class="text-[12px] font-semibold leading-5 text-slate-700">allowed_domains</div>
          <div class="whitespace-pre-wrap font-mono text-[12px] leading-5 text-slate-500">{{ allowedDomainsText || '[]' }}</div>
        </div>
        <div>
          <div class="text-[12px] font-semibold leading-5 text-slate-700">blocked_domains</div>
          <div class="whitespace-pre-wrap font-mono text-[12px] leading-5 text-slate-500">{{ blockedDomainsText || '[]' }}</div>
        </div>
        <div>
          <div class="text-[12px] font-semibold leading-5 text-slate-700">query</div>
          <div class="whitespace-pre-wrap font-mono text-[12px] leading-5 text-slate-500">{{ query || '' }}</div>
        </div>
        <div>
          <div class="text-[12px] font-semibold leading-5 text-slate-700">tool_result.content</div>
          <MarkdownContent v-if="resultContentText" :content="resultContentText" muted />
          <div v-else class="text-[12px] leading-5 text-slate-500"></div>
        </div>
      </div>
    </div>
  </div>
</template>
