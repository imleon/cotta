<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import TimelineCliSubrow from './TimelineCliSubrow.vue'
import TimelinePermissionRequestBlock from './TimelinePermissionRequestBlock.vue'
import TimelineRow from './TimelineRow.vue'
import { useSessionStore } from '../stores/session'
import {
  stringifyStructuredValue,
} from '../../../shared/transcript-normalizer.js'
import type { PendingElicitationInteraction, PendingPermissionInteraction } from '../../../shared/message-types.js'
import type { TimelineItem } from '../stores/session'

type QuestionOption = {
  value: string
  label: string
}

type AskUserQuestionSingleSelect = {
  field: string
  prompt: string
  description?: string
  options: QuestionOption[]
  defaultValue?: string
  questionText: string
}

const session = useSessionStore()
const container = ref<HTMLElement>()
const elicitationInput = ref('')
const elicitationAnswer = ref('')
const preservingOlderScroll = ref(false)
const initialHistoryAutoScrollPending = ref(true)
const pendingAutoScrollFrame = ref<number | null>(null)
const debugMetaVisible = ref(false)
const observabilityItems = computed(() => session.observabilityEvents.slice().reverse())
const visibleTimelineItems = computed(() => session.timeline)
const pendingPermissionInteraction = computed<PendingPermissionInteraction | null>(() =>
  session.pendingInteraction?.kind === 'permission' ? session.pendingInteraction : null
)
const pendingElicitationInteraction = computed<PendingElicitationInteraction | null>(() =>
  session.pendingInteraction?.kind === 'elicitation' ? session.pendingInteraction : null
)
const askUserQuestion = computed(() => parseAskUserQuestionSingleSelect(pendingElicitationInteraction.value))
const pendingInteractionTitle = computed(() => {
  const interaction = session.pendingInteraction
  if (!interaction) return 'Pending interaction'
  if (interaction.kind === 'permission') {
    return interaction.title || interaction.displayName || interaction.toolName || 'Pending interaction'
  }
  return askUserQuestion.value?.prompt || interaction.serverName || 'Pending interaction'
})
const pendingInteractionDescription = computed(() => {
  const interaction = session.pendingInteraction
  if (!interaction) return ''
  if (interaction.kind === 'permission') {
    return interaction.description || ''
  }
  return askUserQuestion.value?.description || interaction.message || ''
})
const pendingInteractionReason = computed(() =>
  session.pendingInteraction?.kind === 'permission' ? session.pendingInteraction.decisionReason || '' : ''
)
const pendingInteractionUrl = computed(() =>
  session.pendingInteraction?.kind === 'elicitation' ? session.pendingInteraction.url : undefined
)
const pendingInteractionSchema = computed(() =>
  session.pendingInteraction?.kind === 'elicitation' ? session.pendingInteraction.requestedSchema : undefined
)

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function getBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function normalizeOption(option: unknown): QuestionOption | null {
  if (typeof option === 'string' && option.trim().length > 0) {
    return { value: option, label: option }
  }

  const record = asRecord(option)
  if (!record) return null

  const value = getString(record.value) || getString(record.id) || getString(record.key) || getString(record.label) || getString(record.text) || getString(record.title)
  if (!value) return null

  return {
    value,
    label: getString(record.label) || getString(record.text) || getString(record.title) || value,
  }
}

function parseAskUserQuestionSingleSelect(interaction: PendingElicitationInteraction | null): AskUserQuestionSingleSelect | null {
  if (!interaction || interaction.serverName !== 'AskUserQuestion') return null

  const schema = asRecord(interaction.requestedSchema)
  const answersProperty = asRecord(asRecord(schema?.properties)?.answers)
  const answerProperties = asRecord(answersProperty?.properties)
  if (!answerProperties) return null

  const [questionText, rawProperty] = Object.entries(answerProperties)[0] || []
  if (!questionText) return null

  const property = asRecord(rawProperty)
  if (!property) return null

  const optionValues = Array.isArray(property.enum)
    ? property.enum.filter((option): option is string => typeof option === 'string' && option.trim().length > 0)
    : null
  if (!optionValues || optionValues.length === 0) return null

  const prompt = getString(property.title) || questionText || interaction.message || interaction.serverName
  if (!prompt) return null

  return {
    field: 'answers',
    prompt,
    description: getString(property.description),
    options: optionValues.map((value) => ({ value, label: value })),
    defaultValue: getString(property.default),
    questionText,
  }
}

function getDefaultAnswer(question: AskUserQuestionSingleSelect | null): string {
  if (!question) return ''
  const matchedDefault = question.defaultValue && question.options.some((option) => option.value === question.defaultValue)
    ? question.defaultValue
    : undefined
  return matchedDefault || question.options[0]?.value || ''
}

function itemHasToolUseId(item: TimelineItem, toolUseId: string): boolean {
  if (item.kind === 'assistant') {
    return item.fragments.some((fragment) => fragment.type === 'tool_use' && fragment.toolUseId === toolUseId)
  }
  if (item.kind === 'grouped_tool_use') {
    return item.toolUses.some((tool) => tool.toolUseId === toolUseId)
  }
  if (item.kind === 'collapsed_tool_batch') {
    return item.items.some((child) => itemHasToolUseId(child, toolUseId))
  }
  return false
}

const isPendingPermissionAttached = computed(() => {
  const toolUseId = pendingPermissionInteraction.value?.toolUseId
  if (!toolUseId) return false
  return visibleTimelineItems.value.some((item) => itemHasToolUseId(item, toolUseId))
})

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

function getEventMeta(item: { sequence: number; receivedAt: number }): string {
  return `seq=${item.sequence} time=${item.receivedAt}`
}

function getEventPayload(item: { payload: unknown }): string {
  return stringifyStructuredValue(item.payload)
}

function renderObservabilityTitle(payload: Record<string, unknown> | null | undefined): string {
  if (!payload || typeof payload !== 'object') return 'unknown'
  const type = typeof payload.type === 'string' ? payload.type : 'unknown'
  const subtype = typeof payload.subtype === 'string' ? payload.subtype : ''
  return subtype ? `${type}.${subtype}` : type
}

function isNearBottom(): boolean {
  const el = container.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 120
}

async function scrollToBottom() {
  await nextTick()
  if (!container.value) return
  container.value.scrollTop = container.value.scrollHeight
}

function scheduleAutoScroll() {
  if (pendingAutoScrollFrame.value !== null) {
    cancelAnimationFrame(pendingAutoScrollFrame.value)
  }

  pendingAutoScrollFrame.value = requestAnimationFrame(() => {
    pendingAutoScrollFrame.value = null
    void scrollToBottom()
  })
}

async function maybeLoadOlderHistory() {
  const el = container.value
  if (!el || el.scrollTop > 120) return
  if (!session.historyMessagesHasMore || session.historyMessagesLoading) return

  preservingOlderScroll.value = true
  const previousHeight = el.scrollHeight
  const previousTop = el.scrollTop
  const loaded = await session.loadOlderSessionMessages()
  if (!loaded) {
    preservingOlderScroll.value = false
    return
  }

  await nextTick()
  const nextHeight = el.scrollHeight
  el.scrollTop = nextHeight - previousHeight + previousTop
  preservingOlderScroll.value = false
}

function handleScroll() {
  void maybeLoadOlderHistory()
}

function submitAskUserQuestion() {
  if (!askUserQuestion.value) return
  session.respondToElicitation({
    action: 'accept',
    content: {
      answers: {
        [askUserQuestion.value.questionText]: elicitationAnswer.value,
      },
    },
  })
  elicitationAnswer.value = ''
}

function submitElicitation() {
  if (session.pendingInteraction?.kind !== 'elicitation') return
  if (askUserQuestion.value) {
    submitAskUserQuestion()
    return
  }

  const text = elicitationInput.value.trim()
  if (!text) {
    session.respondToElicitation({ action: 'accept', content: {} })
    return
  }

  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid elicitation payload')
    }
    const normalized: Record<string, string | number | boolean | string[]> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        normalized[key] = value
        continue
      }
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        normalized[key] = value
      }
    }
    session.respondToElicitation({ action: 'accept', content: normalized })
  } catch {
    session.respondToElicitation({ action: 'accept', content: { value: text } })
  }

  elicitationInput.value = ''
}

watch(
  () => session.currentSessionId,
  () => {
    initialHistoryAutoScrollPending.value = true
  },
)

watch(
  () => session.historyMessages.length,
  async (next, prev) => {
    if (next === 0 || next === prev || preservingOlderScroll.value) return
    if (!initialHistoryAutoScrollPending.value) return
    if (session.historyMessagesLoadingOlder) return
    initialHistoryAutoScrollPending.value = false
    await scrollToBottom()
  },
)

watch(
  () => [session.timeline.length, session.observabilityEvents.length, session.pendingInteraction?.id],
  async () => {
    if (preservingOlderScroll.value || session.historyMessagesLoadingOlder) return
    if (!isNearBottom()) return
    scheduleAutoScroll()
  },
  { deep: true },
)

watch(
  () => session.pendingInteraction?.id,
  () => {
    elicitationInput.value = ''
    elicitationAnswer.value = getDefaultAnswer(askUserQuestion.value)
  }
)
</script>

<template>
  <div ref="container" class="flex-1 overflow-y-auto bg-slate-50/70 px-6 py-6 space-y-3" @scroll="handleScroll">

    <div
      v-if="session.historyMessagesLoadingOlder"
      class="flex justify-center text-xs text-gray-400"
    >
      正在加载更早消息…
    </div>

    <div
      v-if="visibleTimelineItems.length === 0"
      class="flex items-center justify-center h-full text-gray-400"
    >
      <div class="text-center">
        <p class="text-4xl mb-4">C</p>
        <p class="text-lg">Inspect SDK-native interactions in Cotta</p>
      </div>
    </div>

    <div class="mb-1 flex items-center justify-end">
      <button
        class="timeline-cli-button"
        @click="debugMetaVisible = !debugMetaVisible"
      >
        {{ debugMetaVisible ? 'Hide debug' : 'Show debug' }}
      </button>
    </div>

    <TimelineRow
      v-for="item in visibleTimelineItems"
      :key="item.key"
      :item="item"
      :show-debug-meta="debugMetaVisible"
    />

    <div v-if="session.pendingInteraction && (!isPendingPermissionAttached || session.pendingInteraction.kind !== 'permission')" class="space-y-3">
      <div class="text-slate-900">
        {{ session.pendingInteraction.kind === 'permission' ? 'Permission required' : 'Interaction required' }}
        <span class="text-slate-500"> · {{ pendingInteractionTitle }}</span>
      </div>
      <TimelineCliSubrow v-if="pendingInteractionDescription">
        <div>{{ pendingInteractionDescription }}</div>
      </TimelineCliSubrow>
      <TimelineCliSubrow v-if="pendingInteractionReason" muted>
        <div>{{ pendingInteractionReason }}</div>
      </TimelineCliSubrow>
      <TimelineCliSubrow v-if="pendingInteractionUrl">
        <a
          :href="pendingInteractionUrl"
          target="_blank"
          rel="noreferrer"
          class="text-sm text-slate-600 underline underline-offset-2 hover:text-sky-700"
        >
          Open interaction URL
        </a>
      </TimelineCliSubrow>
      <div v-if="session.pendingInteraction.kind === 'permission' && pendingPermissionInteraction" class="pl-7">
        <TimelinePermissionRequestBlock :interaction="pendingPermissionInteraction" />
      </div>
      <div v-else class="space-y-3">
        <template v-if="askUserQuestion">
          <TimelineCliSubrow no-prefix>
            <div class="min-w-0 flex-1 space-y-3 rounded-xl border border-amber-200/80 bg-amber-50/70 px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]">
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-5 text-slate-700">
                <span class="font-medium text-amber-900">Question required</span>
                <span class="text-slate-400">·</span>
                <span class="text-slate-600">{{ askUserQuestion.prompt }}</span>
              </div>
              <div v-if="askUserQuestion.description" class="text-[12px] leading-5 text-slate-600">
                {{ askUserQuestion.description }}
              </div>
              <label
                v-for="option in askUserQuestion.options"
                :key="`${session.pendingInteraction?.id}-${askUserQuestion.questionText}-${option.value}`"
                class="flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-[12px] leading-5 transition-colors"
                :class="elicitationAnswer === option.value
                  ? 'border-amber-300 bg-white/90 text-slate-700'
                  : 'border-amber-100/80 bg-white/65 text-slate-500 hover:border-amber-200 hover:bg-white/80'"
              >
                <input
                  v-model="elicitationAnswer"
                  type="radio"
                  :name="`${session.pendingInteraction?.id}-${askUserQuestion.questionText}`"
                  class="mt-1"
                  :value="option.value"
                >
                <span class="min-w-0 flex-1 text-slate-700">{{ option.label }}</span>
              </label>
              <div class="flex gap-3 text-sm">
                <button class="timeline-cli-button text-slate-700" @click="submitAskUserQuestion">Submit</button>
                <button class="timeline-cli-button" @click="session.respondToElicitation({ action: 'decline' })">Decline</button>
                <button class="timeline-cli-button" @click="session.respondToElicitation({ action: 'cancel' })">Cancel interaction</button>
              </div>
            </div>
          </TimelineCliSubrow>
        </template>
        <template v-else>
          <TimelineCliSubrow muted>
            <div>当前提供最小闭环输入。可直接填写 JSON；若不是 JSON，将作为 value 字段提交。</div>
          </TimelineCliSubrow>
          <TimelineCliSubrow v-if="pendingInteractionSchema" muted>
            <pre class="whitespace-pre-wrap text-xs text-slate-500">{{ stringifyStructuredValue(pendingInteractionSchema) }}</pre>
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
                <button class="timeline-cli-button" @click="session.respondToElicitation({ action: 'cancel' })">Cancel interaction</button>
              </div>
            </div>
          </TimelineCliSubrow>
        </template>
      </div>
    </div>

    <div v-if="observabilityItems.length > 0" class="space-y-2">
      <div class="timeline-cli-meta">Observability events</div>
      <div
        v-for="item in observabilityItems"
        :key="`telemetry-${item.sequence}`"
        class="space-y-1"
      >
        <TimelineCliSubrow muted>
          <div class="min-w-0 flex-1 space-y-1">
            <div class="text-slate-600">{{ renderObservabilityTitle(item.payload as Record<string, unknown> | undefined) }}</div>
            <div class="timeline-cli-meta">{{ getEventMeta(item) }}</div>
            <pre class="whitespace-pre-wrap text-xs text-slate-500">{{ getEventPayload(item) }}</pre>
          </div>
        </TimelineCliSubrow>
      </div>
    </div>

    <TimelineCliSubrow v-if="session.isLoading" muted>
      <div class="flex space-x-1.5 pt-0.5">
        <div class="h-2 w-2 rounded-full bg-gray-400 animate-bounce" style="animation-delay: 0ms" />
        <div class="h-2 w-2 rounded-full bg-gray-400 animate-bounce" style="animation-delay: 150ms" />
        <div class="h-2 w-2 rounded-full bg-gray-400 animate-bounce" style="animation-delay: 300ms" />
      </div>
    </TimelineCliSubrow>
  </div>
</template>
