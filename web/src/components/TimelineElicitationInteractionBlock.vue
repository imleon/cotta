<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import TimelineCliSubrow from './TimelineCliSubrow.vue'
import { useSessionStore } from '../stores/session'
import { stringifyStructuredValue } from '../../../shared/transcript-normalizer.js'
import type { InteractiveOption, PendingAskUserQuestionInteraction, PendingElicitationInteraction } from '../../../shared/message-types.js'

const props = defineProps<{
  interaction: PendingElicitationInteraction | PendingAskUserQuestionInteraction
  attached?: boolean
}>()

const session = useSessionStore()
const elicitationInput = ref('')
const elicitationAnswer = ref('')

type AskUserQuestionSingleSelect = {
  field: string
  prompt: string
  description?: string
  options: InteractiveOption[]
  defaultValue?: string
  answerField: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function parseAskUserQuestionSingleSelect(interaction: PendingElicitationInteraction | PendingAskUserQuestionInteraction): AskUserQuestionSingleSelect | null {
  if (interaction.kind === 'ask_user_question') {
    return {
      field: interaction.field,
      prompt: interaction.prompt,
      description: interaction.description,
      options: interaction.options,
      defaultValue: interaction.defaultValue,
      answerField: interaction.field,
    }
  }

  const schema = asRecord(interaction.requestedSchema)
  const answersProperty = asRecord(asRecord(schema?.properties)?.answers)
  const answerProperties = asRecord(answersProperty?.properties)
  if (!answerProperties) return null

  const field = Object.keys(answerProperties)[0] || 'value'
  const property = asRecord(answerProperties[field])
  if (!property) return null

  const optionValues = Array.isArray(property.enum)
    ? property.enum.filter((option): option is string => typeof option === 'string' && option.trim().length > 0)
    : null
  if (!optionValues || optionValues.length === 0) return null

  const prompt = getString(property.title) || interaction.message || interaction.serverName
  if (!prompt) return null

  return {
    field,
    prompt,
    description: getString(property.description),
    options: optionValues.map((value) => ({ value, label: value })),
    defaultValue: getString(property.default),
    answerField: field,
  }
}

function getDefaultAnswer(question: AskUserQuestionSingleSelect | null): string {
  if (!question) return ''
  const matchedDefault = question.defaultValue && question.options.some((option) => option.value === question.defaultValue)
    ? question.defaultValue
    : undefined
  return matchedDefault || question.options[0]?.value || ''
}

const askUserQuestion = computed(() => parseAskUserQuestionSingleSelect(props.interaction))
const title = computed(() => {
  if (props.interaction.kind === 'ask_user_question') {
    return props.interaction.prompt || 'Question required'
  }
  return askUserQuestion.value?.prompt || props.interaction.message || props.interaction.serverName || 'Interaction required'
})
const description = computed(() => {
  if (props.interaction.kind === 'ask_user_question') {
    return props.interaction.description || ''
  }
  return askUserQuestion.value?.description || props.interaction.message || ''
})
const interactionUrl = computed(() => props.interaction.kind === 'elicitation' ? props.interaction.url : undefined)
const requestedSchemaText = computed(() => props.interaction.kind === 'elicitation' && props.interaction.requestedSchema ? stringifyStructuredValue(props.interaction.requestedSchema) : '')
const genericHint = computed(() => props.interaction.kind === 'elicitation' && props.interaction.mode === 'url'
  ? 'Open the interaction URL and complete the requested step, then submit or cancel here.'
  : '当前提供最小闭环输入。可直接填写 JSON；若不是 JSON，将作为 value 字段提交。')

function submitAskUserQuestion() {
  if (!askUserQuestion.value) return
  session.respondToInteraction({
    kind: 'ask_user_question',
    action: 'accept',
    content: {
      answers: {
        [askUserQuestion.value.answerField]: elicitationAnswer.value,
      },
    },
  })
  elicitationAnswer.value = ''
}

function submitElicitation() {
  if (askUserQuestion.value) {
    submitAskUserQuestion()
    return
  }

  const text = elicitationInput.value.trim()
  if (!text) {
    session.respondToInteraction({ kind: 'elicitation', action: 'accept', content: {} })
    return
  }

  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid elicitation payload')
    }
    session.respondToInteraction({
      kind: 'elicitation',
      action: 'accept',
      content: parsed as Record<string, unknown>,
    })
  } catch {
    session.respondToInteraction({
      kind: 'elicitation',
      action: 'accept',
      content: { value: text },
    })
  }

  elicitationInput.value = ''
}

watch(
  () => props.interaction.id,
  () => {
    elicitationInput.value = ''
    elicitationAnswer.value = getDefaultAnswer(askUserQuestion.value)
  },
  { immediate: true },
)
</script>

<template>
  <div class="space-y-3 rounded-xl border border-amber-200/80 bg-amber-50/70 px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-5 text-slate-700">
      <span class="font-medium text-amber-900">Interaction required</span>
      <span class="text-slate-400">·</span>
      <span class="text-slate-600">{{ title }}</span>
      <span v-if="attached" class="text-slate-400">· attached</span>
    </div>

    <div v-if="description" class="text-[12px] leading-5 text-slate-600">
      {{ description }}
    </div>

    <TimelineCliSubrow v-if="interactionUrl">
      <a
        :href="interactionUrl"
        target="_blank"
        rel="noreferrer"
        class="text-sm text-slate-600 underline underline-offset-2 hover:text-sky-700"
      >
        Open interaction URL
      </a>
    </TimelineCliSubrow>

    <template v-if="askUserQuestion">
      <label
        v-for="option in askUserQuestion.options"
        :key="`${interaction.id}-${askUserQuestion.answerField}-${option.value}`"
        class="flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-[12px] leading-5 transition-colors"
        :class="elicitationAnswer === option.value
          ? 'border-amber-300 bg-white/90 text-slate-700'
          : 'border-amber-100/80 bg-white/65 text-slate-500 hover:border-amber-200 hover:bg-white/80'"
      >
        <input
          v-model="elicitationAnswer"
          type="radio"
          :name="`${interaction.id}-${askUserQuestion.answerField}`"
          class="mt-1"
          :value="option.value"
        >
        <span class="min-w-0 flex-1 text-slate-700">{{ option.label }}</span>
      </label>
      <div class="flex gap-3 text-sm">
        <button class="timeline-cli-button text-slate-700" @click="submitAskUserQuestion">Submit</button>
        <button class="timeline-cli-button" @click="session.respondToInteraction({ kind: 'ask_user_question', action: 'decline' })">Decline</button>
        <button class="timeline-cli-button" @click="session.respondToInteraction({ kind: 'ask_user_question', action: 'cancel' })">Cancel interaction</button>
      </div>
    </template>

    <template v-else>
      <TimelineCliSubrow muted>
        <div>{{ genericHint }}</div>
      </TimelineCliSubrow>
      <TimelineCliSubrow v-if="requestedSchemaText" muted>
        <pre class="whitespace-pre-wrap text-xs text-slate-500">{{ requestedSchemaText }}</pre>
      </TimelineCliSubrow>
      <TimelineCliSubrow no-prefix>
        <div class="min-w-0 flex-1 space-y-3">
          <textarea
            v-model="elicitationInput"
            rows="4"
            class="w-full resize-y rounded-lg border border-slate-200 bg-white/95 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400"
            placeholder='{"key":"value"} 或直接输入文本'
          />
          <div class="flex gap-3 text-sm">
            <button class="timeline-cli-button text-slate-700" @click="submitElicitation">Submit</button>
            <button class="timeline-cli-button" @click="session.respondToInteraction({ kind: 'elicitation', action: 'decline' })">Decline</button>
            <button class="timeline-cli-button" @click="session.respondToInteraction({ kind: 'elicitation', action: 'cancel' })">Cancel interaction</button>
          </div>
        </div>
      </TimelineCliSubrow>
    </template>
  </div>
</template>
