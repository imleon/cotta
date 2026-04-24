<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLogViewStore } from '../../stores/log-view'
import { stringifyStructuredValue } from '../../lib/runtime-format'
import { createDebugLogger } from '../../lib/debug'

const logView = useLogViewStore()
const logger = createDebugLogger('transport-log-view')
const warnedPersistentParseKeys = new Set<string>()
const sdkRawItems = computed(() => logView.sdkRawLog)
const messageItems = computed(() => sdkRawItems.value.filter((item) => item.event.kind === 'sdk_message'))
const controlItems = computed(() => sdkRawItems.value.filter((item) => item.event.kind !== 'sdk_message'))
const persistentItems = computed(() => logView.persistentLog.filter((item) => {
  const type = getPersistentType(item.line)
  return type !== 'last-prompt' && type !== 'permission-mode' && type !== 'custom-title' && type !== 'agent-name'
}))
const activeItems = computed(() => {
  if (logView.selectedLogTab === 'messages') return messageItems.value
  if (logView.selectedLogTab === 'control') return controlItems.value
  return persistentItems.value
})
const sortedSessions = computed(() => (
  [...logView.filteredSessions].sort((left, right) => {
    const leftTime = typeof left.updatedAt === 'number' && Number.isFinite(left.updatedAt) ? left.updatedAt : 0
    const rightTime = typeof right.updatedAt === 'number' && Number.isFinite(right.updatedAt) ? right.updatedAt : 0
    return rightTime - leftTime
  })
))
const preservingOlderScroll = ref(false)
const scrollContainer = ref<HTMLElement | null>(null)
const scrollToLatestPending = ref(true)
const messageGridTemplate = '24ch 14ch 20ch 18ch 22ch minmax(28ch, 1fr)'
const messageGridStyle = {
  gridTemplateColumns: messageGridTemplate,
  width: 'max-content',
  minWidth: '100%',
}
const controlGridTemplate = '28ch 16ch 10ch 14ch 18ch 18ch minmax(28ch, 1fr)'
const controlGridStyle = {
  gridTemplateColumns: controlGridTemplate,
  width: 'max-content',
  minWidth: '100%',
}

type SessionSdkRawLogEntryLike = {
  event: {
    kind: string
    direction: string
    requestId?: string
    subtype?: string
    message: unknown
  }
  runId: string
  loggedAt: number
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

function formatAgentLabel(agent: { agentId: string; projectDir?: string }): string {
  if (agent.projectDir) return `${agent.agentId}  ${agent.projectDir}`
  return agent.agentId
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

function getControlKindClass(kind: string): string {
  if (kind === 'control_request') return 'border-[color:color-mix(in_srgb,var(--tt-warning)_26%,white)] bg-[color:color-mix(in_srgb,var(--tt-warning)_11%,white)] text-[color:color-mix(in_srgb,var(--tt-warning)_82%,var(--tt-text))]'
  if (kind === 'control_response') return 'border-[color:color-mix(in_srgb,var(--tt-success)_32%,white)] bg-[color:color-mix(in_srgb,var(--tt-success)_10%,white)] text-[color:color-mix(in_srgb,var(--tt-success)_88%,var(--tt-text))]'
  return 'border-[color:color-mix(in_srgb,var(--tt-coral)_28%,white)] bg-[color:color-mix(in_srgb,var(--tt-coral)_12%,white)] text-[var(--tt-primary-strong)]'
}

function getMessageTypeClass(type: string): string {
  if (type.startsWith('assistant')) return 'border-[color:color-mix(in_srgb,var(--tt-primary)_24%,white)] bg-[color:color-mix(in_srgb,var(--tt-primary)_10%,white)] text-[var(--tt-primary-strong)]'
  if (type.startsWith('user') || type.startsWith('synthetic_user')) return 'border-[color:color-mix(in_srgb,var(--tt-accent)_18%,white)] bg-[color:color-mix(in_srgb,var(--tt-accent)_7%,white)] text-[var(--tt-accent)]'
  if (type.startsWith('system')) return 'border-[color:color-mix(in_srgb,var(--tt-warning)_26%,white)] bg-[color:color-mix(in_srgb,var(--tt-warning)_11%,white)] text-[color:color-mix(in_srgb,var(--tt-warning)_82%,var(--tt-text))]'
  return 'border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_76%,white)] text-[var(--tt-text-muted)]'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function truncateText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

function getMessageContentEntries(item: SessionSdkRawLogEntryLike): Array<Record<string, unknown>> {
  const message = asRecord(item.event.message)
  if (!message) return []
  const type = message.type
  if (type !== 'assistant' && type !== 'user' && type !== 'synthetic_user') return []
  const messageRecord = asRecord(message.message)
  const content = messageRecord?.content
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    return [content as Record<string, unknown>]
  }
  if (Array.isArray(content)) {
    return content.filter((entry) => entry && typeof entry === 'object') as Record<string, unknown>[]
  }
  return []
}

function extractMessageContentKind(item: SessionSdkRawLogEntryLike): string {
  const [first] = getMessageContentEntries(item)
  if (first && typeof first.type === 'string') return first.type
  const message = asRecord(item.event.message)
  if (!message) return '-'
  const event = asRecord(message.event)
  if (typeof event?.type === 'string') return event.type
  if (typeof message.stop_reason === 'string' && message.stop_reason.trim()) return message.stop_reason
  return '-'
}

function extractMessageSummary(item: SessionSdkRawLogEntryLike): string {
  const entries = getMessageContentEntries(item)
  for (const entry of entries) {
    if (typeof entry.text === 'string' && entry.text.trim()) return truncateText(entry.text.trim(), 20)
    if (typeof entry.content === 'string' && entry.content.trim()) return truncateText(entry.content.trim(), 20)
    if (typeof entry.thinking === 'string' && entry.thinking.trim()) return truncateText(entry.thinking.trim(), 20)
    if (typeof entry.name === 'string' && entry.name.trim()) {
      const input = asRecord(entry.input)
      const command = typeof input?.command === 'string' ? input.command.trim() : ''
      const summary = command ? `${entry.name} ${command}` : entry.name
      if (summary.trim()) return truncateText(summary.trim(), 20)
    }
  }
  const message = asRecord(item.event.message)
  if (!message) return '-'
  const result = message.result
  if (typeof result === 'string' && result.trim()) return truncateText(result.trim(), 20)
  return '-'
}

function getSdkMessageType(item: SessionSdkRawLogEntryLike): string {
  const message = asRecord(item.event.message)
  if (!message) return 'unknown'
  const type = typeof message.type === 'string' ? message.type : 'unknown'
  const subtype = typeof message.subtype === 'string' ? `.${message.subtype}` : ''
  return `${type}${subtype}`
}

function getMessageRowClass(item: SessionSdkRawLogEntryLike): string {
  return getSdkMessageType(item).startsWith('synthetic_user')
    ? 'bg-[color:color-mix(in_srgb,var(--tt-accent)_8%,white)] hover:bg-[color:color-mix(in_srgb,var(--tt-accent)_14%,white)]'
    : 'hover:bg-[color:color-mix(in_srgb,var(--tt-surface)_44%,white)]'
}

function getControlType(item: SessionSdkRawLogEntryLike): string {
  return item.event.subtype || '-'
}

function getPersistentRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch (error) {
    const warnKey = line.slice(0, 160)
    if (!warnedPersistentParseKeys.has(warnKey)) {
      warnedPersistentParseKeys.add(warnKey)
      logger.warn('persistent-log:parse:error', {
        error: error instanceof Error ? error.message : String(error),
        linePreview: warnKey,
      })
    }
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

function isPersistentPrimaryUser(line: string): boolean {
  const record = getPersistentRecord(line)
  if (record?.type !== 'user') return false
  if (record.isReplay === true) return false
  if (record.isSynthetic === true) return false
  if (record.parent_tool_use_id != null || record.parentToolUseId != null) return false
  if (record.tool_use_result != null || record.toolUseResult != null) return false
  return true
}

function hasPersistentStopReason(line: string): boolean {
  const record = getPersistentRecord(line)
  const message = record?.message && typeof record.message === 'object'
    ? record.message as Record<string, unknown>
    : null
  const stopReason = message && 'stop_reason' in message ? (message as Record<string, unknown>).stop_reason : null
  return (typeof stopReason === 'string' && stopReason.trim().length > 0)
    || (stopReason !== null && stopReason !== undefined && stopReason !== '')
}

function getPersistentRowClass(line: string): string {
  if (hasPersistentStopReason(line)) {
    return 'bg-[color:color-mix(in_srgb,var(--tt-warning)_12%,white)] hover:bg-[color:color-mix(in_srgb,var(--tt-warning)_18%,white)]'
  }
  if (isPersistentPrimaryUser(line)) {
    return 'bg-[color:color-mix(in_srgb,var(--tt-accent)_8%,white)] hover:bg-[color:color-mix(in_srgb,var(--tt-accent)_14%,white)]'
  }
  return 'hover:bg-[color:color-mix(in_srgb,var(--tt-surface)_44%,white)]'
}

function getPersistentKind(line: string): string {
  const record = getPersistentRecord(line)
  const message = record?.message && typeof record.message === 'object'
    ? record.message as Record<string, unknown>
    : null
  const content = Array.isArray(message?.content) ? message.content : null
  const firstContent = content?.[0] && typeof content[0] === 'object'
    ? content[0] as Record<string, unknown>
    : null
  if (typeof firstContent?.type === 'string' && firstContent.type.trim()) return firstContent.type
  const attachment = record?.attachment && typeof record.attachment === 'object'
    ? record.attachment as Record<string, unknown>
    : null
  if (typeof attachment?.type === 'string' && attachment.type.trim()) return attachment.type
  if (typeof record?.subtype === 'string' && record.subtype.trim()) return record.subtype
  if (typeof message?.role === 'string' && message.role.trim()) return message.role
  if (typeof record?.operation === 'string' && record.operation.trim()) return record.operation
  return '-'
}

function getPersistentContent(line: string): string {
  const record = getPersistentRecord(line)
  const message = record?.message && typeof record.message === 'object'
    ? record.message as Record<string, unknown>
    : null
  const content = Array.isArray(message?.content) ? message.content : null
  const firstContent = content?.[0] && typeof content[0] === 'object'
    ? content[0] as Record<string, unknown>
    : null

  if (typeof firstContent?.text === 'string' && firstContent.text.trim()) return firstContent.text
  if (typeof firstContent?.content === 'string' && firstContent.content.trim()) return firstContent.content
  if (typeof firstContent?.thinking === 'string' && firstContent.thinking.trim()) return firstContent.thinking
  if (message?.content != null) {
    const rendered = stringifyStructuredValue(message.content)
    if (rendered.trim()) return rendered
  }

  const attachment = record?.attachment && typeof record.attachment === 'object'
    ? record.attachment as Record<string, unknown>
    : null
  const attachmentContent = attachment?.content && typeof attachment.content === 'object'
    ? attachment.content as Record<string, unknown>
    : null
  if (typeof attachmentContent?.content === 'string' && attachmentContent.content.trim()) return attachmentContent.content

  const toolName = typeof firstContent?.name === 'string' ? firstContent.name.trim() : ''
  const input = firstContent?.input && typeof firstContent.input === 'object'
    ? firstContent.input as Record<string, unknown>
    : null
  const command = typeof input?.command === 'string' ? input.command.trim() : ''
  if (toolName && command) return `${toolName}(${command})`
  if (toolName && input != null) {
    const rendered = stringifyStructuredValue(input)
    if (rendered.trim()) return `${toolName}(${rendered})`
    return toolName
  }

  return '-'
}

function formatPersistentJson(line: string): string {
  const record = getPersistentRecord(line)
  return record ? JSON.stringify(record, null, 2) : line
}

function getPersistentTagClass(): string {
  return 'border-[color:color-mix(in_srgb,var(--tt-accent)_28%,white)] bg-[color:color-mix(in_srgb,var(--tt-accent)_10%,white)] text-[var(--tt-accent)]'
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
  const isPersistent = logView.selectedLogTab === 'persistent'
  const canLoadOlder = isPersistent
    ? logView.persistentLogHasMore && !logView.persistentLogLoading
    : logView.sdkRawLogHasMore && !logView.sdkRawLogLoading
  if (!canLoadOlder) return

  logView.pauseSelectedLogFollow()
  preservingOlderScroll.value = true
  const previousHeight = container.scrollHeight
  const previousTop = container.scrollTop
  const loaded = isPersistent
    ? await logView.loadOlderPersistentLogs()
    : await logView.loadOlderSdkRawLogs()
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
        <p class="mt-0.5 text-[11px] text-[var(--tt-text-subtle)]">同一 session 下查看 SDK Messages、Control 与 Claude persistent 日志。</p>
      </div>

      <div class="flex items-center justify-between gap-2 pb-1">
        <div class="flex min-w-0 items-center gap-2">
          <select
            :value="logView.selectedAgentId"
            :disabled="logView.agents.length === 0"
            class="min-w-[18rem] max-w-[24rem] rounded border border-[var(--tt-border-strong)] bg-white/90 px-2 py-1 font-mono text-[11px] text-[var(--tt-text-muted)]"
            @change="logView.selectAgent(($event.target as HTMLSelectElement).value)"
          >
            <option value="" disabled>{{ logView.agents.length > 0 ? '选择 Agent' : '无可用 Agent' }}</option>
            <option v-for="agent in logView.agents" :key="agent.agentId" :value="agent.agentId">
              {{ formatAgentLabel(agent) }}
            </option>
          </select>
          <select
            :value="logView.selectedSessionId || ''"
            class="min-w-[22rem] max-w-[28rem] rounded border border-[var(--tt-border-strong)] bg-white/90 px-2 py-1 font-mono text-[11px] text-[var(--tt-text-muted)]"
            @change="logView.selectSession(($event.target as HTMLSelectElement).value)"
          >
            <option value="" disabled>{{ sortedSessions.length > 0 ? '选择 session' : '当前 Agent 下无 session' }}</option>
            <option v-for="item in sortedSessions" :key="item.id" :value="item.id">
              {{ formatSessionActivity(item.updatedAt) }}  {{ item.id }}  {{ item.title }}
            </option>
          </select>
          <div class="inline-flex rounded border border-[var(--tt-border)] bg-[var(--tt-card)] p-0.5 text-[11px]">
            <button
              class="rounded px-2 py-1"
              :class="logView.selectedLogTab === 'messages' ? 'bg-[var(--tt-accent)] text-white' : 'text-[var(--tt-text-muted)] hover:bg-[var(--tt-surface-soft)]'"
              @click="logView.selectLogTab('messages')"
            >
              SDK Messages
            </button>
            <button
              class="rounded px-2 py-1"
              :class="logView.selectedLogTab === 'control' ? 'bg-[var(--tt-accent)] text-white' : 'text-[var(--tt-text-muted)] hover:bg-[var(--tt-surface-soft)]'"
              @click="logView.selectLogTab('control')"
            >
              Control
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
            <span class="text-[var(--tt-text-subtle)]">agent:</span>
            <span class="ml-1 text-[var(--tt-accent)]">{{ logView.selectedAgentId || 'none' }}</span>
            <span class="mx-2 text-[var(--tt-text-subtle)]">|</span>
            <span class="text-[var(--tt-text-subtle)]">session:</span>
            <span class="ml-1 text-[var(--tt-accent)]">{{ logView.selectedSessionId || 'none' }}</span>
          </div>
        </div>
        <button
          class="rounded border px-2 py-1 text-[11px] font-semibold tracking-wide disabled:cursor-not-allowed disabled:opacity-50"
          :class="liveButtonClass"
          :disabled="!logView.selectedSessionId || (logView.selectedLogTab === 'persistent' ? logView.persistentLogLoading : logView.sdkRawLogLoading)"
          @click="logView.toggleLogLive"
        >
          {{ liveButtonLabel }}
        </button>
      </div>

      <div
        v-if="(logView.selectedLogTab === 'messages' || logView.selectedLogTab === 'control') && logView.sdkRawLogHasMore"
        class="pb-1 text-[10px] leading-5 text-[var(--tt-text-subtle)]"
      >
        向上滚动可继续加载更早的 SDK raw 日志。
      </div>

      <div
        v-if="logView.selectedLogTab === 'persistent' && logView.persistentLogHasMore"
        class="pb-1 text-[10px] leading-5 text-[var(--tt-text-subtle)]"
      >
        向上滚动可继续加载更早的 persistent 日志。
      </div>

      <div
        v-if="logView.selectedLogTab === 'persistent'"
        class="pb-1 text-[10px] leading-5 text-[var(--tt-text-subtle)]"
      >
        备注：当前视图已过滤 <span class="font-mono">type === 'last-prompt'</span>、<span class="font-mono">type === 'permission-mode'</span>、<span class="font-mono">type === 'custom-title'</span> 与 <span class="font-mono">type === 'agent-name'</span>。
      </div>

      <div class="min-h-0 flex-1 overflow-hidden rounded border border-[var(--tt-border)] bg-[var(--tt-card)] font-mono">
        <template v-if="logView.selectedLogTab === 'messages'">
          <div v-if="messageItems.length === 0" class="flex h-full items-center justify-center p-6 text-center text-sm text-[var(--tt-text-subtle)]">
            No SDK message logs yet.
          </div>

          <div v-else ref="scrollContainer" class="h-full overflow-auto" @scroll="handleScroll">
            <div class="sticky top-0 z-10 grid gap-3 border-b border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_74%,white)] px-3 py-2 text-[10px] uppercase tracking-wide text-[var(--tt-text-subtle)]" :style="messageGridStyle">
              <div>Time</div>
              <div>Run ID</div>
              <div>msg.type</div>
              <div>cnt.kind</div>
              <div>Summary</div>
              <div>Payload</div>
            </div>
            <div
              v-for="item in messageItems"
              :key="`sdk-message-${item.runId}-${item.cursor}`"
              class="grid gap-3 border-b border-[color:color-mix(in_srgb,var(--tt-border)_72%,white)] px-3 py-2 text-[11px] leading-5 transition-colors last:border-b-0"
              :class="getMessageRowClass(item)"
              :style="messageGridStyle"
            >
              <div class="shrink-0 whitespace-nowrap text-[var(--tt-text-subtle)]">{{ formatTimestamp(item.loggedAt) }}</div>
              <div class="shrink-0 text-[var(--tt-text-subtle)]">{{ item.runId.slice(0, 8) }}</div>
              <div class="min-w-0">
                <span class="inline-flex whitespace-nowrap rounded border px-1.5 py-0 font-medium align-top" :class="getMessageTypeClass(getSdkMessageType(item))">
                  {{ getSdkMessageType(item) }}
                </span>
              </div>
              <div class="truncate text-[var(--tt-text-muted)]">{{ extractMessageContentKind(item) }}</div>
              <div class="truncate text-[var(--tt-text-muted)]">{{ extractMessageSummary(item) }}</div>
              <div class="min-w-0">
                <details class="rounded border border-[color:color-mix(in_srgb,var(--tt-border)_72%,white)] bg-[color:color-mix(in_srgb,var(--tt-surface)_72%,white)] px-2 py-1">
                  <summary class="cursor-pointer text-[var(--tt-text-muted)] hover:text-[var(--tt-accent)]">Payload</summary>
                  <pre class="mt-1 overflow-x-auto border border-[color:color-mix(in_srgb,var(--tt-accent)_18%,white)] bg-[var(--tt-accent)] px-2 py-2 text-[11px] text-[#F8F4EF]">{{ stringifyStructuredValue(item.event.message) }}</pre>
                </details>
              </div>
            </div>
          </div>
        </template>

        <template v-else-if="logView.selectedLogTab === 'control'">
          <div v-if="controlItems.length === 0" class="flex h-full items-center justify-center p-6 text-center text-sm text-[var(--tt-text-subtle)]">
            No control logs yet.
          </div>

          <div v-else ref="scrollContainer" class="h-full overflow-auto" @scroll="handleScroll">
            <div class="sticky top-0 z-10 grid gap-3 border-b border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_74%,white)] px-3 py-2 text-[10px] uppercase tracking-wide text-[var(--tt-text-subtle)]" :style="controlGridStyle">
              <div>Time</div>
              <div>Kind</div>
              <div>Dir</div>
              <div>Run ID</div>
              <div>Request ID</div>
              <div>Type</div>
              <div>Payload</div>
            </div>
            <div
              v-for="item in controlItems"
              :key="`sdk-control-${item.runId}-${item.cursor}`"
              class="grid gap-3 border-b border-[color:color-mix(in_srgb,var(--tt-border)_72%,white)] px-3 py-2 text-[11px] leading-5 transition-colors last:border-b-0 hover:bg-[color:color-mix(in_srgb,var(--tt-surface)_44%,white)]"
              :style="controlGridStyle"
            >
              <div class="shrink-0 whitespace-nowrap text-[var(--tt-text-subtle)]">{{ formatTimestamp(item.loggedAt) }}</div>
              <div class="min-w-0">
                <span class="inline-flex whitespace-nowrap rounded border px-1.5 py-0 font-medium align-top" :class="getControlKindClass(item.event.kind)">
                  {{ item.event.kind }}
                </span>
              </div>
              <div>
                <span class="inline-flex min-w-[7ch] justify-center rounded border px-1.5 py-0 font-medium" :class="getRawDirectionClass(item.event.direction)">
                  {{ getRawDirectionLabel(item.event.direction) }}
                </span>
              </div>
              <div class="shrink-0 text-[var(--tt-text-subtle)]">{{ item.runId.slice(0, 8) }}</div>
              <div class="truncate text-[var(--tt-text-subtle)]">{{ item.event.requestId || '-' }}</div>
              <div class="truncate text-[var(--tt-text-muted)]">{{ getControlType(item) }}</div>
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
            <div class="sticky top-0 z-10 grid grid-cols-[28ch_18ch_22ch_minmax(28ch,40ch)_minmax(36ch,1fr)] gap-3 border-b border-[var(--tt-border)] bg-[color:color-mix(in_srgb,var(--tt-surface)_74%,white)] px-3 py-2 text-[10px] uppercase tracking-wide text-[var(--tt-text-subtle)]">
              <div>Time</div>
              <div>Type</div>
              <div>Kind</div>
              <div>Content</div>
              <div>JSON</div>
            </div>
            <div
              v-for="item in persistentItems"
              :key="`persistent-${item.cursor}`"
              class="grid grid-cols-[28ch_18ch_22ch_minmax(28ch,40ch)_minmax(36ch,1fr)] gap-3 border-b border-[color:color-mix(in_srgb,var(--tt-border)_72%,white)] px-3 py-2 text-[11px] leading-5 transition-colors last:border-b-0"
              :class="getPersistentRowClass(item.line)"
            >
              <div class="shrink-0 whitespace-nowrap text-[var(--tt-text-subtle)]">{{ getPersistentTimestamp(item) }}</div>
              <div class="min-w-0">
                <div class="truncate text-[var(--tt-text-muted)]">{{ getPersistentType(item.line) }}</div>
                <div v-if="item.tags?.length" class="mt-1 flex flex-wrap gap-1">
                  <span
                    v-for="tag in item.tags"
                    :key="`${item.cursor}-${tag}`"
                    class="inline-flex whitespace-nowrap rounded border px-1.5 py-0 font-medium align-top"
                    :class="getPersistentTagClass()"
                  >
                    {{ tag }}
                  </span>
                </div>
              </div>
              <div class="truncate text-[var(--tt-text-muted)]">{{ getPersistentKind(item.line) }}</div>
              <div class="truncate text-[var(--tt-text-muted)]" :title="getPersistentContent(item.line)">{{ getPersistentContent(item.line) }}</div>
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
