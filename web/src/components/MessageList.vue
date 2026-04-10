<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import TimelineCliSubrow from './TimelineCliSubrow.vue'
import TimelineCanUseToolInteractionBlock from './TimelineCanUseToolInteractionBlock.vue'
import TimelineElicitationInteractionBlock from './TimelineElicitationInteractionBlock.vue'
import TimelineRow from './TimelineRow.vue'
import { useSessionStore } from '../stores/session'
import {
  stringifyStructuredValue,
} from '../../../shared/transcript-normalizer.js'
import type { AssistantDisplayItem, SdkElicitationInteraction, PermissionInteraction } from '../../../shared/message-types.js'
import type { TimelineItem } from '../stores/session'

const session = useSessionStore()
const container = ref<HTMLElement>()
const preservingOlderScroll = ref(false)
const initialHistoryAutoScrollPending = ref(true)
const pendingAutoScrollFrame = ref<number | null>(null)
const debugMetaVisible = computed({
  get: () => session.debugTimelineVisible,
  set: (value: boolean) => session.setDebugTimelineVisible(value),
})
const observabilityItems = computed(() => session.observabilityEvents.slice().reverse())
const recentControlTransactions = computed(() => session.recentControlTransactions)
const visibleTimelineItems = computed(() => session.timeline)
const debugExperimentTimestamp = ref(Date.now())
const debugExperimentContent = 'Run failed · Error During Execution\n\nMock error: tool sandbox rejected the request while the stream was still active.'
const debugExperimentSummary = computed(() => ({
  runState: session.runState,
  timelineCount: session.timeline.length,
  previewCount: session.livePreviewItems.length,
  observabilityCount: session.observabilityEvents.length,
  controlCount: session.recentControlTransactions.length,
}))
const debugExperimentCard = computed<AssistantDisplayItem>(() => ({
  kind: 'assistant',
  id: 'debug-experiment-error-result',
  key: 'debug-experiment-error-result',
  timestamp: debugExperimentTimestamp.value,
  atomIds: ['debug-experiment-error-result'],
  messages: [{
    role: 'assistant',
    content: debugExperimentContent,
    timestamp: debugExperimentTimestamp.value,
    blocks: [{
      type: 'text',
      text: debugExperimentContent,
      raw: debugExperimentContent,
    }],
    raw: {
      type: 'result',
      subtype: 'error_during_execution',
      isErrorResult: true,
      message: {
        id: 'debug-experiment-error-result',
        stop_reason: 'error',
        model: 'claude-sonnet-4-5',
        usage: {
          input_tokens: 1234,
          output_tokens: 321,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    },
  }],
  anchorMessage: {
    role: 'assistant',
    content: debugExperimentContent,
    timestamp: debugExperimentTimestamp.value,
    blocks: [{
      type: 'text',
      text: debugExperimentContent,
      raw: debugExperimentContent,
    }],
    raw: {
      type: 'result',
      subtype: 'error_during_execution',
      isErrorResult: true,
      message: {
        id: 'debug-experiment-error-result',
        stop_reason: 'error',
        model: 'claude-sonnet-4-5',
        usage: {
          input_tokens: 1234,
          output_tokens: 321,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    },
  },
  fragments: [{
    type: 'text',
    text: debugExperimentContent,
  }],
  footer: {
    stopReason: 'error',
    model: 'claude-sonnet-4-5',
    usage: {
      inputTokens: 1234,
      outputTokens: 321,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    completedAt: debugExperimentTimestamp.value,
    deltaMs: 4200,
  },
}))
const pendingPermissionInteraction = computed<PermissionInteraction | null>(() =>
  session.pendingInteraction?.kind === 'permission' ? session.pendingInteraction : null
)
const pendingElicitationInteraction = computed<SdkElicitationInteraction | null>(() =>
  session.pendingInteraction?.kind === 'elicitation' ? session.pendingInteraction : null
)
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

const isPendingElicitationAttached = computed(() => {
  const toolUseId = pendingElicitationInteraction.value?.toolUseId
  if (!toolUseId) return false
  return visibleTimelineItems.value.some((item) => itemHasToolUseId(item, toolUseId))
})

function getEventMeta(item: { sequence: number; receivedAt: number }): string {
  return `seq=${item.sequence} time=${item.receivedAt}`
}

function getEventPayload(item: { payload: unknown }): string {
  return stringifyStructuredValue(item.payload)
}

function getControlTransactionMeta(item: { requestId: string; subtype: string; status: string; family: string; direction: string; updatedAt: number }) {
  return `${item.subtype} · ${item.status} · ${item.direction} · ${new Date(item.updatedAt).toLocaleTimeString()}`
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

watch(
  () => session.currentSessionId,
  () => {
    initialHistoryAutoScrollPending.value = true
  },
)

watch(
  () => session.historyTimelineItems.length,
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
</script>

<template>
  <div ref="container" class="flex-1 overflow-y-auto bg-slate-50/70 px-3 py-4 md:px-6 md:py-6 space-y-3" @scroll="handleScroll">

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


    <TimelineRow
      v-for="item in visibleTimelineItems"
      :key="item.key"
      :item="item"
      :show-debug-meta="debugMetaVisible"
    />

    <div v-if="pendingPermissionInteraction && !isPendingPermissionAttached" class="pl-7">
      <TimelineCanUseToolInteractionBlock :interaction="pendingPermissionInteraction" />
    </div>

    <div v-if="pendingElicitationInteraction && !isPendingElicitationAttached" class="pl-7">
      <TimelineElicitationInteractionBlock :interaction="pendingElicitationInteraction" />
    </div>

    <div v-if="debugMetaVisible" class="space-y-2">
      <div class="timeline-cli-meta">Debug experiment</div>
      <TimelineRow :item="debugExperimentCard" />
      <TimelineCliSubrow muted>
        <div class="min-w-0 flex-1 space-y-1">
          <div class="timeline-cli-meta">
            run={{ debugExperimentSummary.runState }} · timeline={{ debugExperimentSummary.timelineCount }} · overlays={{ debugExperimentSummary.previewCount }} · observability={{ debugExperimentSummary.observabilityCount }} · controls={{ debugExperimentSummary.controlCount }}
          </div>
          <div class="text-xs text-slate-500">内容为 mock，但样式与生产 assistant/error 卡片路径一致；不参与 live mainline 语义。</div>
        </div>
      </TimelineCliSubrow>
    </div>

    <div v-if="recentControlTransactions.length > 0" class="space-y-2">
      <div class="timeline-cli-meta">Control transactions</div>
      <div
        v-for="item in recentControlTransactions"
        :key="`control-${item.requestId}`"
        class="space-y-1"
      >
        <TimelineCliSubrow muted>
          <div class="min-w-0 flex-1 space-y-1">
            <div class="text-slate-600">{{ item.requestId }}</div>
            <div class="timeline-cli-meta">{{ getControlTransactionMeta(item) }}</div>
            <pre v-if="item.interaction" class="whitespace-pre-wrap text-xs text-slate-500">{{ stringifyStructuredValue(item.interaction) }}</pre>
          </div>
        </TimelineCliSubrow>
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
