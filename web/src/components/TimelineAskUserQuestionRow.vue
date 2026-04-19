<script setup lang="ts">
import { computed, ref } from 'vue'
import MarkdownContent from './MarkdownContent.vue'
import { stringifyStructuredValue } from '../../../runtime/protocol/transcript-normalizer.js'

type QuestionOption = {
  label?: string
  description?: string
}

type AskQuestion = {
  header?: string
  question?: string
  multiSelect?: boolean
  options?: QuestionOption[]
}

const props = withDefaults(defineProps<{
  subtitle?: string
  input?: unknown
  output?: unknown
  raw?: unknown
}>(), {
  subtitle: '',
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

function getQuestionsFromInput(value: unknown): AskQuestion[] {
  const record = getObject(value)
  const rawQuestions = record?.questions
  if (!Array.isArray(rawQuestions)) return []
  return rawQuestions
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      header: typeof item.header === 'string' ? item.header : '',
      question: typeof item.question === 'string' ? item.question : '',
      multiSelect: item.multiSelect === true,
      options: Array.isArray(item.options)
        ? item.options
            .filter((opt): opt is Record<string, unknown> => Boolean(opt) && typeof opt === 'object')
            .map((opt) => ({
              label: typeof opt.label === 'string' ? opt.label : '',
              description: typeof opt.description === 'string' ? opt.description : '',
            }))
        : [],
    }))
}

function getToolUseResult(value: unknown): Record<string, unknown> | null {
  const record = getObject(value)
  const direct = getObject(record?.toolUseResult)
  if (direct) return direct
  return getObject(value)
}

function getToolResultMessageText(value: unknown): string {
  const record = getObject(value)
  const message = getObject(record?.message)
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .map((item) => {
      const block = getObject(item)
      if (!block || block.type !== 'tool_result') return ''
      return typeof block.content === 'string' ? block.content : stringifyStructuredValue(block.content)
    })
    .filter(Boolean)
    .join('\n')
}

const questions = computed(() => {
  const fromInput = getQuestionsFromInput(props.input)
  if (fromInput.length > 0) return fromInput
  const fromRaw = getQuestionsFromInput(getToolUseResult(props.raw))
  if (fromRaw.length > 0) return fromRaw
  return getQuestionsFromInput(getToolUseResult(props.output))
})

const optionsText = computed(() =>
  questions.value
    .flatMap((item) =>
      (item.options || []).map((option) => {
        const label = option.label || ''
        const description = option.description ? ` - ${option.description}` : ''
        return `${label}${description}`.trim()
      }))
    .join('\n')
)

const questionsText = computed(() =>
  questions.value
    .map((item) => {
      const label = item.header ? `${item.header}：` : ''
      const question = item.question || ''
      const suffix = item.multiSelect ? ' [multi]' : ''
      return `${label}${question}${suffix}`.trim()
    })
    .join('\n')
)

const answersText = computed(() => {
  return getToolResultMessageText(props.raw)
    || getToolResultMessageText(props.output)
})
</script>

<template>
  <div class="overflow-hidden rounded-xl border border-slate-200/70">
    <button
      type="button"
      class="group flex w-full cursor-pointer items-center gap-1 bg-slate-50/80 px-3 py-2 text-left text-[13px] leading-6 text-slate-700 hover:bg-slate-100/60"
      @click="expanded = !expanded"
    >
      <span class="inline-flex h-6 w-6 shrink-0 items-center justify-center text-[15px] leading-6 text-slate-600">❓</span>
      <span class="flex min-w-0 flex-1 items-center">
        <span class="font-medium text-slate-900">AskUserQuestion</span>
        <span v-if="subtitle" class="ml-2 truncate text-slate-500">{{ subtitle }}</span>
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
          <div class="text-[12px] font-semibold leading-5 text-slate-700">questions</div>
          <div class="whitespace-pre-wrap font-mono text-[12px] leading-5 text-slate-500">{{ questionsText || '' }}</div>
        </div>
        <div>
          <div class="text-[12px] font-semibold leading-5 text-slate-700">options</div>
          <div class="whitespace-pre-wrap font-mono text-[12px] leading-5 text-slate-500">{{ optionsText || '' }}</div>
        </div>
        <div>
          <div class="text-[12px] font-semibold leading-5 text-slate-700">answers</div>
          <MarkdownContent v-if="answersText" :content="answersText" muted />
          <div v-else class="text-[12px] leading-5 text-slate-500"></div>
        </div>
      </div>
    </div>
  </div>
</template>
