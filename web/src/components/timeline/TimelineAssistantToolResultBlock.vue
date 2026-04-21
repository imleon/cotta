<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import TimelineCliSubrow from './TimelineCliSubrow.vue'
import type { TimelineToolResultFragment, TimelineToolResultMeta } from '../../models/timeline'
import { stringifyStructuredValue } from '../../lib/runtime-format'

const props = withDefaults(defineProps<{
  fragment?: TimelineToolResultFragment
  output?: unknown
  display?: TimelineToolResultMeta
  attachedToParent?: boolean
  showInlineMore?: boolean
  expanded?: boolean
  framed?: boolean
}>(), {
  showInlineMore: true,
  framed: true,
})

const emit = defineEmits<{
  'update:expanded': [value: boolean]
}>()

function buildFallbackDisplayMeta(output: unknown, attachedToParent = false): TimelineToolResultMeta {
  const text = stringifyStructuredValue(output).replace(/\r\n/g, '\n').trim()
  const lineCount = text ? text.split('\n').length : 0
  const charCount = text.length
  const previewLines = text.split('\n').slice(0, 3).join('\n').trim()
  const previewText = previewLines || text.slice(0, 160)
  const lineThreshold = attachedToParent ? 10 : 8
  const charThreshold = attachedToParent ? 400 : 320
  const hasStructuredShape = text.includes('```') || text.includes('{\n') || text.includes('[\n')
  const defaultExpanded = lineCount < 4 && charCount < 140
    ? true
    : !(lineCount > lineThreshold || charCount > charThreshold || hasStructuredShape)

  return {
    previewText,
    lineCount,
    charCount,
    defaultExpanded,
  }
}

const resolvedOutput = computed(() => props.fragment?.output ?? props.output)
const resolvedAttachedToParent = computed(() => props.fragment?.attachedToParent ?? props.attachedToParent ?? false)
const resolvedDisplay = computed(() => props.fragment?.display ?? props.display ?? buildFallbackDisplayMeta(resolvedOutput.value, resolvedAttachedToParent.value))
const internalExpanded = ref(resolvedDisplay.value.defaultExpanded)

watch(
  () => [resolvedDisplay.value.defaultExpanded, resolvedOutput.value] as const,
  ([defaultExpanded]) => {
    internalExpanded.value = defaultExpanded
  },
)

const expanded = computed({
  get: () => props.expanded ?? internalExpanded.value,
  set: (value: boolean) => {
    if (props.expanded === undefined) {
      internalExpanded.value = value
      return
    }
    emit('update:expanded', value)
  },
})

const resultText = computed(() => stringifyStructuredValue(resolvedOutput.value))
const showToggle = computed(() => resolvedDisplay.value.charCount > 0 && !resolvedDisplay.value.defaultExpanded)
const showInlineMore = computed(() => props.showInlineMore && showToggle.value && !expanded.value)
</script>

<template>
  <TimelineCliSubrow muted>
    <div class="space-y-1.5">
      <div
        :class="[
          'min-w-0 text-[12px] leading-5 text-slate-500',
          props.framed ? 'rounded-xl border border-slate-200/70 bg-slate-50/80 px-3 py-2' : '',
        ]"
      >
        <div
          v-if="expanded && resolvedOutput !== undefined"
          class="max-h-72 overflow-auto whitespace-pre-wrap pr-1 text-inherit"
        >{{ resultText }}</div>
        <div v-else-if="resolvedDisplay.previewText" class="text-inherit">
          <span class="whitespace-pre-wrap">{{ resolvedDisplay.previewText }}</span>
          <button
            v-if="showInlineMore"
            class="timeline-cli-button ml-2 inline align-baseline"
            @click="expanded = !expanded"
          >
            more
          </button>
        </div>
      </div>
    </div>
  </TimelineCliSubrow>
</template>
