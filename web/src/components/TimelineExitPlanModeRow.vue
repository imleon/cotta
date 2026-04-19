<script setup lang="ts">
import { computed, ref } from 'vue'
import MarkdownContent from './MarkdownContent.vue'
import { stringifyStructuredValue } from '../../../runtime/protocol/transcript-normalizer.js'

const props = withDefaults(defineProps<{
  planFilePath?: string
  input?: unknown
}>(), {
  planFilePath: '',
  input: undefined,
})

const expanded = ref(false)

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
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

const planText = computed(() =>
  toDisplayText(getObject(props.input)?.plan)
)
</script>

<template>
  <div class="overflow-hidden rounded-xl border border-slate-200/70">
    <button
      type="button"
      class="group flex w-full cursor-pointer items-center gap-1 bg-slate-50/80 px-3 py-2 text-left text-[13px] leading-6 text-slate-700 hover:bg-slate-100/60"
      @click="expanded = !expanded"
    >
      <span class="inline-flex h-6 w-6 shrink-0 items-center justify-center text-[15px] leading-6 text-slate-600">🗺️</span>
      <span class="flex min-w-0 flex-1 items-center">
        <span class="font-medium text-slate-900">ExitPlanMode</span>
        <span v-if="planFilePath" class="ml-2 truncate text-slate-500">{{ planFilePath }}</span>
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
      <div class="max-h-72 overflow-auto pr-1">
        <MarkdownContent v-if="planText" :content="planText" muted />
        <div v-else class="text-[12px] leading-5 text-slate-500"></div>
      </div>
    </div>
  </div>
</template>
