<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import TimelineCliSubrow from './TimelineCliSubrow.vue'
import { useSessionStore } from '../stores/session'
import { stringifyStructuredValue } from '../../../shared/transcript-normalizer.js'
import type { InteractiveOption, SdkElicitationInteraction } from '../../../shared/message-types.js'

const props = defineProps<{
  interaction: SdkElicitationInteraction
  attached?: boolean
}>()

const session = useSessionStore()
const genericInput = ref('')
const selectValue = ref('')

type GenericSingleSelect = {
  field: string
  prompt: string
  description?: string
  options: InteractiveOption[]
  defaultValue?: string
}

type RendererType = 'url' | 'single_select' | 'generic_json_fallback'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function getOptionsFromEnumSchema(property: Record<string, unknown>): InteractiveOption[] {
  const enumValues = Array.isArray(property.enum)
    ? property.enum.filter((option): option is string => typeof option === 'string' && option.trim().length > 0)
    : null
  if (!enumValues || enumValues.length === 0) return []
  return enumValues.map((value) => ({ value, label: value }))
}

function parseGenericSingleSelect(interaction: SdkElicitationInteraction): GenericSingleSelect | null {
  const schema = asRecord(interaction.requestedSchema)
  if (!schema) return null

  const directProperties = asRecord(schema.properties)
  if (directProperties && Object.keys(directProperties).length === 1) {
    const field = Object.keys(directProperties)[0] || 'value'
    const property = asRecord(directProperties[field])
    if (property && property.type === 'string') {
      const options = getOptionsFromEnumSchema(property)
      if (options.length > 0) {
        return {
          field,
          prompt: getString(property.title) || interaction.message || interaction.serverName,
          description: getString(property.description) || interaction.message,
          options,
          defaultValue: getString(property.default),
        }
      }
    }
  }

  const answersProperty = asRecord(directProperties?.answers)
  const answerProperties = asRecord(answersProperty?.properties)
  if (!answerProperties) return null
  const field = Object.keys(answerProperties)[0] || 'value'
  const property = asRecord(answerProperties[field])
  if (!property || property.type !== 'string') return null
  const options = getOptionsFromEnumSchema(property)
  if (options.length === 0) return null

  return {
    field,
    prompt: getString(property.title) || interaction.message || interaction.serverName,
    description: getString(property.description) || interaction.message,
    options,
    defaultValue: getString(property.default),
  }
}

const genericSingleSelect = computed(() => parseGenericSingleSelect(props.interaction))
const rendererType = computed<RendererType>(() => {
  if (props.interaction.mode === 'url') return 'url'
  if (genericSingleSelect.value) return 'single_select'
  return 'generic_json_fallback'
})

const title = computed(() => genericSingleSelect.value?.prompt || props.interaction.message || props.interaction.serverName || 'Interaction required')
const description = computed(() => genericSingleSelect.value?.description || props.interaction.message || '')
const interactionUrl = computed(() => props.interaction.url)
const requestedSchemaText = computed(() => props.interaction.requestedSchema ? stringifyStructuredValue(props.interaction.requestedSchema) : '')
const genericHint = computed(() => rendererType.value === 'url'
  ? 'Open the interaction URL and complete the requested step, then confirm or provide any follow-up details here.'
  : '当前提供最小闭环输入。可直接填写 JSON；若不是 JSON，将作为 value 字段提交。')
const genericPlaceholder = computed(() =>
  rendererType.value === 'url'
    ? '可填写结果说明，或直接留空后提交确认。'
    : '{"key":"value"} 或直接输入文本'
)

function getDefaultAnswer(question: { defaultValue?: string; options: InteractiveOption[] } | null): string {
  if (!question) return ''
  const matchedDefault = question.defaultValue && question.options.some((option) => option.value === question.defaultValue)
    ? question.defaultValue
    : undefined
  return matchedDefault || question.options[0]?.value || ''
}

function submitGenericSingleSelect() {
  if (!genericSingleSelect.value) return
  session.respondToInteraction({
    kind: 'elicitation',
    action: 'accept',
    content: {
      [genericSingleSelect.value.field]: selectValue.value,
    },
  })
  selectValue.value = ''
}

function submitGenericFallback() {
  const text = genericInput.value.trim()
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

  genericInput.value = ''
}

function submitCurrent() {
  if (rendererType.value === 'single_select') {
    submitGenericSingleSelect()
    return
  }
  submitGenericFallback()
}

watch(
  () => props.interaction.id,
  () => {
    genericInput.value = ''
    selectValue.value = getDefaultAnswer(genericSingleSelect.value)
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

    <template v-if="rendererType === 'single_select' && genericSingleSelect">
      <label
        v-for="option in genericSingleSelect.options"
        :key="`${interaction.id}-${option.value}`"
        class="flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-[12px] leading-5 transition-colors"
        :class="selectValue === option.value
          ? 'border-amber-300 bg-white/90 text-slate-700'
          : 'border-amber-100/80 bg-white/65 text-slate-500 hover:border-amber-200 hover:bg-white/80'"
      >
        <input
          v-model="selectValue"
          type="radio"
          :name="`${interaction.id}`"
          class="mt-1"
          :value="option.value"
        >
        <span class="min-w-0 flex-1 text-slate-700">{{ option.label }}</span>
      </label>
      <div class="flex gap-3 text-sm">
        <button class="timeline-cli-button text-slate-700" @click="submitCurrent">Submit</button>
        <button class="timeline-cli-button" @click="session.respondToInteraction({ kind: 'elicitation', action: 'decline' })">Decline</button>
        <button class="timeline-cli-button" @click="session.respondToInteraction({ kind: 'elicitation', action: 'cancel' })">Cancel interaction</button>
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
            v-model="genericInput"
            rows="4"
            class="w-full resize-y rounded-lg border border-slate-200 bg-white/95 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400"
            :placeholder="genericPlaceholder"
          />
          <div class="flex gap-3 text-sm">
            <button class="timeline-cli-button text-slate-700" @click="submitCurrent">Submit</button>
            <button class="timeline-cli-button" @click="session.respondToInteraction({ kind: 'elicitation', action: 'decline' })">Decline</button>
            <button class="timeline-cli-button" @click="session.respondToInteraction({ kind: 'elicitation', action: 'cancel' })">Cancel interaction</button>
          </div>
        </div>
      </TimelineCliSubrow>
    </template>
  </div>
</template>
