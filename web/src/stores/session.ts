import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  AssistantDisplayItem,
  ControlTransactionSummary,
  DisplayItem,
  LiveLaneKind,
  PendingInteraction,
  PermissionSuggestion,
  SessionEvent,
  SessionMessage,
  SessionMessageBlock,
  SessionRunState,
  SessionStreamEvent,
  SessionSummary,
  StreamAnimationCursor,
  StreamPreviewState,
  TimelineLivePreviewItem,
  TimelineRenderableItem,
  TranscriptAtom,
} from '../../../runtime/protocol/message-types.js'
import {
  classifySdkMessageLane,
} from '../../../runtime/protocol/message-types.js'
import {
  buildDisplayItems,
  buildHistoryDisplayItems,
  buildTranscriptAtom,
} from '../../../runtime/presentation/transcript-display.js'
import {
  advanceStreamAnimationCursor,
  createStreamAnimationCursor,
  reduceStreamPreviewEvent,
  renderStreamPreviewState,
  getTranscriptResponseId,
  getTranscriptStopReason,
  normalizeSdkEnvelopeMessage,
} from '../../../runtime/protocol/transcript-normalizer.js'
import { createDebugLogger } from '../lib/debug.js'

export type {
  TimelineRenderableItem as TimelineItem,
  PendingInteraction,
  SessionEvent,
  SessionMessage,
  SessionMessageBlock,
  SessionRunState,
  SessionSummary,
  TimelineRenderableItem,
  TranscriptAtom,
}


interface HealthResponse {
  status?: string
  authEnabled?: boolean
}

function generateUuid(): string {
  const cryptoApi = (globalThis as unknown as { crypto?: Crypto }).crypto
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID()
  return `uuid-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

interface SessionMessagesResponse {
  messages?: unknown[]
  hasMore?: boolean
  nextBefore?: string | null
}

interface AgentDescriptor {
  agentId: string
  projectDir?: string
}

interface AgentsResponse {
  defaultAgentId?: string
  agents?: AgentDescriptor[]
}

type RuntimeSdkMessageEvent = Extract<SessionEvent, { type: 'session.sdk.message' }>
type LiveLaneBuckets = Record<LiveLaneKind, RuntimeSdkMessageEvent[]>

const AUTH_TOKEN_STORAGE_KEY = 'cotta-auth-token'
const AGENT_ID_STORAGE_KEY = 'cotta.agentId'
const DEFAULT_HISTORY_PAGE_SIZE = 100
const logger = createDebugLogger('session-store')
const EVENT_LOG_INTERVAL = 20
const OPTIMISTIC_USER_MATCH_WINDOW_MS = 30_000

type OptimisticUserMessage = SessionMessage & {
  optimistic: true
  localId: string
}

function normalizeSession(item: any): SessionSummary {
  return {
    id: typeof item?.id === 'string' ? item.id : '',
    title: typeof item?.title === 'string' && item.title ? item.title : (typeof item?.id === 'string' ? item.id.slice(0, 8) : 'Untitled'),
    updatedAt: typeof item?.updatedAt === 'number' ? item.updatedAt : Date.now(),
    ...(typeof item?.agentId === 'string' && item.agentId ? { agentId: item.agentId } : {}),
    ...(typeof item?.channelId === 'string' && item.channelId ? { channelId: item.channelId } : {}),
    ...(typeof item?.workerRef === 'string' && item.workerRef ? { workerRef: item.workerRef } : {}),
    ...(item?.sessionStatus === 'idle' || item?.sessionStatus === 'running' || item?.sessionStatus === 'requires_action'
      ? { sessionStatus: item.sessionStatus }
      : {}),
    ...(typeof item?.activeRunId === 'string' && item.activeRunId ? { activeRunId: item.activeRunId } : {}),
  }
}

function getEventRunId(event: SessionEvent): string | null {
  return 'runId' in event && typeof event.runId === 'string' ? event.runId : null
}

function isRunScopedEvent(event: SessionEvent): boolean {
  switch (event.type) {
    case 'session.control.message':
    case 'session.control.opened':
    case 'session.control.awaiting_user':
    case 'session.control.responded':
    case 'session.control.completed':
    case 'session.control.cancel_requested':
    case 'session.control.cancelled':
    case 'session.control.failed':
    case 'session.interactive.opened':
    case 'session.interactive.awaiting_user':
    case 'session.interactive.responded':
    case 'session.interactive.completed':
    case 'session.interactive.cancelled':
    case 'session.interactive.failed':
      return typeof event.runId === 'string'
    case 'session.error':
      return typeof event.runId === 'string'
    default:
      return true
  }
}

function shortId(value?: string | null): string | undefined {
  return value ? value.slice(0, 8) : undefined
}

function redactUrl(url: URL): string {
  const safe = new URL(url.toString())
  if (safe.searchParams.has('auth')) {
    safe.searchParams.set('auth', '[REDACTED]')
  }
  return safe.toString()
}

function asPayloadRecord(payload: Extract<SessionEvent, { type: 'session.sdk.message' }>['payload']): Record<string, unknown> | null {
  return payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
}

function isErrorResultPayload(payload: Extract<SessionEvent, { type: 'session.sdk.message' }>['payload']): boolean {
  const record = asPayloadRecord(payload)
  return record?.type === 'result' && record.subtype !== 'success'
}

function inferResultModel(payload: Extract<SessionEvent, { type: 'session.sdk.message' }>['payload']): string | null {
  const record = asPayloadRecord(payload)
  if (record?.type !== 'result') return null
  const modelUsage = record.modelUsage
  if (!modelUsage || typeof modelUsage !== 'object') return null
  const model = Object.keys(modelUsage as Record<string, unknown>).find((key) => key.trim().length > 0)
  return model ?? null
}

function formatErrorResultSubtype(subtype: string): string {
  const normalized = subtype.startsWith('error_') ? subtype.slice('error_'.length) : subtype
  return normalized
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function buildErrorResultMessage(event: Extract<SessionEvent, { type: 'session.sdk.message' }>): SessionMessage | null {
  if (!isErrorResultPayload(event.payload)) return null

  const payload = asPayloadRecord(event.payload)
  if (!payload) return null

  const errors = Array.isArray(payload.errors)
    ? payload.errors.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : []
  const subtype = typeof payload.subtype === 'string' ? payload.subtype : 'error'
  const title = formatErrorResultSubtype(subtype)
  const content = [title ? `Run failed · ${title}` : 'Run failed', ...errors].join('\n\n').trim()
  const model = inferResultModel(event.payload)

  return {
    role: 'assistant',
    content,
    timestamp: typeof event.receivedAt === 'number' ? event.receivedAt : Date.now(),
    blocks: [{ type: 'text', text: content, raw: content }],
    raw: {
      ...payload,
      isErrorResult: true,
      message: {
        ...(typeof payload.uuid === 'string' ? { id: `result-${payload.uuid}` } : {}),
        content,
        ...(typeof payload.stop_reason === 'string' || payload.stop_reason === null ? { stop_reason: payload.stop_reason } : {}),
        ...(payload.usage && typeof payload.usage === 'object' ? { usage: payload.usage } : {}),
        ...(model ? { model } : {}),
      },
    },
  }
}

function getTimelineMessageFromEvent(event: Extract<SessionEvent, { type: 'session.sdk.message' }>): SessionMessage | null {
  return event.parsed ?? buildErrorResultMessage(event)
}

function isMatchingOptimisticUserMessage(message: OptimisticUserMessage, candidate: SessionMessage, timestamp: number): boolean {
  if (message.role !== 'user' || candidate.role !== 'user') return false
  if (message.content.trim() !== candidate.content.trim()) return false
  const messageTimestamp = typeof message.timestamp === 'number' ? message.timestamp : 0
  return Math.abs(messageTimestamp - timestamp) <= OPTIMISTIC_USER_MATCH_WINDOW_MS
}

function shouldRetainSdkMessageAfterHistoryReload(message: Extract<SessionEvent, { type: 'session.sdk.message' }>['payload']): boolean {
  const classified = classifySdkMessageLane(message)
  if (classified.lane === 'session') return true
  if (classified.lane !== 'live') return false
  return classified.liveKind === 'stream_event'
    || classified.liveKind === 'system'
    || classified.liveKind === 'result'
    || classified.liveKind === 'tool_progress'
    || classified.liveKind === 'tool_use_summary'
    || classified.liveKind === 'prompt_suggestion'
}

function getStreamScopeKey(event: SessionStreamEvent): string {
  return event.scope.scopeKey
}

function finalizeStreamPreviewState(preview: StreamPreviewState): StreamPreviewState {
  return {
    ...preview,
    status: 'finalized',
    active: false,
  }
}

function markStreamPreviewsMaterialized(
  previewStates: Record<string, StreamPreviewState>,
  animationCursors: Record<string, StreamAnimationCursor>,
  responseId: string | null,
  toolUseIds: Set<string>,
): { previewStates: Record<string, StreamPreviewState>; animationCursors: Record<string, StreamAnimationCursor> } {
  let changed = false
  const nextPreviewStates = { ...previewStates }
  const nextAnimationCursors = { ...animationCursors }

  for (const [scopeKey, preview] of Object.entries(previewStates)) {
    const matchesMessage = Boolean(responseId && preview.scope.messageId === responseId)
    const matchesTool = Boolean(preview.scope.parentToolUseId && toolUseIds.has(preview.scope.parentToolUseId))
    if (!matchesMessage && !matchesTool) continue
    if (preview.status === 'finalized') continue

    const finalizedPreview = finalizeStreamPreviewState(preview)
    nextPreviewStates[scopeKey] = finalizedPreview
    nextAnimationCursors[scopeKey] = createStreamAnimationCursor(finalizedPreview)
    changed = true
  }

  return changed
    ? { previewStates: nextPreviewStates, animationCursors: nextAnimationCursors }
    : { previewStates, animationCursors }
}

function sweepFinalizedStreamPreviews(
  previewStates: Record<string, StreamPreviewState>,
  animationCursors: Record<string, StreamAnimationCursor>,
): { previewStates: Record<string, StreamPreviewState>; animationCursors: Record<string, StreamAnimationCursor>; removed: boolean } {
  let removed = false
  const nextPreviewStates = { ...previewStates }
  const nextAnimationCursors = { ...animationCursors }
  for (const [scopeKey, preview] of Object.entries(previewStates)) {
    if (preview.status !== 'finalized') continue
    delete nextPreviewStates[scopeKey]
    delete nextAnimationCursors[scopeKey]
    removed = true
  }
  return {
    previewStates: removed ? nextPreviewStates : previewStates,
    animationCursors: removed ? nextAnimationCursors : animationCursors,
    removed,
  }
}

function getLivePreviewOverlayKind(preview: StreamPreviewState): TimelineLivePreviewItem['overlayKind'] {
  switch (preview.phase) {
    case 'thinking':
      return 'streaming_thinking'
    case 'tool-input':
      return 'streaming_tool_use'
    case 'responding':
      return 'streaming_text'
    default:
      return preview.status === 'awaiting-materialization' ? 'streaming_text' : 'streaming_progress'
  }
}

function isOverlayHostItem(item: DisplayItem): item is AssistantDisplayItem {
  return item.kind === 'assistant'
}

function getDisplayItemToolUseIds(item: AssistantDisplayItem): string[] {
  return item.fragments.flatMap((fragment) => fragment.type === 'tool_use' && typeof fragment.toolUseId === 'string' ? [fragment.toolUseId] : [])
}

function shouldAttachOverlayToItem(
  item: AssistantDisplayItem,
  overlay: TimelineLivePreviewItem,
): boolean {
  if (overlay.anchor.anchorKind === 'tool_use') {
    return getDisplayItemToolUseIds(item).includes(overlay.anchor.anchorId)
  }

  if (overlay.anchor.anchorKind === 'message') {
    return getTranscriptResponseId(item.anchorMessage) === overlay.anchor.anchorId
  }

  if (overlay.anchor.parentToolUseId) {
    return getDisplayItemToolUseIds(item).includes(overlay.anchor.parentToolUseId)
  }

  if (overlay.anchor.messageId) {
    return getTranscriptResponseId(item.anchorMessage) === overlay.anchor.messageId
  }

  return false
}

function getOverlayHostPriority(
  item: AssistantDisplayItem,
  overlay: TimelineLivePreviewItem,
): number {
  if (!shouldAttachOverlayToItem(item, overlay)) return -1
  if (overlay.anchor.anchorKind === 'tool_use' || overlay.anchor.parentToolUseId) {
    return 1
  }
  if (overlay.anchor.anchorKind === 'message' || overlay.anchor.messageId) {
    if (item.kind === 'assistant') return 3
  }
  return 0
}

function attachOverlaysToDisplayItems(
  items: DisplayItem[],
  overlays: TimelineLivePreviewItem[],
): { items: DisplayItem[]; unattachedOverlays: TimelineLivePreviewItem[] } {
  const overlaysByItemId = new Map<string, TimelineLivePreviewItem[]>()
  const attachedOverlayIds = new Set<string>()
  const hosts = items.filter(isOverlayHostItem)

  for (const overlay of overlays) {
    const host = hosts
      .map((item) => ({ item, priority: getOverlayHostPriority(item, overlay) }))
      .filter((entry) => entry.priority >= 0)
      .sort((left, right) => right.priority - left.priority)[0]?.item
    if (!host) continue
    overlaysByItemId.set(host.id, [...(overlaysByItemId.get(host.id) || []), overlay])
    attachedOverlayIds.add(overlay.id)
  }

  return {
    items: items.map((item) => {
      const overlaysForItem = overlaysByItemId.get(item.id)
      if (!overlaysForItem || !isOverlayHostItem(item)) return item
      return {
        ...item,
        overlays: overlaysForItem,
      }
    }),
    unattachedOverlays: overlays.filter((overlay) => !attachedOverlayIds.has(overlay.id)),
  }
}

function buildSyntheticAssistantMessage(anchorId: string, timestamp: number): SessionMessage {
  // Provides a stable "assistant message" shape so TimelineAssistantCard/footer can render
  // while we only have streaming overlays (no materialized assistant message yet).
  return {
    role: 'assistant',
    content: '',
    timestamp,
    blocks: [],
    raw: {
      type: 'assistant',
      uuid: `synthetic-${anchorId}`,
      message: {
        id: anchorId,
        content: [],
      },
    },
  }
}

function synthesizeOverlayHosts(unattached: TimelineLivePreviewItem[]): AssistantDisplayItem[] {
  if (!unattached.length) return []

  const byKey = new Map<string, TimelineLivePreviewItem[]>()
  for (const overlay of unattached) {
    const messageId = overlay.anchor.messageId
      ?? (overlay.anchor.anchorKind === 'message' ? overlay.anchor.anchorId : null)
    const key = messageId
      ? `message:${messageId}`
      : overlay.anchor.parentToolUseId
        ? `tool:${overlay.anchor.parentToolUseId}`
        : `scope:${overlay.anchor.scopeKey}`
    byKey.set(key, [...(byKey.get(key) || []), overlay])
  }

  const synthetic: AssistantDisplayItem[] = []
  for (const [groupKey, overlays] of byKey.entries()) {
    const timestamp = overlays.reduce((min, item) => Math.min(min, item.timestamp), overlays[0]!.timestamp)
    const anchorId = (() => {
      const messageId = overlays.find((o) => typeof o.anchor.messageId === 'string' && o.anchor.messageId)?.anchor.messageId
      if (typeof messageId === 'string' && messageId) return messageId
      const messageAnchor = overlays.find((o) => o.anchor.anchorKind === 'message')?.anchor.anchorId
      return messageAnchor ?? groupKey
    })()

    synthetic.push({
      kind: 'assistant',
      id: `synthetic-assistant-${groupKey}`,
      key: `synthetic-assistant-${groupKey}`,
      timestamp,
      atomIds: [],
      messages: [],
      anchorMessage: buildSyntheticAssistantMessage(anchorId, timestamp),
      fragments: [],
      overlays,
      footer: undefined,
    })
  }

  return synthetic
}

function isDetachedToolResultAssistant(item: AssistantDisplayItem): boolean {
  if (item.fragments.length === 0) return false
  return item.fragments.every((fragment) => fragment.type === 'tool_result')
}

function isOverlayOnlyAssistant(item: AssistantDisplayItem): boolean {
  return item.fragments.length === 0 && Boolean(item.overlays?.length)
}

function canMergeAssistantOutputItems(current: AssistantDisplayItem | null, next: AssistantDisplayItem): boolean {
  if (!current) return true
  if (isDetachedToolResultAssistant(current) || isDetachedToolResultAssistant(next)) return false
  if (isOverlayOnlyAssistant(current) || isOverlayOnlyAssistant(next)) return false
  return true
}

function mergeAssistantOutputItems(
  current: AssistantDisplayItem | null,
  next: AssistantDisplayItem,
): AssistantDisplayItem {
  if (!current) return next

  const overlays = [...(current.overlays || []), ...(next.overlays || [])]
    .slice()
    .sort((left, right) => {
      if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp
      return left.key.localeCompare(right.key)
    })

  return {
    ...current,
    atomIds: [...current.atomIds, ...next.atomIds],
    messages: [...current.messages, ...next.messages],
    anchorMessage: next.anchorMessage,
    fragments: [...current.fragments, ...next.fragments],
    footer: next.footer ?? current.footer,
    overlays: overlays.length > 0 ? overlays : undefined,
  }
}

function mergeTurnOutputItems(items: DisplayItem[]): DisplayItem[] {
  const merged: DisplayItem[] = []
  let pendingOutput: AssistantDisplayItem | null = null

  const flushPending = () => {
    if (!pendingOutput) return
    merged.push(pendingOutput)
    pendingOutput = null
  }

  for (const item of items) {
    if (item.kind === 'user') {
      flushPending()
      merged.push(item)
      continue
    }

    if (item.kind === 'summary') {
      flushPending()
      merged.push(item)
      continue
    }

    if (!canMergeAssistantOutputItems(pendingOutput, item)) {
      flushPending()
    }

    pendingOutput = mergeAssistantOutputItems(pendingOutput, item)
  }

  flushPending()
  return merged
}

export const useSessionStore = defineStore('session', () => {
  const historyMessages = ref<SessionMessage[]>([])
  const optimisticUserMessages = ref<OptimisticUserMessage[]>([])
  const historyMessagesHasMore = ref(false)
  const historyMessagesLoading = ref(false)
  const historyMessagesLoadingOlder = ref(false)
  const historyMessagesBeforeCursor = ref<string | null>(null)
  const sessions = ref<SessionSummary[]>([])
  const currentSessionId = ref<string | null>(null)
  const isConnected = ref(false)
  const runState = ref<SessionRunState>('idle')
  const authToken = ref(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || '')
  const authError = ref('')
  const sessionNotice = ref('')
  const authRequired = ref(false)
  const authChecked = ref(false)
  const activeRunId = ref<string | null>(null)
  const controlTransactionsById = ref<Record<string, ControlTransactionSummary>>({})
  const activeControlOrder = ref<string[]>([])
  const eventLog = ref<Array<Extract<SessionEvent, { type: 'session.sdk.message' }>>>([])
  const streamPreviewStates = ref<Record<string, StreamPreviewState>>({})
  const streamAnimationCursors = ref<Record<string, StreamAnimationCursor>>({})

  const isLoading = computed(() => ['queued', 'running', 'requires_action'].includes(runState.value))
  const hasAuthToken = computed(() => authToken.value.trim().length > 0)
  const activeInteractiveControl = computed<ControlTransactionSummary | null>(() => {
    for (const requestId of activeControlOrder.value) {
      const transaction = controlTransactionsById.value[requestId]
      if (!transaction?.interaction) continue
      if (transaction.status !== 'awaiting_user') continue
      return transaction
    }
    return null
  })
  const pendingInteraction = computed<PendingInteraction | null>(() => activeInteractiveControl.value?.interaction ?? null)
  const isAwaitingApproval = computed(() => pendingInteraction.value?.kind === 'permission' && pendingInteraction.value?.status === 'pending')
  const isAwaitingInteraction = computed(() => pendingInteraction.value?.status === 'pending')
  const hasActiveRun = computed(() => awaitingRunStart || activeRunId.value !== null)
  const currentSessionSummary = computed<SessionSummary | null>(() =>
    sessions.value.find((item) => item.id === currentSessionId.value) ?? null,
  )
  const sdkMessageLaneBuckets = computed(() => {
    const user: RuntimeSdkMessageEvent[] = []
    const liveUser: RuntimeSdkMessageEvent[] = []
    const streamEvent: RuntimeSdkMessageEvent[] = []
    const assistant: RuntimeSdkMessageEvent[] = []
    const system: RuntimeSdkMessageEvent[] = []
    const result: RuntimeSdkMessageEvent[] = []
    const toolProgress: RuntimeSdkMessageEvent[] = []
    const toolUseSummary: RuntimeSdkMessageEvent[] = []
    const promptSuggestion: RuntimeSdkMessageEvent[] = []
    const session: RuntimeSdkMessageEvent[] = []

    for (const event of eventLog.value) {
      const classified = classifySdkMessageLane(event.payload)
      switch (classified.lane) {
        case 'user':
          user.push(event)
          break
        case 'live':
          switch (classified.liveKind) {
            case 'user':
              liveUser.push(event)
              break
            case 'stream_event':
              streamEvent.push(event)
              break
            case 'assistant':
              assistant.push(event)
              break
            case 'system':
              system.push(event)
              break
            case 'result':
              result.push(event)
              break
            case 'tool_progress':
              toolProgress.push(event)
              break
            case 'tool_use_summary':
              toolUseSummary.push(event)
              break
            case 'prompt_suggestion':
              promptSuggestion.push(event)
              break
            default:
              break
          }
          break
        case 'session':
          session.push(event)
          break
        default:
          break
      }
    }

    return {
      user,
      live: {
        user: liveUser,
        stream_event: streamEvent,
        assistant,
        system,
        result,
        tool_progress: toolProgress,
        tool_use_summary: toolUseSummary,
        prompt_suggestion: promptSuggestion,
      } satisfies LiveLaneBuckets,
      session,
    }
  })
  const userLaneEvents = computed(() => sdkMessageLaneBuckets.value.user)
  const liveLaneEvents = computed(() => sdkMessageLaneBuckets.value.live)
  const sessionLaneEvents = computed(() => sdkMessageLaneBuckets.value.session)
  const liveAssistantResponseIdsCoveredByPreview = computed<Set<string>>(() => {
    const ids = new Set<string>()
    for (const preview of Object.values(streamPreviewStates.value)) {
      if (!preview.active) continue
      if (preview.phase !== 'thinking' && preview.phase !== 'responding') continue
      if (preview.scope.anchorKind !== 'message') continue
      ids.add(preview.scope.anchorId)
    }
    return ids
  })
  const userLaneAtoms = computed<TranscriptAtom[]>(() => {
    const optimisticAtoms = optimisticUserMessages.value.map((message, index) =>
      buildTranscriptAtom(message, {
        source: 'live',
        sourceIndex: index,
        timestamp: message.timestamp,
        optimistic: true,
        localId: message.localId,
      })
    )
    const runtimeAtoms = userLaneEvents.value
      .map((event, index) => {
        const message = getTimelineMessageFromEvent(event)
        if (!message) return null
        return buildTranscriptAtom(message, {
          source: 'live',
          sourceIndex: optimisticAtoms.length + index,
          timestamp: typeof event.receivedAt === 'number' ? event.receivedAt : message.timestamp,
          sequence: event.sequence,
        })
      })
      .filter((atom): atom is TranscriptAtom => atom !== null && atom.semanticKind !== 'meta')

    return [...optimisticAtoms, ...runtimeAtoms]
      .slice()
      .sort((left, right) => {
        if (left.order.timestamp !== right.order.timestamp) return left.order.timestamp - right.order.timestamp
        return left.order.sourceIndex - right.order.sourceIndex
      })
  })
  const liveAtoms = computed<TranscriptAtom[]>(() =>
    [...liveLaneEvents.value.user, ...liveLaneEvents.value.assistant]
      .map((event, index) => {
        const message = getTimelineMessageFromEvent(event)
        if (!message) return null
        const responseId = getTranscriptResponseId(message)
        if (
          message.role === 'assistant'
          && responseId
          && liveAssistantResponseIdsCoveredByPreview.value.has(responseId)
          && getTranscriptStopReason(message) == null
        ) {
          return null
        }
        return buildTranscriptAtom(message, {
          source: 'live',
          sourceIndex: index,
          timestamp: typeof event.receivedAt === 'number' ? event.receivedAt : message.timestamp,
          sequence: event.sequence,
        })
      })
      .filter((atom): atom is TranscriptAtom => atom !== null && atom.semanticKind !== 'meta')
  )



  const historyTimelineItems = computed<DisplayItem[]>(() =>
    buildHistoryDisplayItems(historyMessages.value, {
      mode: 'default',
      includeHiddenAtoms: false,
    })
  )
  const userTimelineItems = computed<DisplayItem[]>(() =>
    buildDisplayItems(userLaneAtoms.value, {
      mode: 'default',
      includeHiddenAtoms: false,
    })
  )
  const liveTimelineItems = computed<DisplayItem[]>(() =>
    buildDisplayItems(liveAtoms.value, {
      mode: 'default',
      includeHiddenAtoms: false,
    })
  )
  const defaultTimelineItems = computed<DisplayItem[]>(() =>
    [...historyTimelineItems.value, ...userTimelineItems.value, ...liveTimelineItems.value]
      .slice()
      .sort((left, right) => {
        if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp
        return left.key.localeCompare(right.key)
      })
  )
  const livePreviewItems = computed<TimelineLivePreviewItem[]>(() =>
    Object.entries(streamPreviewStates.value)
      .filter(([, preview]) => preview.status !== 'finalized' && preview.blocks.length > 0)
      .slice()
      .sort(([, left], [, right]) => {
        const leftTimestamp = left.receivedAt ?? 0
        const rightTimestamp = right.receivedAt ?? 0
        if (leftTimestamp !== rightTimestamp) return leftTimestamp - rightTimestamp
        const leftSequence = left.sequence ?? 0
        const rightSequence = right.sequence ?? 0
        return leftSequence - rightSequence
      })
      .map(([scopeKey, preview]) => ({
        kind: 'live_preview',
        layer: 'overlay',
        overlayKind: getLivePreviewOverlayKind(preview),
        anchor: {
          scopeKey: preview.scope.scopeKey || 'unknown',
          anchorKind: preview.scope.anchorKind,
          anchorId: preview.scope.anchorId,
          ...(preview.scope.messageId ? { messageId: preview.scope.messageId } : {}),
          ...(preview.scope.parentToolUseId !== undefined ? { parentToolUseId: preview.scope.parentToolUseId } : {}),
        },
        id: `live-preview-${preview.scope.scopeKey || 'unknown'}`,
        key: `live-preview-${preview.scope.scopeKey || 'unknown'}`,
        timestamp: preview.receivedAt ?? Date.now(),
        preview: renderStreamPreviewState(preview, streamAnimationCursors.value[scopeKey] ?? null),
      }))
  )
  const timeline = computed<TimelineRenderableItem[]>(() => {
    const visibleItems = defaultTimelineItems.value
    const { items: itemsWithOverlays, unattachedOverlays } = attachOverlaysToDisplayItems(
      visibleItems,
      livePreviewItems.value,
    )
    const syntheticOverlayHosts = synthesizeOverlayHosts(unattachedOverlays)
    return mergeTurnOutputItems(
      [...itemsWithOverlays, ...syntheticOverlayHosts]
        .slice()
        .sort((left, right) => {
          if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp
          return left.key.localeCompare(right.key)
        })
    )
      .slice()
      .sort((left, right) => {
        if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp
        return left.key.localeCompare(right.key)
      })
  })

  let ws: WebSocket | null = null
  let eventSequence = 0
  let wsSessionFilter: string | null = null
  const terminalRunIds = new Set<string>()
  const activeStreamMessageIds = new Map<string, string>()
  let agentIdCache: string | null = null
  let agentIdPromise: Promise<string> | null = null
  let awaitingRunStart = false
  let observedEventCount = 0
  let optimisticMessageCount = 0
  let streamAnimationFrame: number | null = null
  let streamSweepTimer: number | null = null
  let streamFinalizeTimers: Record<string, number> = {}

  function scheduleFinalizedPreviewSweep(delayMs: number = 180) {
    if (streamSweepTimer !== null) {
      window.clearTimeout(streamSweepTimer)
    }
    streamSweepTimer = window.setTimeout(() => {
      streamSweepTimer = null
      const swept = sweepFinalizedStreamPreviews(
        streamPreviewStates.value,
        streamAnimationCursors.value,
      )
      if (!swept.removed) return
      streamPreviewStates.value = swept.previewStates
      streamAnimationCursors.value = swept.animationCursors
    }, delayMs)
  }

  function clearStreamTimers() {
    if (streamAnimationFrame !== null) {
      window.clearTimeout(streamAnimationFrame)
      streamAnimationFrame = null
    }
    if (streamSweepTimer !== null) {
      window.clearTimeout(streamSweepTimer)
      streamSweepTimer = null
    }
    for (const timer of Object.values(streamFinalizeTimers)) {
      window.clearTimeout(timer)
    }
    streamFinalizeTimers = {}
  }

  function scheduleStreamFinalize(scopeKey: string, delayMs: number = 400) {
    const existingTimer = streamFinalizeTimers[scopeKey]
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer)
    }
    streamFinalizeTimers = {
      ...streamFinalizeTimers,
      [scopeKey]: window.setTimeout(() => {
        const { [scopeKey]: _timerId, ...restTimers } = streamFinalizeTimers
        streamFinalizeTimers = restTimers

        const latestPreview = streamPreviewStates.value[scopeKey]
        if (!latestPreview || latestPreview.status === 'finalized') {
          scheduleFinalizedPreviewSweep(0)
          return
        }

        const finalizedPreview = finalizeStreamPreviewState(latestPreview)
        streamPreviewStates.value = {
          ...streamPreviewStates.value,
          [scopeKey]: finalizedPreview,
        }
        streamAnimationCursors.value = {
          ...streamAnimationCursors.value,
          [scopeKey]: createStreamAnimationCursor(finalizedPreview),
        }
        scheduleFinalizedPreviewSweep(0)
      }, delayMs),
    }
  }

  function persistAuthToken(token: string) {
    authToken.value = token.trim()
    logger.info('auth:set-token', {
      hasToken: Boolean(authToken.value),
      tokenLength: authToken.value.length,
    })
    if (authToken.value) {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, authToken.value)
    } else {
      localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
    }
  }

  function clearRunState(nextState: SessionRunState = 'idle') {
    logger.debug('chat:run-state:clear', {
      nextState,
      activeRunId: shortId(activeRunId.value),
      currentState: runState.value,
    })
    activeRunId.value = null
    awaitingRunStart = false
    controlTransactionsById.value = {}
    activeControlOrder.value = []
    streamPreviewStates.value = {}
    streamAnimationCursors.value = {}
    clearStreamTimers()
    runState.value = nextState
  }

  function clearSessionNotice() {
    sessionNotice.value = ''
  }

  function clearConnection() {
    if (ws) {
      logger.info('ws:clear-connection', {
        readyState: ws.readyState,
      })
      ws.onclose = null
      ws.close()
      ws = null
    }
    wsSessionFilter = null
    isConnected.value = false
  }

  function syncSessionId(sessionId?: string) {
    if (typeof sessionId === 'string' && sessionId) {
      if (currentSessionId.value !== sessionId) {
        logger.info('chat:session-sync', {
          from: shortId(currentSessionId.value),
          to: shortId(sessionId),
        })
      }
      currentSessionId.value = sessionId
    }
  }

  function claimRun(event: SessionEvent): boolean {
    if (!isRunScopedEvent(event)) return true

    const eventRunId = getEventRunId(event)
    if (!eventRunId) {
      return activeRunId.value === null
    }

    if (activeRunId.value) {
      return activeRunId.value === eventRunId
    }

    if (awaitingRunStart) {
      activeRunId.value = eventRunId
      awaitingRunStart = false
      logger.info('chat:run-claimed', {
        runId: shortId(eventRunId),
      })
      return true
    }

    logger.warn('chat:event:ignored-unclaimed-run', {
      type: event.type,
      runId: shortId(eventRunId),
    })
    return false
  }

  function applySdkMessage(event: Extract<SessionEvent, { type: 'session.sdk.message' }>) {
    const clientReceivedAt = Date.now()
    const parsedMessage = getTimelineMessageFromEvent(event)
    let timelineReceivedAt = clientReceivedAt

    if (parsedMessage?.role === 'user') {
      let matchedOptimisticTimestamp: number | null = null
      let removedOptimistic = false
      optimisticUserMessages.value = optimisticUserMessages.value.filter((message) => {
        if (removedOptimistic) return true
        if (!isMatchingOptimisticUserMessage(message, parsedMessage, clientReceivedAt)) return true
        removedOptimistic = true
        matchedOptimisticTimestamp = typeof message.timestamp === 'number' ? message.timestamp : null
        return false
      })
      if (matchedOptimisticTimestamp !== null) {
        timelineReceivedAt = matchedOptimisticTimestamp
      }
    }

    const timelineEvent: Extract<SessionEvent, { type: 'session.sdk.message' }> = {
      ...event,
      receivedAt: timelineReceivedAt,
      ...(parsedMessage ? { parsed: parsedMessage } : {}),
    }
    const messageType = timelineEvent.payload?.type
    const shouldIncludeInMainline =
      messageType === 'assistant'
      || messageType === 'user'
      || isErrorResultPayload(timelineEvent.payload)

    if (!shouldIncludeInMainline) {
      syncSessionId(timelineEvent.sessionId)
      return
    }

    eventLog.value = [...eventLog.value.slice(-199), timelineEvent]
    if (parsedMessage?.role === 'assistant') {
      const toolUseIds = (parsedMessage.blocks || [])
        .flatMap((block) => block.type === 'tool_use' && typeof block.toolUseId === 'string' ? [block.toolUseId] : [])
      const responseId = getTranscriptResponseId(parsedMessage)
      const toolUseIdSet = new Set(toolUseIds)
      const materialized = markStreamPreviewsMaterialized(
        streamPreviewStates.value,
        streamAnimationCursors.value,
        responseId,
        toolUseIdSet,
      )
      streamPreviewStates.value = materialized.previewStates
      streamAnimationCursors.value = materialized.animationCursors
      scheduleFinalizedPreviewSweep()
    }
    syncSessionId(timelineEvent.sessionId)
    if (eventLog.value.length === 1 || eventLog.value.length % EVENT_LOG_INTERVAL === 0) {
      logger.debug('chat:sdk-message', {
        count: eventLog.value.length,
        payloadType: timelineEvent.payload?.type,
        sequence: timelineEvent.sequence,
        sessionId: shortId(timelineEvent.sessionId),
      })
    }
  }

  function applyInteractiveTransaction(transaction: ControlTransactionSummary) {
    controlTransactionsById.value = {
      ...controlTransactionsById.value,
      [transaction.requestId]: transaction,
    }
    const existing = new Set(activeControlOrder.value)
    if (!existing.has(transaction.requestId)) {
      activeControlOrder.value = [...activeControlOrder.value, transaction.requestId]
    }
    if (transaction.status === 'awaiting_user') {
      runState.value = 'requires_action'
    }
  }

  function scheduleStreamDisplayAdvance() {
    if (streamAnimationFrame !== null) return
    streamAnimationFrame = window.setTimeout(() => {
      streamAnimationFrame = null
      const nextAnimationCursors: Record<string, StreamAnimationCursor> = {}
      let shouldContinue = false
      let changed = false
      for (const [scopeKey, preview] of Object.entries(streamPreviewStates.value)) {
        const currentCursor = streamAnimationCursors.value[scopeKey] ?? null
        const { cursor, changed: cursorChanged, done } = advanceStreamAnimationCursor(currentCursor, preview)
        nextAnimationCursors[scopeKey] = cursor
        changed = changed || cursorChanged || currentCursor === null
        shouldContinue = shouldContinue || (preview.active && !done)
      }
      if (changed) {
        streamAnimationCursors.value = nextAnimationCursors
      }
      if (shouldContinue) {
        scheduleStreamDisplayAdvance()
      }
    }, 32)
  }

  function applyStreamEvent(
    previewStates: Record<string, StreamPreviewState>,
    animationCursors: Record<string, StreamAnimationCursor>,
    event: Extract<SessionEvent, { type: 'session.sdk.stream_event' }>,
  ): { previewStates: Record<string, StreamPreviewState>; animationCursors: Record<string, StreamAnimationCursor> } {
    syncSessionId(event.sessionId)
    const scopeKey = getStreamScopeKey(event.event)
    const currentPreview = previewStates[scopeKey] ?? null
    const nextPreview = reduceStreamPreviewEvent(currentPreview, event.event)
    const nextPreviewStates = {
      ...previewStates,
      [scopeKey]: nextPreview,
    }
    const currentCursor = animationCursors[scopeKey] ?? null
    const { cursor: nextCursor } = advanceStreamAnimationCursor(currentCursor, nextPreview)
    const nextAnimationCursors = {
      ...animationCursors,
      [scopeKey]: nextCursor,
    }
    if (!nextPreview.active) {
      nextAnimationCursors[scopeKey] = createStreamAnimationCursor(nextPreview)
      if (nextPreview.status === 'finalized') {
        scheduleFinalizedPreviewSweep(0)
        const swept = sweepFinalizedStreamPreviews(nextPreviewStates, nextAnimationCursors)
        return {
          previewStates: swept.previewStates,
          animationCursors: swept.animationCursors,
        }
      }
      scheduleStreamFinalize(scopeKey)
    } else {
      const existingFinalizeTimer = streamFinalizeTimers[scopeKey]
      if (existingFinalizeTimer !== undefined) {
        window.clearTimeout(existingFinalizeTimer)
        const { [scopeKey]: _removedTimer, ...restTimers } = streamFinalizeTimers
        streamFinalizeTimers = restTimers
      }
      scheduleStreamDisplayAdvance()
    }
    return { previewStates: nextPreviewStates, animationCursors: nextAnimationCursors }
  }

  function applyEvent(event: SessionEvent) {
    observedEventCount += 1
    if (observedEventCount === 1 || observedEventCount % EVENT_LOG_INTERVAL === 0 || event.type !== 'session.sdk.message') {
      logger.info('session:event', {
        count: observedEventCount,
        type: event.type,
        runId: 'runId' in event ? shortId(event.runId) : undefined,
        sessionId: 'sessionId' in event ? shortId(event.sessionId) : undefined,
        state: 'state' in event ? event.state : undefined,
        sequence: 'sequence' in event ? event.sequence : undefined,
      })
    }

    if (!claimRun(event)) return

    switch (event.type) {
      case 'session.run.queued':
        runState.value = 'queued'
        syncSessionId(event.sessionId)
        break

      case 'session.run.started':
        runState.value = 'running'
        syncSessionId(event.sessionId)
        break

      case 'session.run.state_changed':
        runState.value = event.state
        syncSessionId(event.sessionId)
        if (event.state === 'cancelled') {
          clearRunState('cancelled')
        }
        break

      case 'session.run.completed':
        // Legacy runner can report completion with non-zero exit code. Treat it as failed to
        // avoid wiping the UI state (history/messages) by reloading an empty/new session.
        const hasFailure = Boolean(event.error)
          || (typeof event.exitCode === 'number' && event.exitCode !== 0)
        clearRunState(hasFailure ? 'failed' : 'completed')
        syncSessionId(event.sessionId)
        logger.info('chat:done', {
          runId: shortId(event.runId),
          sessionId: shortId(event.sessionId),
          exitCode: event.exitCode,
          hasError: Boolean(event.error),
        })
        break

      case 'session.run.failed':
        logger.error('chat:error', {
          runId: shortId(event.runId),
          sessionId: shortId(event.sessionId),
          error: event.error,
        })
        sessionNotice.value = event.error
        clearRunState('failed')
        syncSessionId(event.sessionId)
        break

      case 'session.run.cancelled':
        logger.warn('chat:cancelled', {
          runId: shortId(event.runId),
          sessionId: shortId(event.sessionId),
        })
        clearRunState('cancelled')
        syncSessionId(event.sessionId)
        break

      case 'session.sdk.message':
        applySdkMessage(event)
        break

      case 'session.sdk.stream_event': {
        const next = applyStreamEvent(streamPreviewStates.value, streamAnimationCursors.value, event)
        streamPreviewStates.value = next.previewStates
        streamAnimationCursors.value = next.animationCursors
        break
      }

      case 'session.interactive.opened':
      case 'session.interactive.awaiting_user':
      case 'session.interactive.responded':
      case 'session.interactive.completed':
      case 'session.interactive.cancelled':
      case 'session.interactive.failed':
        applyInteractiveTransaction(event.transaction)
        syncSessionId(event.sessionId)
        break

      case 'session.control.opened':
      case 'session.control.awaiting_user':
      case 'session.control.responded':
      case 'session.control.completed':
      case 'session.control.cancel_requested':
      case 'session.control.cancelled':
      case 'session.control.failed':
        applyInteractiveTransaction(event.transaction)
        syncSessionId(event.sessionId)
        break

      case 'session.error':
        logger.error('chat:error', {
          runId: shortId(event.runId),
          error: event.error,
        })
        break
    }
  }

  async function checkHealth() {
    logger.info('health:request')
    try {
      const res = await fetch('/api/health')
      const data = await res.json() as HealthResponse
      authRequired.value = Boolean(data.authEnabled)
      logger.info('health:success', {
        status: data.status,
        authEnabled: authRequired.value,
      })
    } catch (error) {
      authRequired.value = false
      logger.warn('health:error', {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      authChecked.value = true
    }
  }

  async function apiFetch(input: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers || undefined)
    if (hasAuthToken.value) {
      headers.set('Authorization', `Bearer ${authToken.value}`)
    }

    logger.debug('http:request', {
      input,
      method: init.method || 'GET',
      hasAuthToken: hasAuthToken.value,
    })
    const res = await fetch(input, {
      ...init,
      headers,
    })

    if (res.status === 401) {
      authError.value = '认证失败，请重新输入访问令牌。'
      isConnected.value = false
      logger.warn('auth:401', {
        input,
        method: init.method || 'GET',
      })
    }

    return res
  }

  async function ensureAgentId(): Promise<string> {
    if (agentIdCache) return agentIdCache
    if (agentIdPromise) return await agentIdPromise

    agentIdPromise = (async () => {
      const stored = (() => {
        try {
          const value = localStorage.getItem(AGENT_ID_STORAGE_KEY)
          return value && value.trim() ? value.trim() : null
        } catch {
          return null
        }
      })()

      try {
        const res = await apiFetch('/api/agents')
        if (!res.ok) {
          agentIdCache = stored ?? 'local-dev'
          return agentIdCache
        }
        const data = await res.json() as AgentsResponse
        const agents = Array.isArray(data.agents) ? data.agents : []
        const agentIds = agents
          .map((agent) => (typeof agent?.agentId === 'string' ? agent.agentId.trim() : ''))
          .filter((id) => Boolean(id))

        const defaultFromServer = typeof data.defaultAgentId === 'string' ? data.defaultAgentId.trim() : ''
        const chosen = (stored && agentIds.includes(stored))
          ? stored
          : (defaultFromServer && agentIds.includes(defaultFromServer))
            ? defaultFromServer
            : agentIds[0] ?? stored ?? 'local-dev'

        agentIdCache = chosen
        try {
          localStorage.setItem(AGENT_ID_STORAGE_KEY, chosen)
        } catch {
          // ignore storage failures
        }
        return chosen
      } catch {
        agentIdCache = stored ?? 'local-dev'
        return agentIdCache
      } finally {
        agentIdPromise = null
      }
    })()

    return await agentIdPromise
  }

  function buildWsUrl(sessionId?: string | null): URL {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = new URL(`${protocol}//${location.host}/ws`)
    if (hasAuthToken.value) {
      wsUrl.searchParams.set('auth', authToken.value)
    }
    if (sessionId) {
      wsUrl.searchParams.set('sessionId', sessionId)
    }
    return wsUrl
  }

  function isWorkerOutputEvent(value: unknown): value is {
    kind: string
    sessionId: string
    runId?: string
    receivedAt: number
    payload?: unknown
    state?: unknown
    subtype?: unknown
    error?: unknown
  } {
    if (!value || typeof value !== 'object') return false
    const record = value as Record<string, unknown>
    return typeof record.kind === 'string'
      && typeof record.sessionId === 'string'
      && typeof record.receivedAt === 'number'
  }

  function toV2SessionStreamEvent(input: {
    payload: unknown
    runId: string
    sessionId: string
    receivedAt: number
    sequence: number
  }): SessionStreamEvent | null {
    const payload = input.payload && typeof input.payload === 'object'
      ? input.payload as Record<string, unknown>
      : null
    if (!payload || payload.type !== 'stream_event') return null

    const rawEvent = payload.event && typeof payload.event === 'object'
      ? payload.event as Record<string, unknown>
      : null
    const eventType = typeof rawEvent?.type === 'string'
      ? rawEvent.type as SessionStreamEvent['event']['type']
      : null
    if (!rawEvent || !eventType) return null

    const parentToolUseId = typeof payload.parent_tool_use_id === 'string'
      ? payload.parent_tool_use_id
      : payload.parent_tool_use_id === null
        ? null
        : undefined
    const index = typeof rawEvent.index === 'number' ? rawEvent.index : undefined

    const directMessage = rawEvent.message && typeof rawEvent.message === 'object'
      ? rawEvent.message as Record<string, unknown>
      : null
    const directMessageId = typeof directMessage?.id === 'string' ? directMessage.id : undefined

    let messageId = directMessageId
    if (messageId) {
      activeStreamMessageIds.set(input.sessionId, messageId)
    } else {
      messageId = activeStreamMessageIds.get(input.sessionId)
    }
    if (eventType === 'message_stop') {
      activeStreamMessageIds.delete(input.sessionId)
    }

    const scope: SessionStreamEvent['scope'] = messageId
      ? {
          scopeKey: `${input.sessionId}:message:${messageId}`,
          anchorKind: 'message',
          anchorId: messageId,
          messageId,
          ...(parentToolUseId !== undefined ? { parentToolUseId } : {}),
          ...(index !== undefined ? { index } : {}),
        }
      : typeof parentToolUseId === 'string'
        ? {
            scopeKey: `${input.sessionId}:tool_use:${parentToolUseId}`,
            anchorKind: 'tool_use',
            anchorId: parentToolUseId,
            parentToolUseId,
            ...(index !== undefined ? { index } : {}),
          }
        : {
            scopeKey: `${input.sessionId}:ephemeral:${input.sequence}`,
            anchorKind: 'ephemeral',
            anchorId: `${input.sessionId}:ephemeral:${input.sequence}`,
            ...(parentToolUseId !== undefined ? { parentToolUseId } : {}),
            ...(index !== undefined ? { index } : {}),
          }

    let normalized: SessionStreamEvent['normalized']
    if (eventType === 'content_block_start') {
      const block = rawEvent.content_block && typeof rawEvent.content_block === 'object'
        ? rawEvent.content_block as Record<string, unknown>
        : null
      if (block?.type === 'text') {
        normalized = { blockKind: 'text', text: typeof block.text === 'string' ? block.text : '' }
      } else if (block?.type === 'thinking') {
        normalized = { blockKind: 'thinking', thinking: typeof block.thinking === 'string' ? block.thinking : '', redacted: false }
      } else if (block?.type === 'redacted_thinking') {
        normalized = { blockKind: 'thinking', redacted: true }
      } else if (block?.type === 'tool_use') {
        normalized = {
          blockKind: 'tool_use',
          toolName: typeof block.name === 'string' ? block.name : 'unknown_tool',
          toolUseId: typeof block.id === 'string' ? block.id : undefined,
          partialJson: typeof block.input === 'string' ? block.input : undefined,
        }
      }
    } else if (eventType === 'content_block_delta') {
      const delta = rawEvent.delta && typeof rawEvent.delta === 'object'
        ? rawEvent.delta as Record<string, unknown>
        : null
      const deltaType = typeof delta?.type === 'string' ? delta.type : null
      if (delta && deltaType === 'text_delta') {
        normalized = { blockKind: 'text', deltaKind: 'text_delta', text: typeof delta.text === 'string' ? delta.text : '' }
      } else if (delta && deltaType === 'thinking_delta') {
        normalized = { blockKind: 'thinking', deltaKind: 'thinking_delta', thinking: typeof delta.thinking === 'string' ? delta.thinking : '' }
      } else if (delta && deltaType === 'input_json_delta') {
        normalized = { blockKind: 'tool_use', deltaKind: 'input_json_delta', partialJson: typeof delta.partial_json === 'string' ? delta.partial_json : '' }
      }
    }

    return {
      type: 'session.sdk.stream_event',
      runId: input.runId,
      sessionId: input.sessionId,
      receivedAt: input.receivedAt,
      sequence: input.sequence,
      scope,
      event: { type: eventType },
      ...(normalized ? { normalized } : {}),
      raw: input.payload,
    }
  }

  function patchLastAssistantMessageFooterFromResult(input: {
    sessionId: string
    runId: string
    resultPayload: unknown
  }): void {
    const resultRecord = input.resultPayload && typeof input.resultPayload === 'object'
      ? input.resultPayload as Record<string, unknown>
      : null
    if (!resultRecord) return

    // SDKResultMessage shape: { stop_reason, usage, modelUsage, ... } (no nested message)
    const stopReason = typeof resultRecord.stop_reason === 'string'
      ? resultRecord.stop_reason
      : null
    const usage = resultRecord.usage && typeof resultRecord.usage === 'object'
      ? resultRecord.usage as Record<string, unknown>
      : null
    const modelUsage = resultRecord.modelUsage && typeof resultRecord.modelUsage === 'object'
      ? resultRecord.modelUsage as Record<string, unknown>
      : null
    const model = modelUsage
      ? Object.keys(modelUsage).find((key) => key.trim().length > 0) ?? null
      : null

    if (!stopReason && !model && !usage) return

    // Find the most recent assistant message for this run and augment its raw.message.
    for (let i = eventLog.value.length - 1; i >= 0; i -= 1) {
      const event = eventLog.value[i]
      if (event.runId !== input.runId) continue
      if (event.sessionId !== input.sessionId) continue
      if (!event.parsed || event.parsed.role !== 'assistant') continue
      if (!event.parsed.raw || typeof event.parsed.raw !== 'object') continue

      const raw = event.parsed.raw as Record<string, unknown>
      const rawMessage = (raw.message && typeof raw.message === 'object')
        ? raw.message as Record<string, unknown>
        : {}
      const nextRawMessage: Record<string, unknown> = {
        ...rawMessage,
        ...(stopReason ? { stop_reason: stopReason } : {}),
        ...(model ? { model } : {}),
        ...(usage ? { usage } : {}),
      }

      const nextParsed = {
        ...event.parsed,
        raw: {
          ...raw,
          message: nextRawMessage,
        },
      }

      eventLog.value = eventLog.value.map((entry, idx) => idx === i ? { ...entry, parsed: nextParsed } : entry)
      return
    }
  }

  function applyWireEvent(wire: unknown) {
    if (!isWorkerOutputEvent(wire)) return

    const sessionId = wire.sessionId
    const runId = typeof wire.runId === 'string' && wire.runId ? wire.runId : null
    const receivedAt = Number.isFinite(wire.receivedAt) ? wire.receivedAt : Date.now()
    const sequence = ++eventSequence
    const kind = wire.kind

    // Keep UI sessionId in sync even if we drop the event.
    syncSessionId(sessionId)

    if (runId && terminalRunIds.has(runId) && kind === 'session_state_changed' && wire.state === 'idle') {
      // Avoid overriding "completed/failed" with "idle" after terminal result.
      return
    }

    if (kind === 'session_state_changed') {
      if (!runId) return
      const state = wire.state === 'running' || wire.state === 'requires_action' || wire.state === 'idle'
        ? wire.state
        : 'running'
      if (state === 'running') {
        applyEvent({ type: 'session.run.started', runId, sessionId })
      }
      applyEvent({ type: 'session.run.state_changed', runId, sessionId, state })
      return
    }

    if (kind === 'sdk_message') {
      if (!runId) return
      const parsed = normalizeSdkEnvelopeMessage((wire as { payload?: unknown }).payload)
      applyEvent({
        type: 'session.sdk.message',
        runId,
        payload: (wire as { payload?: any }).payload,
        ...(parsed ? { parsed } : {}),
        receivedAt,
        sequence,
        sessionId,
      })
      return
    }

    if (kind === 'sdk_stream_event') {
      if (!runId) return
      const streamEvent = toV2SessionStreamEvent({
        payload: (wire as { payload?: unknown }).payload,
        runId,
        sessionId,
        receivedAt,
        sequence,
      })
      if (!streamEvent) return
      applyEvent({
        type: 'session.sdk.stream_event',
        runId,
        event: streamEvent,
        receivedAt,
        sequence,
        sessionId,
      })
      return
    }

    if (kind === 'control_transaction') {
      const transaction = (wire as { transaction?: ControlTransactionSummary }).transaction
      if (!transaction) return
      const payload = (wire as { payload?: unknown }).payload
      const phase = (wire as { phase?: unknown }).phase
      const effectiveRunId = typeof transaction.runId === 'string' && transaction.runId
        ? transaction.runId
        : runId
      const targetSessionId = transaction.sessionId ?? sessionId
      const envelopeBase = {
        ...(effectiveRunId ? { runId: effectiveRunId } : {}),
        sessionId: targetSessionId,
        transaction,
        receivedAt,
        sequence,
        ...(payload !== undefined ? { payload } : {}),
      }
      switch (phase) {
        case 'opened':
          applyEvent({ type: 'session.control.opened', ...envelopeBase })
          break
        case 'awaiting_user':
          applyEvent({ type: 'session.control.awaiting_user', ...envelopeBase })
          break
        case 'responded':
          applyEvent({ type: 'session.control.responded', ...envelopeBase })
          break
        case 'cancel_requested':
          applyEvent({ type: 'session.control.cancel_requested', ...envelopeBase })
          break
        case 'cancelled':
          applyEvent({ type: 'session.control.cancelled', ...envelopeBase })
          break
        case 'completed':
          applyEvent({ type: 'session.control.completed', ...envelopeBase })
          break
        case 'failed':
          applyEvent({ type: 'session.control.failed', ...envelopeBase })
          break
        default:
          applyInteractiveTransaction(transaction)
          syncSessionId(targetSessionId)
          break
      }
      return
    }

    if (kind === 'result') {
      if (!runId) return
      terminalRunIds.add(runId)

      const payload = (wire as { payload?: any }).payload
      const parsed = normalizeSdkEnvelopeMessage(payload)
      // Surface result as an SDK message so error results render in the timeline.
      applyEvent({
        type: 'session.sdk.message',
        runId,
        payload,
        ...(parsed ? { parsed } : {}),
        receivedAt,
        sequence,
        sessionId,
      })

      // Footer (stop_reason/model/usage) often arrives on the result message rather than
      // the assistant message. Patch the last assistant message so footer can render.
      patchLastAssistantMessageFooterFromResult({
        sessionId,
        runId,
        resultPayload: payload,
      })

      const subtype = typeof wire.subtype === 'string' ? wire.subtype : 'error_during_execution'
      if (subtype === 'success') {
        applyEvent({ type: 'session.run.completed', runId, sessionId })
      } else {
        applyEvent({ type: 'session.run.failed', runId, sessionId, error: `Run failed (${subtype})` })
      }
      return
    }

    if (kind === 'worker_error') {
      const errorText = typeof wire.error === 'string' ? wire.error : 'Worker error'
      applyEvent({ type: 'session.error', ...(runId ? { runId } : {}), error: errorText })
      if (runId) {
        terminalRunIds.add(runId)
        applyEvent({ type: 'session.run.failed', runId, sessionId, error: errorText })
      }
    }

    // sdk_stream_event / worker_closed: currently ignored by the main chat UI.
  }

  function connectSocket() {
    if (authRequired.value && !hasAuthToken.value) {
      authError.value = '请输入访问令牌。'
      logger.warn('ws:connect:blocked', {
        authRequired: authRequired.value,
        hasAuthToken: hasAuthToken.value,
      })
      return
    }

    clearConnection()
    authError.value = ''
    eventSequence = 0

    const sessionId = currentSessionId.value
    wsSessionFilter = sessionId

    const wsUrl = buildWsUrl(sessionId)
    logger.info('ws:connect:start', {
      url: redactUrl(wsUrl),
      hasAuthToken: hasAuthToken.value,
      authRequired: authRequired.value,
      sessionId: shortId(sessionId),
    })

    ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      isConnected.value = true
      authError.value = ''
      logger.info('ws:open', { sessionId: shortId(sessionId) })
    }

    ws.onclose = (event: CloseEvent) => {
      isConnected.value = false
      ws = null
      wsSessionFilter = null
      logger.warn('ws:close', {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      })
      if (!authError.value && (!authRequired.value || hasAuthToken.value)) {
        logger.info('ws:reconnect:scheduled', { delayMs: 3000 })
        setTimeout(connect, 3000)
      }
    }

    ws.onerror = () => {
      isConnected.value = false
      logger.warn('ws:error', {
        authRequired: authRequired.value,
        hasAuthToken: hasAuthToken.value,
      })
      if (authRequired.value && hasAuthToken.value) {
        authError.value = '连接失败，请检查访问令牌是否正确。'
      }
    }

    ws.onmessage = (evt: MessageEvent) => {
      try {
        const parsed = JSON.parse(String(evt.data))
        applyWireEvent(parsed)
      } catch (error) {
        logger.warn('ws:message:parse-error', {
          error: error instanceof Error ? error.message : String(error),
          raw: typeof evt.data === 'string' ? evt.data.slice(0, 160) : typeof evt.data,
        })
      }
    }

    void ensureAgentId()
  }

  function connect() {
    connectSocket()
  }

  async function sendMessageImpl(prompt: string) {
    const trimmed = prompt.trim()
    if (!trimmed || isAwaitingInteraction.value || hasActiveRun.value) {
      logger.warn('chat:send:blocked', {
        hasPrompt: Boolean(trimmed),
        awaitingInteraction: isAwaitingInteraction.value,
        hasActiveRun: hasActiveRun.value,
      })
      return
    }
    clearSessionNotice()

    const hadSession = Boolean(currentSessionId.value)
    const sessionId = currentSessionId.value || generateUuid()
    currentSessionId.value = sessionId

    // Ensure WS is connected and filtered to this session.
    if (!ws || ws.readyState !== WebSocket.OPEN || wsSessionFilter !== sessionId) {
      connectSocket()
    }

    const agentId = await ensureAgentId()
    const mode = hadSession ? 'resume' : 'new'

    awaitingRunStart = true
    activeRunId.value = null
    controlTransactionsById.value = {}
    activeControlOrder.value = []
    runState.value = 'queued'
    optimisticMessageCount += 1
    optimisticUserMessages.value = [
      ...optimisticUserMessages.value,
      {
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
        optimistic: true,
        localId: `optimistic-${optimisticMessageCount}`,
      },
    ]

    logger.info('chat:send', {
      sessionId: shortId(sessionId),
      agentId,
      mode,
      promptLength: trimmed.length,
    })

    try {
      const res = await apiFetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          agentId,
          text: trimmed,
          mode,
        }),
      })
      const data = await res.json().catch(() => null) as any
      if (!res.ok) {
        const message = data && typeof data === 'object' && 'error' in data ? String(data.error) : `HTTP ${res.status}`
        if (res.status === 409 && data && typeof data === 'object' && data.error === 'session_busy') {
          const activeRun = typeof data.activeRunId === 'string' && data.activeRunId ? shortId(data.activeRunId) : undefined
          const status = typeof data.sessionStatus === 'string' ? data.sessionStatus : 'running'
          sessionNotice.value = activeRun
            ? `当前 Session 正忙（${status}，run ${activeRun}），请先等待，或执行中断 / 重建。`
            : `当前 Session 正忙（${status}），请先等待，或执行中断 / 重建。`
        } else {
          sessionNotice.value = message
        }
        applyEvent({ type: 'session.run.failed', sessionId, error: message })
        return
      }

      const runId = typeof data?.runId === 'string' ? data.runId : null
      if (!runId) {
        applyEvent({ type: 'session.run.failed', sessionId, error: 'Run accepted but missing runId' })
        return
      }

      // Claim the run immediately; the runtime does not emit a separate "queued" event.
      awaitingRunStart = false
      activeRunId.value = runId
      applyEvent({ type: 'session.run.queued', runId, sessionId })
    } catch (error) {
      applyEvent({
        type: 'session.run.failed',
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  function sendMessage(prompt: string) {
    void sendMessageImpl(prompt)
  }

  async function fetchSessions(): Promise<boolean> {
    logger.info('sessions:fetch:start')
    try {
      const res = await apiFetch('/api/sessions')
      if (!res.ok) {
        logger.warn('sessions:fetch:error', { status: res.status })
        return false
      }
      const data = await res.json()
      sessions.value = (data.sessions || []).map((s: any) => normalizeSession(s)).filter((s: SessionSummary) => s.id)
      logger.info('sessions:fetch:success', {
        count: sessions.value.length,
      })
      return true
    } catch (error) {
      logger.error('sessions:fetch:error', {
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  async function stopSession(sessionId: string): Promise<boolean> {
    const trimmed = sessionId.trim()
    if (!trimmed) return false
    try {
      const res = await apiFetch(`/api/sessions/${encodeURIComponent(trimmed)}/stop`, {
        method: 'POST',
      })
      if (!res.ok) {
        logger.warn('session:stop:error', {
          sessionId: shortId(trimmed),
          status: res.status,
        })
        return false
      }
      logger.info('session:stop:success', {
        sessionId: shortId(trimmed),
      })
      if (currentSessionId.value === trimmed) {
        clearRunState('idle')
      }
      await fetchSessions()
      return true
    } catch (error) {
      logger.error('session:stop:error', {
        sessionId: shortId(trimmed),
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  async function rebuildSession(sessionId: string): Promise<boolean> {
    const trimmed = sessionId.trim()
    if (!trimmed) return false
    try {
      const res = await apiFetch(`/api/sessions/${encodeURIComponent(trimmed)}/rebuild`, {
        method: 'POST',
      })
      if (!res.ok) {
        logger.warn('session:rebuild:error', {
          sessionId: shortId(trimmed),
          status: res.status,
        })
        return false
      }
      logger.info('session:rebuild:success', {
        sessionId: shortId(trimmed),
      })
      if (currentSessionId.value === trimmed) {
        clearRunState('idle')
      }
      await fetchSessions()
      return true
    } catch (error) {
      logger.error('session:rebuild:error', {
        sessionId: shortId(trimmed),
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  function newChat() {
    logger.info('chat:new')
    currentSessionId.value = null
    historyMessages.value = []
    optimisticUserMessages.value = []
    historyMessagesHasMore.value = false
    historyMessagesLoading.value = false
    historyMessagesLoadingOlder.value = false
    historyMessagesBeforeCursor.value = null
    eventLog.value = []
    streamPreviewStates.value = {}
    streamAnimationCursors.value = {}
    if (streamAnimationFrame !== null) {
      window.clearTimeout(streamAnimationFrame)
      streamAnimationFrame = null
    }
    observedEventCount = 0
    optimisticMessageCount = 0
    clearRunState('idle')
  }

  function selectSession(id: string) {
    logger.info('chat:select-session', {
      sessionId: shortId(id),
    })
    currentSessionId.value = id
    historyMessages.value = []
    optimisticUserMessages.value = []
    historyMessagesHasMore.value = false
    historyMessagesLoading.value = false
    historyMessagesLoadingOlder.value = false
    historyMessagesBeforeCursor.value = null
    eventLog.value = []
    streamPreviewStates.value = {}
    streamAnimationCursors.value = {}
    if (streamAnimationFrame !== null) {
      window.clearTimeout(streamAnimationFrame)
      streamAnimationFrame = null
    }
    observedEventCount = 0
    optimisticMessageCount = 0
    clearRunState('idle')
    loadSessionMessages(id, { reset: true })
  }

  async function loadSessionMessages(
    id: string,
    options: { reset?: boolean; prepend?: boolean; before?: string | null } = {},
  ) {
    if (!id || historyMessagesLoading.value) return false

    historyMessagesLoading.value = true
    historyMessagesLoadingOlder.value = Boolean(options.prepend)
    logger.info('messages:load:start', {
      sessionId: shortId(id),
      reset: Boolean(options.reset),
      prepend: Boolean(options.prepend),
      before: options.before ? shortId(options.before) : null,
    })
    try {
      const params = new URLSearchParams()
      params.set('limit', String(DEFAULT_HISTORY_PAGE_SIZE))
      if (options.before) params.set('before', options.before)
      const res = await apiFetch(`/api/sessions/${id}/messages?${params.toString()}`)
      if (!res.ok) {
        logger.warn('messages:load:error', {
          sessionId: shortId(id),
          status: res.status,
          reset: Boolean(options.reset),
          prepend: Boolean(options.prepend),
        })
        return false
      }
      const data = await res.json() as SessionMessagesResponse
      const messages = (data.messages || []).filter((message): message is SessionMessage => Boolean(message && typeof message === 'object'))
      if (options.prepend) {
        historyMessages.value = [...messages, ...historyMessages.value]
      } else {
        historyMessages.value = messages
        optimisticUserMessages.value = []
        eventLog.value = eventLog.value.filter((event) => {
          if ('sessionId' in event && event.sessionId && event.sessionId !== id) return true
          return shouldRetainSdkMessageAfterHistoryReload(event.payload)
        })
        streamPreviewStates.value = {}
        streamAnimationCursors.value = {}
      }
      historyMessagesHasMore.value = Boolean(data.hasMore)
      historyMessagesBeforeCursor.value = typeof data.nextBefore === 'string' && data.nextBefore ? data.nextBefore : null
      logger.info('messages:load:success', {
        sessionId: shortId(id),
        count: messages.length,
        total: historyMessages.value.length,
        hasMore: historyMessagesHasMore.value,
        nextBefore: historyMessagesBeforeCursor.value ? shortId(historyMessagesBeforeCursor.value) : null,
        reset: Boolean(options.reset),
        prepend: Boolean(options.prepend),
      })
      return true
    } catch (error) {
      logger.error('messages:load:error', {
        sessionId: shortId(id),
        error: error instanceof Error ? error.message : String(error),
        reset: Boolean(options.reset),
        prepend: Boolean(options.prepend),
      })
      return false
    } finally {
      historyMessagesLoading.value = false
      historyMessagesLoadingOlder.value = false
    }
  }

  async function loadOlderSessionMessages() {
    if (!currentSessionId.value || !historyMessagesHasMore.value || historyMessagesLoading.value || !historyMessagesBeforeCursor.value) {
      return false
    }
    return loadSessionMessages(currentSessionId.value, {
      prepend: true,
      before: historyMessagesBeforeCursor.value,
    })
  }

  function requestControl(subtype: 'interrupt' | 'get_context_usage' | 'mcp_status') {
    const controlPath = currentSessionId.value
      ? `/api/sessions/${encodeURIComponent(currentSessionId.value)}/control`
      : null

    if (!controlPath) {
      logger.warn('chat:control:blocked', {
        subtype,
        activeRunId: shortId(activeRunId.value),
        sessionId: shortId(currentSessionId.value),
      })
      return
    }

    logger.info('chat:control-request', {
      subtype,
      sessionId: shortId(currentSessionId.value),
    })
    clearSessionNotice()
    void apiFetch(controlPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subtype }),
    }).then(async (res) => {
      if (res.ok) return
      const data = await res.json().catch(() => null) as any
      const error = data && typeof data === 'object' && 'error' in data
        ? String(data.error)
        : `HTTP ${res.status}`
      sessionNotice.value = error
      logger.warn('chat:control-request:error', {
        subtype,
        sessionId: shortId(currentSessionId.value),
        error,
      })
    }).catch((error) => {
      sessionNotice.value = error instanceof Error ? error.message : String(error)
      logger.warn('chat:control-request:error', {
        subtype,
        sessionId: shortId(currentSessionId.value),
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  function respondToInteraction(response: { kind: 'permission'; decision: 'approve' | 'deny'; selectedSuggestion?: PermissionSuggestion | null; content?: Record<string, string | number | boolean | string[]> } | { kind: 'elicitation'; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }) {
    if (!currentSessionId.value || !pendingInteraction.value) {
      logger.warn('chat:interactive:blocked', {
        kind: response.kind,
        sessionId: shortId(currentSessionId.value),
        interactionId: shortId(pendingInteraction.value?.id),
      })
      return
    }

    logger.info('chat:interactive:respond', {
      kind: response.kind,
      interactionId: shortId(pendingInteraction.value.id),
      sessionId: shortId(currentSessionId.value),
    })
    clearSessionNotice()

    void apiFetch(`/api/sessions/${encodeURIComponent(currentSessionId.value)}/control/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: pendingInteraction.value.id,
        kind: response.kind,
        response: response.kind === 'permission'
          ? {
              decision: response.decision,
              ...(response.selectedSuggestion !== undefined ? { selectedSuggestion: response.selectedSuggestion } : {}),
              ...(response.content ? { content: response.content } : {}),
            }
          : {
              action: response.action,
              ...(response.content ? { content: response.content } : {}),
            },
      }),
    }).then(async (res) => {
      if (res.ok) return
      const data = await res.json().catch(() => null) as any
      const error = data && typeof data === 'object' && 'error' in data
        ? String(data.error)
        : `HTTP ${res.status}`
      sessionNotice.value = error
      logger.warn('chat:interactive:respond:error', {
        kind: response.kind,
        sessionId: shortId(currentSessionId.value),
        interactionId: shortId(pendingInteraction.value?.id),
        error,
      })
    }).catch((error) => {
      sessionNotice.value = error instanceof Error ? error.message : String(error)
      logger.warn('chat:interactive:respond:error', {
        kind: response.kind,
        sessionId: shortId(currentSessionId.value),
        interactionId: shortId(pendingInteraction.value?.id),
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  function cancelPendingInteraction() {
    if (!currentSessionId.value || !pendingInteraction.value) {
      logger.warn('chat:interactive:cancel:blocked', {
        sessionId: shortId(currentSessionId.value),
        interactionId: shortId(pendingInteraction.value?.id),
      })
      return
    }

    logger.info('chat:interactive:cancel', {
      sessionId: shortId(currentSessionId.value),
      interactionId: shortId(pendingInteraction.value.id),
    })
    clearSessionNotice()
    void apiFetch(`/api/sessions/${encodeURIComponent(currentSessionId.value)}/control/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: pendingInteraction.value.id,
      }),
    }).then(async (res) => {
      if (res.ok) return
      const data = await res.json().catch(() => null) as any
      const error = data && typeof data === 'object' && 'error' in data
        ? String(data.error)
        : `HTTP ${res.status}`
      sessionNotice.value = error
      logger.warn('chat:interactive:cancel:error', {
        sessionId: shortId(currentSessionId.value),
        interactionId: shortId(pendingInteraction.value?.id),
        error,
      })
    }).catch((error) => {
      sessionNotice.value = error instanceof Error ? error.message : String(error)
      logger.warn('chat:interactive:cancel:error', {
        sessionId: shortId(currentSessionId.value),
        interactionId: shortId(pendingInteraction.value?.id),
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }


  async function initialize() {
    logger.info('initialize:start', {
      hasAuthToken: hasAuthToken.value,
    })
    await checkHealth()
    if (!authRequired.value) {
      connect()
      await fetchSessions()
      return
    }

    if (hasAuthToken.value) {
      const ok = await fetchSessions()
      if (ok) {
        connect()
      }
    }
  }

  async function setAuthToken(token: string) {
    persistAuthToken(token)
    authError.value = ''
    if (!authChecked.value) return

    if (!authRequired.value) {
      connect()
      await fetchSessions()
      return
    }

    const ok = await fetchSessions()
    if (ok) {
      connect()
    }
  }

  function clearAuthToken() {
    logger.info('auth:clear-token')
    persistAuthToken('')
    clearConnection()
    authError.value = ''
    sessionNotice.value = ''
    currentSessionId.value = null
    historyMessages.value = []
    optimisticUserMessages.value = []
    historyMessagesHasMore.value = false
    historyMessagesLoading.value = false
    historyMessagesLoadingOlder.value = false
    historyMessagesBeforeCursor.value = null
    sessions.value = []
    eventLog.value = []
    streamPreviewStates.value = {}
    streamAnimationCursors.value = {}
    observedEventCount = 0
    optimisticMessageCount = 0
    clearRunState('idle')
  }

  return {
    timeline,
    historyMessages,
    historyTimelineItems,
    userLaneEvents,
    userTimelineItems,
    liveLaneEvents,
    sessionLaneEvents,
    liveAtoms,
    streamPreviewStates,
    streamAnimationCursors,
    livePreviewItems,
    historyMessagesHasMore,
    historyMessagesLoading,
    historyMessagesLoadingOlder,
    historyMessagesBeforeCursor,
    sessions,
    currentSessionId,
    isConnected,
    isLoading,
    runState,
    currentSessionSummary,
    authToken,
    authError,
    sessionNotice,
    authRequired,
    authChecked,
    hasAuthToken,
    hasActiveRun,
    activeRunId,
    pendingInteraction,
    controlTransactionsById,
    activeControlOrder,
    eventLog,
    isAwaitingApproval,
    isAwaitingInteraction,
    connect,
    sendMessage,
    respondToInteraction,
    cancelPendingInteraction,
    requestControl,
    stopSession,
    rebuildSession,
    fetchSessions,
    newChat,
    selectSession,
    loadOlderSessionMessages,
    initialize,
    clearSessionNotice,
    setAuthToken,
    clearAuthToken,
  }
})
