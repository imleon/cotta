<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLogViewStore } from '../stores/log-view'
import { stringifyStructuredValue } from '../../../shared/transcript-normalizer.js'

const logView = useLogViewStore()
const sdkRawItems = computed(() => logView.sdkRawLog)
const persistentItems = computed(() => logView.persistentLog.filter((item) => {
  const type = getPersistentType(item.line)
  return type !== 'last-prompt' && type !== 'permission-mode'
}))
const activeItems = computed(() => (
  logView.selectedLogTab === 'sdk-raw' ? sdkRawItems.value : persistentItems.value
))
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
const sdkRawGridTemplate = '28ch 16ch 10ch 10ch 14ch 18ch 18ch minmax(28ch, 1fr)'
const sdkRawGridStyle = {
  gridTemplateColumns: sdkRawGridTemplate,
  width: 'max-content',
  minWidth: '100%',
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

function getRawDirectionLabel(direction: string): string {
  if (direction === 'sdk_to_host') return 'SDK→HOST'
  if (direction === 'host_to_sdk') return 'HOST→SDK'
  return 'SDK'
}

function getRawDirectionClass(direction: string): string {
  if (direction === 'sdk_to_host') {
    return 'border-[color:color-mix(in_srgb,var(--tt-success)_32%,white)] bg-[color:color-mix(in_srgb,var(--tt-success)_10%,white)] text-[color:color-mix(in_srgb,var(--tt-success)_88%,var(--tt-text))]'
  }
  if (direction === 'host_to_sdk') {
    return 'border-[color:color-mix(in_srgb,var(--tt-accent)_18%,white)] bg-[color:color-mix(in_srgb,var(--tt-accent)_7%,white)] text-[var(--tt-accent)]'
  }
  return 'border-[color:color-mix(in_srgb,var(--tt-primary)_24%,white)] bg-[color:color-mix(in_srgb,var(--tt-primary)_10%,white)] text-[var(--tt-primary-strong)]'
}

function getRawKindClass(kind: string): string {
  if (kind === 'sdk_message') return 'border-[color:color-mix(in_srgb,var(--tt-primary)_24%,white)] bg-[color:color-mix(in_srgb,var(--tt-primary)_10%,white)] text-[var(--tt-primary-strong)]'
  if (kind === 'control_request') return 'border-[color:color-mix(in_srgb,var(--tt-warning)_26%,white)] bg-[color:color-mix(in_srgb,var(--tt-warning)_11%,white)] text-[color:color-mix(in_srgb,var(--tt-warning)_82%,var(--tt-text))]'
  if (kind === 'control_response') return 'border-[color:color-mix(in_srgb,var(--tt-success)_32%,white)] bg-[color:color-mix(in_srgb,var(--tt-success)_10%,white)] text-[color:color-mix(in_srgb,var(--tt-success)_88%,var(--tt-text))]'
  return 'border-[color:color-mix(in_srgb,var(--tt-coral)_28%,white)] bg-[color:color-mix(in_srgb,var(--tt-coral)_12%,white)] text-[var(--tt-primary-strong)]'
}

function getRawMessageType(item: SessionSdkRawLogEntryLike): string {
  const { event } = item
  if (event.kind === 'sdk_message') {
    const message = event.message as Record<string, unknown>
    const type = typeof message.type === 'string' ? message.type : 'unknown'
    const subtype = typeof message.subtype === 'string' ? `.${message.subtype}` : ''
    return `${type}${subtype}`
  }
  return event.subtype || '-'
}

type SessionSdkRawLogEntryLike = {
  event: {
    kind: string
    direction: string
    requestId?: string
    subtype?: string
    message: unknown
    sequence: number
    receivedAt: number
  }
  runId: string
  loggedAt: number
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
  logView.logLive
    ? 'border-[color:color-mix(in_srgb,var(--tt-success)_35%,white)] bg-[color:color-mix(in_srgb,var(--tt-success)_12%,white)] text-[var(--tt-success)]'
    : 'border-[color:color-mix(in_srgb,var(--tt-warning)_30%,white)] bg-[color:color-mix(in_srgb,var(--tt-warning)_14%,white)] text-[var(--tt-warning)]'
))

const liveButtonLabel = computed(() => {
  if (logView.logLive) {
    return (logView.sdkRawLogRefreshing || logView.persistentLogRefreshing) ? 'LIVE · SYNCING' : 'LIVE'
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
  if (logView.logLive && next > prev && isNearBottom()) {
    await scrollToBottom()
  }
})

onMounted(() => {
  logView.startSessionListRefresh()
  logView.ensureSessionsLoaded().then(() => {
    if (logView.selectedSessionId) {
      scrollToLatestPending.value = true
      void Promise.all([
        logView.reloadSdkRawLogs(),
        logView.reloadPersistentLogs(),
      ])
    }
  })
})

onBeforeUnmount(() => {
  logView.stopSessionListRefresh()
  logView.stopSdkRawFollow()
  logView.stopPersistentFollow()
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-[var(--tt-surface-soft)] p-3">
    <div class="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col gap-2">
      <div class="border-b border-[var(--tt-border)] pb-2">
        <h2 class="text-sm font-semibold text-[var(--tt-accent)]">SDK logs</h2>
        <p class="mt-0.5 text-[11px] text-[var(--tt-text-subtle)]">同一 session 下查看 SDK 边界原始日志与 Claude persistent 日志。</p>
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
              :class="logView.selectedLogTab === 'sdk-raw' ? 'bg-[var(--tt-accent)] text-white' : 'text-[var(--tt-text-muted)] hover:bg-[var(--tt-surface-soft)]'"
              @click="logView.selectLogTab('sdk-raw')"
            >
              SDK Raw
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
          :disabled="!logView.selectedSessionId || (logView.selectedLogTab === 'sdk-raw' ? logView.sdkRawLogLoading : logView.persistentLogLoading)"
          @click="logView.toggleLogLive"
        >
          {{ liveButtonLabel }}
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-hidden rounded border border-[var(--tt-border)] bg-[var(--tt-card)] font-mono">
        <template v-if="logView.selectedLogTab === 'sdk-raw'">
          <div v-if="sdkRawItems.length === 0" class="flex h-full items-center justify-center p-6 text-center text-sm text-[var(--tt-text-subtle)]">
            No SDK raw logs yet.
          </div>

          <div v-else ref="scrollContainer" class="h-full overflow-auto" @scroll="handleScroll">
            <div class="sticky top-0 z-10 grid gap-3 border-b border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_74%,white)] px-3 py-2 text-[10px] uppercase tracking-wide text-[var(--tt-text-subtle)]" :style="sdkRawGridStyle">
              <div>Time</div>
              <div>Kind</div>
              <div>Dir</div>
              <div>Seq</div>
              <div>Run ID</div>
              <div>Request ID</div>
              <div>Type</div>
              <div>Payload</div>
            </div>
            <div
              v-for="item in sdkRawItems"
              :key="`sdk-raw-${item.runId}-${item.cursor}`"
              class="grid gap-3 border-b border-[color:color-mix(in_srgb,var(--tt-border)_72%,white)] px-3 py-2 text-[11px] leading-5 transition-colors last:border-b-0 hover:bg-[color:color-mix(in_srgb,var(--tt-surface)_44%,white)]"
              :style="sdkRawGridStyle"
            >
              <div class="shrink-0 whitespace-nowrap text-[var(--tt-text-subtle)]">{{ formatTimestamp(item.loggedAt) }}</div>
              <div class="min-w-0">
                <span class="inline-flex whitespace-nowrap rounded border px-1.5 py-0 font-medium align-top" :class="getRawKindClass(item.event.kind)">
                  {{ item.event.kind }}
                </span>
              </div>
              <div>
                <span class="inline-flex min-w-[7ch] justify-center rounded border px-1.5 py-0 font-medium" :class="getRawDirectionClass(item.event.direction)">
                  {{ getRawDirectionLabel(item.event.direction) }}
                </span>
              </div>
              <div class="shrink-0 text-[var(--tt-text-subtle)]">#{{ item.event.sequence }}</div>
              <div class="shrink-0 text-[var(--tt-text-subtle)]">{{ item.runId.slice(0, 8) }}</div>
              <div class="truncate text-[var(--tt-text-subtle)]">{{ item.event.requestId || '-' }}</div>
              <div class="truncate text-[var(--tt-text-muted)]">{{ getRawMessageType(item) }}</div>
              <div class="min-w-0">
                <details class="rounded border border-[color:color-mix(in_srgb,var(--tt-border)_72%,white)] bg-[color:color-mix(in_srgb,var(--tt-surface)_72%,white)] px-2 py-1">
                  <summary class="cursor-pointer text-[var(--tt-text-muted)] hover:text-[var(--tt-accent)]">Payload</summary>
                  <pre class="mt-1 overflow-x-auto border border-[color:color-mix(in_srgb,var(--tt-accent)_18%,white)] bg-[var(--tt-accent)] px-2 py-2 text-[11px] text-[#F8F4EF]">{{ stringifyStructuredValue(item.event.message) }}</pre>
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
