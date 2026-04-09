<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLogViewStore } from '../stores/log-view'
import { stringifyStructuredValue } from '../../../shared/transcript-normalizer.js'

const logView = useLogViewStore()
const transportItems = computed(() => logView.transportLog)
const runtimeItems = computed(() => logView.runtimeLog.filter((item) => item.event.type !== 'sdk.transport'))
const channelItems = computed(() => logView.channelLog)
const persistentItems = computed(() => logView.persistentLog.filter((item) => {
  const type = getPersistentType(item.line)
  return type !== 'last-prompt' && type !== 'permission-mode'
}))
const activeItems = computed(() => {
  if (logView.selectedLogTab === 'transport') return transportItems.value
  if (logView.selectedLogTab === 'runtime') return runtimeItems.value
  if (logView.selectedLogTab === 'channel') return channelItems.value
  return persistentItems.value
})
const sortedSessions = computed(() => (
  [...logView.sessions].sort((left, right) => {
    const leftTime = typeof left.updatedAt === 'number' && Number.isFinite(left.updatedAt) ? left.updatedAt : 0
    const rightTime = typeof right.updatedAt === 'number' && Number.isFinite(right.updatedAt) ? right.updatedAt : 0
    return rightTime - leftTime
  })
))
const preservingOlderScroll = ref(false)
const scrollContainer = ref<HTMLElement | null>(null)
const scrollToLatestPending = ref(true)
const transportGridTemplate = '28ch 6ch 24ch 10ch 14ch 18ch 18ch minmax(24ch, 1fr)'
const transportGridStyle = {
  gridTemplateColumns: transportGridTemplate,
  width: 'max-content',
  minWidth: '100%',
}

function getTransportDirectionLabel(direction: string): string {
  return direction === 'inbound' ? 'IN' : 'OUT'
}

function getTransportTitle(item: { event: { eventName: string; sdkType?: string; sdkSubtype?: string } }): string {
  const { eventName, sdkType, sdkSubtype } = item.event
  if (eventName === 'message') {
    if (!sdkType) return 'message'
    return sdkSubtype ? `message(${sdkType}.${sdkSubtype})` : `message(${sdkType})`
  }
  return eventName
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  const base = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).format(date)
  const milliseconds = String(date.getMilliseconds()).padStart(3, '0')
  return `${base}.${milliseconds}`
}

function formatSessionActivity(timestamp?: number): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '----/--/-- --:--'
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '----/--/-- --:--'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date).replace(/\//g, '/')
}

function getDirectionClass(direction: string): string {
  return direction === 'inbound'
    ? 'border-[color:color-mix(in_srgb,var(--tt-success)_35%,white)] bg-[color:color-mix(in_srgb,var(--tt-success)_12%,white)] text-[var(--tt-success)]'
    : 'border-[color:color-mix(in_srgb,var(--tt-accent)_24%,white)] bg-[color:color-mix(in_srgb,var(--tt-accent)_12%,white)] text-[var(--tt-accent)]'
}

function getEventTagClass(eventName: string): string {
  if (eventName === 'message') return 'border-[color:color-mix(in_srgb,var(--tt-primary)_28%,white)] bg-[color:color-mix(in_srgb,var(--tt-primary)_14%,white)] text-[var(--tt-primary-strong)]'
  if (eventName.startsWith('query.')) return 'border-[color:color-mix(in_srgb,var(--tt-warning)_30%,white)] bg-[color:color-mix(in_srgb,var(--tt-warning)_14%,white)] text-[var(--tt-warning)]'
  if (eventName.startsWith('control.')) return 'border-[color:color-mix(in_srgb,var(--tt-coral)_34%,white)] bg-[color:color-mix(in_srgb,var(--tt-coral)_18%,white)] text-[var(--tt-primary-strong)]'
  return 'border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_70%,white)] text-[var(--tt-text-muted)]'
}

function getRowClass(eventName: string): string {
  return eventName === 'query.start'
    ? 'bg-[color:color-mix(in_srgb,var(--tt-success)_8%,white)] hover:bg-[color:color-mix(in_srgb,var(--tt-success)_16%,white)]'
    : 'hover:bg-[color:color-mix(in_srgb,var(--tt-surface)_44%,white)]'
}

function getRuntimeTypeClass(type: string): string {
  if (type.startsWith('run.')) return 'border-[color:color-mix(in_srgb,var(--tt-warning)_30%,white)] bg-[color:color-mix(in_srgb,var(--tt-warning)_14%,white)] text-[var(--tt-warning)]'
  if (type.startsWith('sdk.control.')) return 'border-[color:color-mix(in_srgb,var(--tt-coral)_34%,white)] bg-[color:color-mix(in_srgb,var(--tt-coral)_18%,white)] text-[var(--tt-primary-strong)]'
  if (type === 'sdk.message') return 'border-[color:color-mix(in_srgb,var(--tt-primary)_28%,white)] bg-[color:color-mix(in_srgb,var(--tt-primary)_14%,white)] text-[var(--tt-primary-strong)]'
  if (type === 'sdk.transport') return 'border-[color:color-mix(in_srgb,var(--tt-success)_35%,white)] bg-[color:color-mix(in_srgb,var(--tt-success)_12%,white)] text-[var(--tt-success)]'
  return 'border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_70%,white)] text-[var(--tt-text-muted)]'
}

function getRuntimeRowClass(type: string): string {
  return type === 'run.started'
    ? 'bg-[color:color-mix(in_srgb,var(--tt-success)_6%,white)] hover:bg-[color:color-mix(in_srgb,var(--tt-success)_14%,white)]'
    : 'hover:bg-[color:color-mix(in_srgb,var(--tt-surface)_44%,white)]'
}

function getRuntimeSummary(item: { event: Record<string, unknown> }): string {
  const { event } = item
  if (typeof event.type !== 'string') return '-'
  if (event.type === 'run.state_changed') return typeof event.state === 'string' ? event.state : '-'
  if (event.type === 'run.completed') return typeof event.messageCount === 'number' ? `messages=${event.messageCount}` : '-'
  if (event.type === 'run.failed') return typeof event.error === 'string' ? event.error : '-'
  if (event.type === 'sdk.message') {
    const payload = event.payload
    if (payload && typeof payload === 'object') {
      const record = payload as Record<string, unknown>
      if (typeof record.type === 'string') {
        const subtype = typeof record.subtype === 'string' ? `.${record.subtype}` : ''
        return `${record.type}${subtype}`
      }
    }
  }
  if (event.type === 'sdk.control.requested' || event.type === 'sdk.control.resolved') {
    const interaction = event.interaction
    if (interaction && typeof interaction === 'object') {
      const record = interaction as Record<string, unknown>
      if (typeof record.kind === 'string') return record.kind
    }
  }
  if (event.type === 'sdk.transport') {
    const transportEvent = event.event
    if (transportEvent && typeof transportEvent === 'object') {
      const record = transportEvent as Record<string, unknown>
      return typeof record.eventName === 'string' ? record.eventName : 'sdk.transport'
    }
  }
  return '-'
}

function getRuntimePayload(item: { event: Record<string, unknown> }): unknown {
  const { event } = item
  if (event.type === 'sdk.message') return event.payload
  if (event.type === 'sdk.control.requested' || event.type === 'sdk.control.resolved') return event.payload ?? event.interaction
  if (event.type === 'sdk.transport') return event.event
  return item.event
}

function getChannelDirectionClass(direction: string): string {
  if (direction === 'inbound') return 'border-[color:color-mix(in_srgb,var(--tt-success)_35%,white)] bg-[color:color-mix(in_srgb,var(--tt-success)_12%,white)] text-[var(--tt-success)]'
  if (direction === 'outbound') return 'border-[color:color-mix(in_srgb,var(--tt-accent)_24%,white)] bg-[color:color-mix(in_srgb,var(--tt-accent)_12%,white)] text-[var(--tt-accent)]'
  return 'border-[color:color-mix(in_srgb,var(--tt-warning)_30%,white)] bg-[color:color-mix(in_srgb,var(--tt-warning)_14%,white)] text-[var(--tt-warning)]'
}

function getChannelEventClass(eventName: string): string {
  if (eventName.includes('message')) return 'border-[color:color-mix(in_srgb,var(--tt-primary)_28%,white)] bg-[color:color-mix(in_srgb,var(--tt-primary)_14%,white)] text-[var(--tt-primary-strong)]'
  if (eventName.includes('permission') || eventName.includes('elicitation') || eventName.includes('card-action')) return 'border-[color:color-mix(in_srgb,var(--tt-coral)_34%,white)] bg-[color:color-mix(in_srgb,var(--tt-coral)_18%,white)] text-[var(--tt-primary-strong)]'
  if (eventName.includes('run')) return 'border-[color:color-mix(in_srgb,var(--tt-warning)_30%,white)] bg-[color:color-mix(in_srgb,var(--tt-warning)_14%,white)] text-[var(--tt-warning)]'
  return 'border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_70%,white)] text-[var(--tt-text-muted)]'
}

function getChannelPayload(item: { event: Record<string, unknown> }): unknown {
  return item.event.payload ?? item.event
}

function getPersistentRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function getPersistentTimestamp(item: { loggedAt: number | null; line: string }): string {
  if (typeof item.loggedAt === 'number' && Number.isFinite(item.loggedAt)) {
    return formatTimestamp(item.loggedAt)
  }
  const record = getPersistentRecord(item.line)
  const snapshot = record?.snapshot && typeof record.snapshot === 'object'
    ? record.snapshot as Record<string, unknown>
    : null
  const candidate = typeof record?.timestamp === 'string'
    ? Date.parse(record.timestamp)
    : typeof snapshot?.timestamp === 'string'
      ? Date.parse(snapshot.timestamp)
      : null
  return typeof candidate === 'number' && Number.isFinite(candidate) ? formatTimestamp(candidate) : '-'
}

function getPersistentType(line: string): string {
  const record = getPersistentRecord(line)
  return typeof record?.type === 'string' ? record.type : '-'
}

function formatPersistentJson(line: string): string {
  const record = getPersistentRecord(line)
  return record ? JSON.stringify(record, null, 2) : line
}

const liveButtonClass = computed(() => (
  logView.transportLogLive
    ? 'border-[color:color-mix(in_srgb,var(--tt-success)_35%,white)] bg-[color:color-mix(in_srgb,var(--tt-success)_12%,white)] text-[var(--tt-success)]'
    : 'border-[color:color-mix(in_srgb,var(--tt-warning)_30%,white)] bg-[color:color-mix(in_srgb,var(--tt-warning)_14%,white)] text-[var(--tt-warning)]'
))

const liveButtonLabel = computed(() => {
  if (logView.transportLogLive) {
    return (logView.transportLogRefreshing || logView.runtimeLogRefreshing || logView.channelLogRefreshing || logView.persistentLogRefreshing) ? 'LIVE · SYNCING' : 'LIVE'
  }
  return 'PAUSED'
})

function isNearBottom(): boolean {
  const container = scrollContainer.value
  if (!container) return true
  return container.scrollHeight - container.scrollTop - container.clientHeight <= 120
}

async function scrollToBottom() {
  await nextTick()
  const container = scrollContainer.value
  if (!container) return
  container.scrollTop = container.scrollHeight
}

async function handleScroll() {
  const container = scrollContainer.value
  if (!container || container.scrollTop > 120) return
  if (logView.selectedLogTab !== 'persistent') return
  if (!logView.persistentLogHasMore || logView.persistentLogLoading) return

  logView.pauseSelectedLogFollow()
  preservingOlderScroll.value = true
  const previousHeight = container.scrollHeight
  const previousTop = container.scrollTop
  const loaded = await logView.loadOlderPersistentLogs()
  if (!loaded) {
    preservingOlderScroll.value = false
    return
  }

  await nextTick()
  const nextHeight = container.scrollHeight
  container.scrollTop = nextHeight - previousHeight + previousTop
  preservingOlderScroll.value = false
}

watch(() => logView.selectedSessionId, (next, prev) => {
  if (next && next !== prev) {
    scrollToLatestPending.value = true
  }
})

watch(() => logView.selectedLogTab, (next, prev) => {
  if (next !== prev) {
    scrollToLatestPending.value = true
  }
})

watch(() => activeItems.value.length, async (next, prev) => {
  if (next === prev || preservingOlderScroll.value || next === 0) return
  if (scrollToLatestPending.value) {
    scrollToLatestPending.value = false
    await scrollToBottom()
    return
  }
  if (logView.transportLogLive && next > prev && isNearBottom()) {
    await scrollToBottom()
  }
})

onMounted(() => {
  logView.startSessionListRefresh()
  logView.ensureSessionsLoaded().then(() => {
    if (logView.selectedSessionId) {
      scrollToLatestPending.value = true
      void Promise.all([
        logView.reloadTransportLogs(),
        logView.reloadRuntimeLogs(),
        logView.reloadChannelLogs(),
        logView.reloadPersistentLogs(),
      ])
    }
  })
})

onBeforeUnmount(() => {
  logView.stopSessionListRefresh()
  logView.stopTransportFollow()
  logView.stopRuntimeFollow()
  logView.stopChannelFollow()
  logView.stopPersistentFollow()
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-[var(--tt-surface-soft)] p-3">
    <div class="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col gap-2">
      <div class="border-b border-[var(--tt-border)] pb-2">
        <h2 class="text-sm font-semibold text-[var(--tt-accent)]">SDK logs</h2>
        <p class="mt-0.5 text-[11px] text-[var(--tt-text-subtle)]">同一 session 下可切换查看 transport、runtime、channel 与 persistent 日志。</p>
      </div>

      <div class="flex items-center justify-between gap-2 pb-1">
        <div class="flex min-w-0 items-center gap-2">
          <select
            :value="logView.selectedSessionId || ''"
            class="min-w-[22rem] max-w-[28rem] rounded border border-[var(--tt-border-strong)] bg-white/90 px-2 py-1 font-mono text-[11px] text-[var(--tt-text-muted)]"
            @change="logView.selectSession(($event.target as HTMLSelectElement).value)"
          >
            <option value="" disabled>选择 session</option>
            <option v-for="item in sortedSessions" :key="item.id" :value="item.id">
              {{ formatSessionActivity(item.updatedAt) }}  {{ item.id }}  {{ item.title }}
            </option>
          </select>
          <div class="inline-flex rounded border border-[var(--tt-border)] bg-[var(--tt-card)] p-0.5 text-[11px]">
            <button
              class="rounded px-2 py-1"
              :class="logView.selectedLogTab === 'transport' ? 'bg-[var(--tt-accent)] text-white' : 'text-[var(--tt-text-muted)] hover:bg-[var(--tt-surface-soft)]'"
              @click="logView.selectLogTab('transport')"
            >
              Transport
            </button>
            <button
              class="rounded px-2 py-1"
              :class="logView.selectedLogTab === 'runtime' ? 'bg-[var(--tt-accent)] text-white' : 'text-[var(--tt-text-muted)] hover:bg-[var(--tt-surface-soft)]'"
              @click="logView.selectLogTab('runtime')"
            >
              Runtime
            </button>
            <button
              class="rounded px-2 py-1"
              :class="logView.selectedLogTab === 'channel' ? 'bg-[var(--tt-accent)] text-white' : 'text-[var(--tt-text-muted)] hover:bg-[var(--tt-surface-soft)]'"
              @click="logView.selectLogTab('channel')"
            >
              Channel
            </button>
            <button
              class="rounded px-2 py-1"
              :class="logView.selectedLogTab === 'persistent' ? 'bg-[var(--tt-accent)] text-white' : 'text-[var(--tt-text-muted)] hover:bg-[var(--tt-surface-soft)]'"
              @click="logView.selectLogTab('persistent')"
            >
              Persistent
            </button>
          </div>
          <div class="truncate text-[11px] text-[var(--tt-text-subtle)]">
            <span class="text-[var(--tt-text-subtle)]">session:</span>
            <span class="ml-1 text-[var(--tt-accent)]">{{ logView.selectedSessionId || 'none' }}</span>
          </div>
        </div>
        <button
          class="rounded border px-2 py-1 text-[11px] font-semibold tracking-wide disabled:cursor-not-allowed disabled:opacity-50"
          :class="liveButtonClass"
          :disabled="!logView.selectedSessionId || (logView.selectedLogTab === 'transport' ? logView.transportLogLoading : logView.selectedLogTab === 'runtime' ? logView.runtimeLogLoading : logView.selectedLogTab === 'channel' ? logView.channelLogLoading : logView.persistentLogLoading)"
          @click="logView.toggleTransportLive"
        >
          {{ liveButtonLabel }}
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-hidden rounded border border-[var(--tt-border)] bg-[var(--tt-card)] font-mono">
        <template v-if="logView.selectedLogTab === 'transport'">
          <div v-if="transportItems.length === 0" class="flex h-full items-center justify-center p-6 text-center text-sm text-[var(--tt-text-subtle)]">
            No SDK transport logs yet.
          </div>

          <div v-else ref="scrollContainer" class="h-full overflow-auto" @scroll="handleScroll">
            <div class="sticky top-0 z-10 grid gap-3 border-b border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_74%,white)] px-3 py-2 text-[10px] uppercase tracking-wide text-[var(--tt-text-subtle)]" :style="transportGridStyle">
              <div>Time</div>
              <div>Dir</div>
              <div>Transport Event</div>
              <div>Seq</div>
              <div>Run ID</div>
              <div>Request ID</div>
              <div>Tool Use ID</div>
              <div>Summary</div>
            </div>
            <div
              v-for="item in transportItems"
              :key="`sdk-transport-${item.runId}-${item.event.sequence}-${item.event.receivedAt}`"
              class="grid gap-3 border-b border-[color:color-mix(in_srgb,var(--tt-border)_72%,white)] px-3 py-2 text-[11px] leading-5 transition-colors last:border-b-0"
              :class="getRowClass(item.event.eventName)"
              :style="transportGridStyle"
            >
              <div class="shrink-0 whitespace-nowrap text-[var(--tt-text-subtle)]">{{ formatTimestamp(item.event.receivedAt) }}</div>
              <div>
                <span class="inline-flex min-w-[3.5ch] justify-center rounded border px-1.5 py-0 font-medium" :class="getDirectionClass(item.event.direction)">
                  {{ getTransportDirectionLabel(item.event.direction) }}
                </span>
              </div>
              <div class="min-w-0">
                <span class="inline-flex whitespace-nowrap rounded border px-1.5 py-0 font-medium align-top" :class="getEventTagClass(item.event.eventName)">
                  {{ getTransportTitle(item) }}
                </span>
              </div>
              <div class="shrink-0 text-[var(--tt-text-subtle)]">#{{ item.event.sequence }}</div>
              <div class="shrink-0 text-[var(--tt-text-subtle)]">{{ item.runId.slice(0, 8) }}</div>
              <div class="truncate text-[var(--tt-text-subtle)]">{{ item.event.requestId || '-' }}</div>
              <div class="truncate text-[var(--tt-text-subtle)]">{{ item.event.toolUseId || '-' }}</div>
              <div class="min-w-0">
                <div v-if="item.event.payloadSummary" class="truncate text-[var(--tt-text-muted)]">
                  {{ item.event.payloadSummary }}
                </div>
                <details v-if="item.event.payload !== undefined" class="mt-1 rounded border border-[color:color-mix(in_srgb,var(--tt-border)_72%,white)] bg-[color:color-mix(in_srgb,var(--tt-surface)_72%,white)] px-2 py-1">
                  <summary class="cursor-pointer text-[var(--tt-success)] hover:text-[var(--tt-accent)]">Payload</summary>
                  <pre class="mt-1 overflow-x-auto border border-[color:color-mix(in_srgb,var(--tt-accent)_18%,white)] bg-[var(--tt-accent)] px-2 py-2 text-[11px] text-[#F8F4EF]">{{ stringifyStructuredValue(item.event.payload) }}</pre>
                </details>
              </div>
            </div>
          </div>
        </template>

        <template v-else-if="logView.selectedLogTab === 'runtime'">
          <div v-if="runtimeItems.length === 0" class="flex h-full items-center justify-center p-6 text-center text-sm text-[var(--tt-text-subtle)]">
            No runtime logs yet.
          </div>

          <div v-else ref="scrollContainer" class="h-full overflow-auto" @scroll="handleScroll">
            <div class="sticky top-0 z-10 grid grid-cols-[28ch_16ch_10ch_14ch_minmax(28ch,1fr)] gap-3 border-b border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_74%,white)] px-3 py-2 text-[10px] uppercase tracking-wide text-[var(--tt-text-subtle)]">
              <div>Time</div>
              <div>Runtime Event</div>
              <div>Seq</div>
              <div>Run ID</div>
              <div>Details</div>
            </div>
            <div
              v-for="item in runtimeItems"
              :key="`runtime-${item.runId}-${item.cursor}`"
              class="grid grid-cols-[28ch_16ch_10ch_14ch_minmax(28ch,1fr)] gap-3 border-b border-[color:color-mix(in_srgb,var(--tt-border)_72%,white)] px-3 py-2 text-[11px] leading-5 transition-colors last:border-b-0"
              :class="getRuntimeRowClass(item.event.type)"
            >
              <div class="shrink-0 whitespace-nowrap text-[var(--tt-text-subtle)]">{{ formatTimestamp(item.loggedAt) }}</div>
              <div class="min-w-0">
                <span class="inline-flex whitespace-nowrap rounded border px-1.5 py-0 font-medium align-top" :class="getRuntimeTypeClass(item.event.type)">
                  {{ item.event.type }}
                </span>
              </div>
              <div class="shrink-0 text-[var(--tt-text-subtle)]">
                <template v-if="'sequence' in item.event && typeof item.event.sequence === 'number'">#{{ item.event.sequence }}</template>
                <template v-else>-</template>
              </div>
              <div class="shrink-0 text-[var(--tt-text-subtle)]">{{ item.runId.slice(0, 8) }}</div>
              <div class="min-w-0">
                <div class="truncate text-[var(--tt-text-muted)]">{{ getRuntimeSummary(item) }}</div>
                <details class="mt-1 rounded border border-[color:color-mix(in_srgb,var(--tt-border)_72%,white)] bg-[color:color-mix(in_srgb,var(--tt-surface)_72%,white)] px-2 py-1">
                  <summary class="cursor-pointer text-[var(--tt-text-muted)] hover:text-[var(--tt-accent)]">Payload</summary>
                  <pre class="mt-1 overflow-x-auto border border-[color:color-mix(in_srgb,var(--tt-accent)_18%,white)] bg-[var(--tt-accent)] px-2 py-2 text-[11px] text-[#F8F4EF]">{{ stringifyStructuredValue(getRuntimePayload(item)) }}</pre>
                </details>
              </div>
            </div>
          </div>
        </template>

        <template v-else-if="logView.selectedLogTab === 'channel'">
          <div v-if="channelItems.length === 0" class="flex h-full items-center justify-center p-6 text-center text-sm text-[var(--tt-text-subtle)]">
            No channel logs yet.
          </div>

          <div v-else ref="scrollContainer" class="h-full overflow-auto" @scroll="handleScroll">
            <div class="sticky top-0 z-10 grid grid-cols-[28ch_10ch_18ch_16ch_20ch_minmax(28ch,1fr)] gap-3 border-b border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_74%,white)] px-3 py-2 text-[10px] uppercase tracking-wide text-[var(--tt-text-subtle)]">
              <div>Time</div>
              <div>Dir</div>
              <div>Channel Event</div>
              <div>Run ID</div>
              <div>Conversation</div>
              <div>Details</div>
            </div>
            <div
              v-for="item in channelItems"
              :key="`channel-${item.sessionId}-${item.cursor}`"
              class="grid grid-cols-[28ch_10ch_18ch_16ch_20ch_minmax(28ch,1fr)] gap-3 border-b border-[color:color-mix(in_srgb,var(--tt-border)_72%,white)] px-3 py-2 text-[11px] leading-5 transition-colors last:border-b-0 hover:bg-[color:color-mix(in_srgb,var(--tt-surface)_44%,white)]"
            >
              <div class="shrink-0 whitespace-nowrap text-[var(--tt-text-subtle)]">{{ formatTimestamp(item.loggedAt) }}</div>
              <div>
                <span class="inline-flex min-w-[4ch] justify-center rounded border px-1.5 py-0 font-medium" :class="getChannelDirectionClass(item.event.direction)">
                  {{ item.event.direction.toUpperCase() }}
                </span>
              </div>
              <div class="min-w-0">
                <span class="inline-flex whitespace-nowrap rounded border px-1.5 py-0 font-medium align-top" :class="getChannelEventClass(item.event.eventName)">
                  {{ item.event.eventName }}
                </span>
              </div>
              <div class="shrink-0 text-[var(--tt-text-subtle)]">{{ item.runId ? item.runId.slice(0, 8) : '-' }}</div>
              <div class="truncate text-[var(--tt-text-subtle)]">{{ item.event.conversationKey || '-' }}</div>
              <div class="min-w-0">
                <div class="truncate text-[var(--tt-text-muted)]">{{ item.event.payloadSummary || '-' }}</div>
                <details v-if="item.event.payload !== undefined" class="mt-1 rounded border border-[color:color-mix(in_srgb,var(--tt-border)_72%,white)] bg-[color:color-mix(in_srgb,var(--tt-surface)_72%,white)] px-2 py-1">
                  <summary class="cursor-pointer text-[var(--tt-text-muted)] hover:text-[var(--tt-accent)]">Payload</summary>
                  <pre class="mt-1 overflow-x-auto border border-[color:color-mix(in_srgb,var(--tt-accent)_18%,white)] bg-[var(--tt-accent)] px-2 py-2 text-[11px] text-[#F8F4EF]">{{ stringifyStructuredValue(getChannelPayload(item)) }}</pre>
                </details>
              </div>
            </div>
          </div>
        </template>

        <template v-else>
          <div v-if="persistentItems.length === 0" class="flex h-full items-center justify-center p-6 text-center text-sm text-[var(--tt-text-subtle)]">
            No persistent logs yet.
          </div>

          <div v-else ref="scrollContainer" class="h-full overflow-auto" @scroll="handleScroll">
            <div class="sticky top-0 z-10 grid grid-cols-[28ch_20ch_minmax(36ch,1fr)] gap-3 border-b border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_74%,white)] px-3 py-2 text-[10px] uppercase tracking-wide text-[var(--tt-text-subtle)]">
              <div>Time</div>
              <div>Type</div>
              <div>JSON</div>
            </div>
            <div
              v-for="item in persistentItems"
              :key="`persistent-${item.cursor}`"
              class="grid grid-cols-[28ch_20ch_minmax(36ch,1fr)] gap-3 border-b border-[color:color-mix(in_srgb,var(--tt-border)_72%,white)] px-3 py-2 text-[11px] leading-5 transition-colors last:border-b-0 hover:bg-[color:color-mix(in_srgb,var(--tt-surface)_44%,white)]"
            >
              <div class="shrink-0 whitespace-nowrap text-[var(--tt-text-subtle)]">{{ getPersistentTimestamp(item) }}</div>
              <div class="truncate text-[var(--tt-text-muted)]">{{ getPersistentType(item.line) }}</div>
              <details class="rounded border border-[color:color-mix(in_srgb,var(--tt-border)_72%,white)] bg-[color:color-mix(in_srgb,var(--tt-surface)_72%,white)] px-2 py-1">
                <summary class="cursor-pointer text-[var(--tt-text-muted)] hover:text-[var(--tt-accent)]">Formatted JSON</summary>
                <pre class="mt-1 overflow-x-auto whitespace-pre text-[var(--tt-accent)]">{{ formatPersistentJson(item.line) }}</pre>
              </details>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
