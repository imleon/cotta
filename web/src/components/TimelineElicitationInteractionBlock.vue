<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import TimelineCliSubrow from './TimelineCliSubrow.vue'
import { useSessionStore } from '../stores/session'
import { stringifyStructuredValue } from '../../../shared/transcript-normalizer.js'
import type { SdkElicitationInteraction } from '../../../shared/message-types.js'
import {
  buildElicitationContent,
  inferElicitationRenderer,
  type ElicitationRenderer,
} from '../lib/elicitation-renderer.js'

const props = defineProps<{
  interaction: SdkElicitationInteraction
  attached?: boolean
}>()

const session = useSessionStore()
const genericInput = ref('')
const textValue = ref('')
const selectValue = ref('')
const multiSelectValues = ref<string[]>([])
const booleanValue = ref(false)
const validationError = ref('')

const renderer = computed(() => inferElicitationRenderer(props.interaction))
const title = computed(() => renderer.value.title)
const description = computed(() => renderer.value.description || '')
const requestedSchemaText = computed(() =>
  props.interaction.requestedSchema ? stringifyStructuredValue(props.interaction.requestedSchema) : '',
)
const submitLabel = computed(() => (renderer.value.type === 'url_open' ? 'Continue' : 'Submit'))

function resetState(nextRenderer: ElicitationRenderer) {
  validationError.value = ''
  genericInput.value = ''
  textValue.value = ''
  selectValue.value = ''
  multiSelectValues.value = []
  booleanValue.value = false

  switch (nextRenderer.type) {
    case 'form_text':
      textValue.value = nextRenderer.defaultValue === undefined ? '' : String(nextRenderer.defaultValue)
      break
    case 'form_boolean':
      booleanValue.value = nextRenderer.defaultValue ?? false
      break
    case 'form_single_select':
      selectValue.value = nextRenderer.defaultValue || nextRenderer.options[0]?.value || ''
      break
    case 'form_multi_select':
      multiSelectValues.value = nextRenderer.defaultValue ? [...nextRenderer.defaultValue] : []
      break
    default:
      break
  }
}

watch(
  () => [props.interaction.id, props.interaction.requestedSchema, props.interaction.url, props.interaction.mode],
  () => resetState(renderer.value),
  { immediate: true },
)

function respond(action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) {
  validationError.value = ''
  session.respondToInteraction({
    kind: 'elicitation',
    action,
    ...(content ? { content } : {}),
  })
}

function toggleMultiSelect(optionValue: string) {
  if (multiSelectValues.value.includes(optionValue)) {
    multiSelectValues.value = multiSelectValues.value.filter((value) => value !== optionValue)
    return
  }
  multiSelectValues.value = [...multiSelectValues.value, optionValue]
}

function submitText(rendererValue: Extract<ElicitationRenderer, { type: 'form_text' }>) {
  const trimmed = textValue.value.trim()
  if (rendererValue.required && !trimmed) {
    validationError.value = 'This field is required.'
    return
  }

  if (!trimmed && !rendererValue.required) {
    respond('accept', buildElicitationContent(rendererValue, ''))
    return
  }

  if (rendererValue.valueType === 'string') {
    if (rendererValue.minLength !== undefined && trimmed.length < rendererValue.minLength) {
      validationError.value = `Must be at least ${rendererValue.minLength} characters.`
      return
    }
    if (rendererValue.maxLength !== undefined && trimmed.length > rendererValue.maxLength) {
      validationError.value = `Must be at most ${rendererValue.maxLength} characters.`
      return
    }
    respond('accept', buildElicitationContent(rendererValue, trimmed))
    return
  }

  const numericValue = Number(trimmed)
  if (!Number.isFinite(numericValue)) {
    validationError.value = rendererValue.valueType === 'integer' ? 'Must be a valid integer.' : 'Must be a valid number.'
    return
  }
  if (rendererValue.valueType === 'integer' && !Number.isInteger(numericValue)) {
    validationError.value = 'Must be a valid integer.'
    return
  }
  if (rendererValue.minimum !== undefined && numericValue < rendererValue.minimum) {
    validationError.value = `Must be >= ${rendererValue.minimum}.`
    return
  }
  if (rendererValue.maximum !== undefined && numericValue > rendererValue.maximum) {
    validationError.value = `Must be <= ${rendererValue.maximum}.`
    return
  }
  respond('accept', buildElicitationContent(rendererValue, numericValue))
}

function submitBoolean(rendererValue: Extract<ElicitationRenderer, { type: 'form_boolean' }>) {
  respond('accept', buildElicitationContent(rendererValue, booleanValue.value))
}

function submitSingleSelect(rendererValue: Extract<ElicitationRenderer, { type: 'form_single_select' }>) {
  if (rendererValue.required && !selectValue.value) {
    validationError.value = 'Please select an option.'
    return
  }
  respond('accept', buildElicitationContent(rendererValue, selectValue.value))
}

function submitMultiSelect(rendererValue: Extract<ElicitationRenderer, { type: 'form_multi_select' }>) {
  const selected = multiSelectValues.value
  if (rendererValue.required && selected.length === 0) {
    validationError.value = 'Please select at least one option.'
    return
  }
  if (rendererValue.minSelections !== undefined && selected.length < rendererValue.minSelections) {
    validationError.value = `Please select at least ${rendererValue.minSelections} option(s).`
    return
  }
  if (rendererValue.maxSelections !== undefined && selected.length > rendererValue.maxSelections) {
    validationError.value = `Please select at most ${rendererValue.maxSelections} option(s).`
    return
  }
  respond('accept', buildElicitationContent(rendererValue, selected))
}

function submitGenericFallback() {
  const text = genericInput.value.trim()
  if (!text) {
    respond('accept', {})
    return
  }

  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid elicitation payload')
    }
    respond('accept', parsed as Record<string, unknown>)
  } catch {
    respond('accept', { value: text })
  }
}

function submitCurrent() {
  switch (renderer.value.type) {
    case 'form_text':
      submitText(renderer.value)
      return
    case 'form_boolean':
      submitBoolean(renderer.value)
      return
    case 'form_single_select':
      submitSingleSelect(renderer.value)
      return
    case 'form_multi_select':
      submitMultiSelect(renderer.value)
      return
    case 'url_open':
      respond('accept')
      return
    case 'generic_json_fallback':
      submitGenericFallback()
      return
  }
}
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

    <template v-if="renderer.type === 'url_open'">
      <TimelineCliSubrow no-prefix>
        <a
          :href="renderer.url"
          target="_blank"
          rel="noreferrer"
          class="text-sm text-slate-600 underline underline-offset-2 hover:text-sky-700"
        >
          Open interaction URL
        </a>
      </TimelineCliSubrow>
      <TimelineCliSubrow muted>
        <div>Open the URL, complete the external step, then continue here.</div>
      </TimelineCliSubrow>
    </template>

    <template v-else-if="renderer.type === 'form_text'">
      <TimelineCliSubrow no-prefix>
        <div class="min-w-0 flex-1 space-y-3">
          <input
            v-model="textValue"
            type="text"
            class="w-full rounded-lg border border-slate-200 bg-white/95 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400"
            :placeholder="renderer.placeholder || 'Type your answer'"
          >
          <div class="text-[11px] text-slate-500">
            <span v-if="renderer.format">Format: {{ renderer.format }}</span>
            <span v-if="renderer.minimum !== undefined || renderer.maximum !== undefined">
              <span v-if="renderer.format"> · </span>
              Range: {{ renderer.minimum ?? '-∞' }} to {{ renderer.maximum ?? '+∞' }}
            </span>
          </div>
        </div>
      </TimelineCliSubrow>
    </template>

    <template v-else-if="renderer.type === 'form_boolean'">
      <label class="flex cursor-pointer items-center gap-3 rounded-lg border border-amber-100/80 bg-white/80 px-3 py-2 text-sm text-slate-700">
        <input v-model="booleanValue" type="checkbox">
        <span>{{ renderer.title }}</span>
      </label>
    </template>

    <template v-else-if="renderer.type === 'form_single_select'">
      <label
        v-for="option in renderer.options"
        :key="`${props.interaction.id}-${option.value}`"
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
    </template>

    <template v-else-if="renderer.type === 'form_multi_select'">
      <label
        v-for="option in renderer.options"
        :key="`${props.interaction.id}-${option.value}`"
        class="flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-[12px] leading-5 transition-colors"
        :class="multiSelectValues.includes(option.value)
          ? 'border-amber-300 bg-white/90 text-slate-700'
          : 'border-amber-100/80 bg-white/65 text-slate-500 hover:border-amber-200 hover:bg-white/80'"
      >
        <input
          :checked="multiSelectValues.includes(option.value)"
          type="checkbox"
          class="mt-1"
          @change="toggleMultiSelect(option.value)"
        >
        <span class="min-w-0 flex-1 text-slate-700">{{ option.label }}</span>
      </label>
      <div class="text-[11px] text-slate-500">
        <span v-if="renderer.minSelections !== undefined">Min: {{ renderer.minSelections }}</span>
        <span v-if="renderer.minSelections !== undefined && renderer.maxSelections !== undefined"> · </span>
        <span v-if="renderer.maxSelections !== undefined">Max: {{ renderer.maxSelections }}</span>
      </div>
    </template>

    <template v-else>
      <TimelineCliSubrow muted>
        <div>当前提供最小闭环输入。可直接填写 JSON；若不是 JSON，将作为 value 字段提交。</div>
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
            placeholder='{"key":"value"} 或直接输入文本'
          />
        </div>
      </TimelineCliSubrow>
    </template>

    <div v-if="validationError" class="rounded-lg bg-rose-50 px-3 py-2 text-[12px] leading-5 text-rose-700">
      {{ validationError }}
    </div>

    <div class="flex gap-3 text-sm">
      <button class="timeline-cli-button text-slate-700" @click="submitCurrent">{{ submitLabel }}</button>
      <button class="timeline-cli-button" @click="respond('decline')">Decline</button>
      <button class="timeline-cli-button" @click="respond('cancel')">Cancel interaction</button>
    </div>
  </div>
</template>
