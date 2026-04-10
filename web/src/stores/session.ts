import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  AssistantDisplayItem,
  CollapsedToolBatchDisplayItem,
  ControlTransactionSummary,
  DisplayItem,
  GroupedToolUseDisplayItem,
  LaneKind,
  LiveLaneKind,
  PendingInteraction,
  PermissionSuggestion,
  SessionBindingStatus,
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
} from '../../../shared/message-types.js'
import {
  classifySdkMessageLane,
  getSdkMessageLayer,
} from '../../../shared/message-types.js'
import {
  buildDisplayItems,
  buildHistoryDisplayItems,
  buildTranscriptAtom,
} from '../../../shared/transcript-display.js'
import {
  advanceStreamAnimationCursor,
  createStreamAnimationCursor,
  reduceStreamPreviewEvent,
  renderStreamPreviewState,
  getTranscriptMessageId,
  getTranscriptResponseId,
  getTranscriptStopReason,
} from '../../../shared/transcript-normalizer.js'
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

interface SessionMessagesResponse {
  messages?: unknown[]
  hasMore?: boolean
  nextBefore?: string | null
}

interface SessionBindingStatusResponse {
  ref?: SessionBindingStatus['ref']
  binding?: SessionBindingStatus['binding']
  session?: SessionBindingStatus['session']
  activeRun?: SessionBindingStatus['activeRun']
}

interface SessionBindingsListResponse {
  bindings?: SessionBindingStatusResponse[]
}

type RuntimeSdkMessageEvent = Extract<SessionEvent, { type: 'session.sdk.message' }>
type LaneBucket<T> = {
  lane: LaneKind
  items: T[]
}
type LiveLaneBuckets = Record<LiveLaneKind, RuntimeSdkMessageEvent[]>

const AUTH_TOKEN_STORAGE_KEY = 'cotta-auth-token'
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
  }
}

function getEventRunId(event: SessionEvent): string | null {
  return 'runId' in event && typeof event.runId === 'string' ? event.runId : null
}

function isRunScopedEvent(event: SessionEvent): boolean {
  return event.type !== 'session.error' || typeof event.runId === 'string'
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

function getTimelineMessageFromEvent(event: Extract<SessionEvent, { type: 'session.sdk.message' }>): SessionMessage | null {
  return event.parsed ?? null
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

function isOverlayHostItem(item: DisplayItem): item is AssistantDisplayItem | GroupedToolUseDisplayItem | CollapsedToolBatchDisplayItem {
  return item.kind === 'assistant' || item.kind === 'grouped_tool_use' || item.kind === 'collapsed_tool_batch'
}

function getDisplayItemToolUseIds(item: AssistantDisplayItem | GroupedToolUseDisplayItem | CollapsedToolBatchDisplayItem): string[] {
  if (item.kind === 'grouped_tool_use') {
    return item.toolUses.flatMap((tool) => typeof tool.toolUseId === 'string' ? [tool.toolUseId] : [])
  }

  if (item.kind === 'collapsed_tool_batch') {
    return item.items.flatMap((child) => getDisplayItemToolUseIds(child))
  }

  return item.fragments.flatMap((fragment) => fragment.type === 'tool_use' && typeof fragment.toolUseId === 'string' ? [fragment.toolUseId] : [])
}

function shouldAttachOverlayToItem(
  item: AssistantDisplayItem | GroupedToolUseDisplayItem | CollapsedToolBatchDisplayItem,
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
  item: AssistantDisplayItem | GroupedToolUseDisplayItem | CollapsedToolBatchDisplayItem,
  overlay: TimelineLivePreviewItem,
): number {
  if (!shouldAttachOverlayToItem(item, overlay)) return -1
  if (overlay.anchor.anchorKind === 'tool_use' || overlay.anchor.parentToolUseId) {
    if (item.kind === 'grouped_tool_use') return 3
    if (item.kind === 'collapsed_tool_batch') return 2
    return 1
  }
  if (overlay.anchor.anchorKind === 'message' || overlay.anchor.messageId) {
    if (item.kind === 'assistant') return 3
    if (item.kind === 'grouped_tool_use') return 2
    if (item.kind === 'collapsed_tool_batch') return 1
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
  const authRequired = ref(false)
  const authChecked = ref(false)
  const activeRunId = ref<string | null>(null)
  const controlTransactionsById = ref<Record<string, ControlTransactionSummary>>({})
  const activeControlOrder = ref<string[]>([])
  const bindingChannel = ref<'lark' | 'web' | 'discord'>('lark')
  const bindingConversationKey = ref('')
  const bindingStatus = ref<SessionBindingStatus | null>(null)
  const bindingCandidates = ref<SessionSummary[]>([])
  const bindingList = ref<SessionBindingStatus[]>([])
  const bindingLoading = ref(false)
  const bindingError = ref('')
  const bindingTargetSessionId = ref('')
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
  const recentControlTransactions = computed<ControlTransactionSummary[]>(() =>
    activeControlOrder.value
      .map((requestId) => controlTransactionsById.value[requestId])
      .filter((transaction): transaction is ControlTransactionSummary => Boolean(transaction))
      .slice()
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 8)
  )
  const pendingInteraction = computed<PendingInteraction | null>(() => activeInteractiveControl.value?.interaction ?? null)
  const isAwaitingApproval = computed(() => pendingInteraction.value?.kind === 'permission' && pendingInteraction.value?.status === 'pending')
  const isAwaitingInteraction = computed(() => pendingInteraction.value?.status === 'pending')
  const hasActiveRun = computed(() => awaitingRunStart || activeRunId.value !== null)
  const bindingSummary = computed(() => bindingStatus.value?.binding?.sessionId || '未绑定')
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
  const observabilityEvents = computed(() => sessionLaneEvents.value.filter((event) => {
    if (getSdkMessageLayer(event.payload) !== 'debug-observability') return false
    return !(event.payload?.type === 'system' && event.payload?.subtype === 'init')
  }))
  const debugTimelineVisible = ref(false)
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
    const lastVisibleTimestamp = itemsWithOverlays.length > 0
      ? Math.max(...itemsWithOverlays.map((item) => item.timestamp))
      : null
    const positionedUnattachedOverlays = lastVisibleTimestamp === null
      ? unattachedOverlays
      : unattachedOverlays.map((overlay, index) => ({
          ...overlay,
          timestamp: Math.max(overlay.timestamp, lastVisibleTimestamp + index + 1),
        }))

    return [...itemsWithOverlays, ...positionedUnattachedOverlays]
      .slice()
      .sort((left, right) => {
        if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp
        return left.key.localeCompare(right.key)
      })
  })

  let ws: WebSocket | null = null
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

  function clearConnection() {
    if (ws) {
      logger.info('ws:clear-connection', {
        readyState: ws.readyState,
      })
      ws.onclose = null
      ws.close()
      ws = null
    }
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
    }
    const layer = getSdkMessageLayer(timelineEvent.payload)

    if (layer === 'run-state') {
      syncSessionId(timelineEvent.sessionId)
      return
    }

    eventLog.value = [...eventLog.value.slice(-199), timelineEvent]
    if (layer === 'business-message') {
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

  function applyTransportEvent(event: Extract<SessionEvent, { type: 'session.sdk.transport' }>) {
    syncSessionId(event.event.sessionId)
    logger.debug('chat:sdk-transport:ignored-ws', {
      direction: event.event.direction,
      eventName: event.event.eventName,
      sequence: event.event.sequence,
      sessionId: shortId(event.event.sessionId),
    })
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
    if (observedEventCount === 1 || observedEventCount % EVENT_LOG_INTERVAL === 0 || (event.type !== 'session.sdk.message' && event.type !== 'session.sdk.transport')) {
      logger.info('session:event', {
        count: observedEventCount,
        type: event.type,
        runId: 'runId' in event ? shortId(event.runId) : undefined,
        sessionId: 'sessionId' in event ? shortId(event.sessionId) : event.type === 'session.sdk.transport' ? shortId(event.event.sessionId) : undefined,
        state: 'state' in event ? event.state : undefined,
        sequence: 'sequence' in event ? event.sequence : event.type === 'session.sdk.transport' ? event.event.sequence : undefined,
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
        streamPreviewStates.value = {}
        streamAnimationCursors.value = {}
        runState.value = 'completed'
        activeRunId.value = null
        awaitingRunStart = false
        syncSessionId(event.sessionId)
        logger.info('chat:done', {
          runId: shortId(event.runId),
          sessionId: shortId(event.sessionId),
          exitCode: event.exitCode,
          hasError: Boolean(event.error),
        })
        fetchSessions()
        if (event.sessionId && currentSessionId.value === event.sessionId) {
          loadSessionMessages(event.sessionId, { reset: true })
        }
        break

      case 'session.run.failed':
        logger.error('chat:error', {
          runId: shortId(event.runId),
          sessionId: shortId(event.sessionId),
          error: event.error,
        })
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

      case 'session.sdk.transport':
        applyTransportEvent(event)
        break

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

  function connect() {
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

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = new URL(`${protocol}//${location.host}/ws`)
    if (hasAuthToken.value) {
      wsUrl.searchParams.set('auth', authToken.value)
    }

    logger.info('ws:connect:start', {
      url: redactUrl(wsUrl),
      hasAuthToken: hasAuthToken.value,
      authRequired: authRequired.value,
    })
    ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      isConnected.value = true
      authError.value = ''
      logger.info('ws:open')
    }

    ws.onclose = (event) => {
      isConnected.value = false
      ws = null
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

    ws.onmessage = (evt) => {
      try {
        applyEvent(JSON.parse(evt.data) as SessionEvent)
      } catch (error) {
        logger.warn('ws:message:parse-error', {
          error: error instanceof Error ? error.message : String(error),
          raw: typeof evt.data === 'string' ? evt.data.slice(0, 160) : typeof evt.data,
        })
      }
    }
  }

  function sendMessage(prompt: string) {
    const trimmed = prompt.trim()
    if (!ws || ws.readyState !== WebSocket.OPEN || !trimmed || isAwaitingInteraction.value || hasActiveRun.value) {
      logger.warn('chat:send:blocked', {
        connected: Boolean(ws && ws.readyState === WebSocket.OPEN),
        hasPrompt: Boolean(trimmed),
        awaitingInteraction: isAwaitingInteraction.value,
        hasActiveRun: hasActiveRun.value,
      })
      return
    }

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
      promptLength: trimmed.length,
      sessionId: shortId(currentSessionId.value),
      hasActiveRun: hasActiveRun.value,
    })

    ws.send(
      JSON.stringify({
        action: 'message.create',
        prompt: trimmed,
        ...(currentSessionId.value ? { sessionId: currentSessionId.value } : {}),
      })
    )
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

  async function fetchBindingCandidates(limit: number = 20): Promise<boolean> {
    try {
      const res = await apiFetch(`/api/session-candidates?limit=${limit}`)
      if (!res.ok) return false
      const data = await res.json()
      bindingCandidates.value = (data.sessions || []).map((s: any) => normalizeSession(s)).filter((s: SessionSummary) => s.id)
      return true
    } catch (error) {
      logger.error('binding:candidates:error', {
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  async function fetchBindingList(): Promise<boolean> {
    bindingLoading.value = true
    bindingError.value = ''
    try {
      const res = await apiFetch(`/api/channels/${bindingChannel.value}/bindings`)
      if (!res.ok) {
        bindingError.value = `加载 bindings 列表失败 (${res.status})`
        return false
      }
      const data = await res.json() as SessionBindingsListResponse
      bindingList.value = (data.bindings || []).map((item) => ({
        ref: item.ref ?? { channel: bindingChannel.value, conversationKey: '' },
        binding: item.binding ?? null,
        session: item.session ?? null,
        activeRun: item.activeRun ?? null,
      }))
      return true
    } catch (error) {
      bindingError.value = error instanceof Error ? error.message : String(error)
      return false
    } finally {
      bindingLoading.value = false
    }
  }

  async function fetchBindingStatus(): Promise<boolean> {
    const conversationKey = bindingConversationKey.value.trim()
    if (!conversationKey) {
      bindingStatus.value = null
      bindingError.value = ''
      return false
    }

    bindingLoading.value = true
    bindingError.value = ''
    try {
      const res = await apiFetch(`/api/channels/${bindingChannel.value}/conversations/${encodeURIComponent(conversationKey)}/binding`)
      if (!res.ok) {
        bindingError.value = `加载 binding 失败 (${res.status})`
        return false
      }
      const data = await res.json() as SessionBindingStatusResponse
      bindingStatus.value = {
        ref: data.ref ?? { channel: bindingChannel.value, conversationKey },
        binding: data.binding ?? null,
        session: data.session ?? null,
        activeRun: data.activeRun ?? null,
      }
      bindingTargetSessionId.value = bindingStatus.value.binding?.sessionId || ''
      return true
    } catch (error) {
      bindingError.value = error instanceof Error ? error.message : String(error)
      return false
    } finally {
      bindingLoading.value = false
    }
  }

  async function bindConversationToSession(sessionId: string): Promise<boolean> {
    const conversationKey = bindingConversationKey.value.trim()
    const targetSessionId = sessionId.trim()
    if (!conversationKey || !targetSessionId) return false

    bindingLoading.value = true
    bindingError.value = ''
    try {
      const res = await apiFetch(`/api/channels/${bindingChannel.value}/conversations/${encodeURIComponent(conversationKey)}/binding`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: targetSessionId }),
      })
      if (!res.ok) {
        bindingError.value = `更新 binding 失败 (${res.status})`
        return false
      }
      const data = await res.json() as SessionBindingStatusResponse
      bindingStatus.value = {
        ref: data.ref ?? { channel: bindingChannel.value, conversationKey },
        binding: data.binding ?? null,
        session: data.session ?? null,
        activeRun: data.activeRun ?? null,
      }
      bindingTargetSessionId.value = bindingStatus.value.binding?.sessionId || targetSessionId
      return true
    } catch (error) {
      bindingError.value = error instanceof Error ? error.message : String(error)
      return false
    } finally {
      bindingLoading.value = false
    }
  }

  async function clearBindingStatus(): Promise<boolean> {
    const conversationKey = bindingConversationKey.value.trim()
    if (!conversationKey) return false

    bindingLoading.value = true
    bindingError.value = ''
    try {
      const res = await apiFetch(`/api/channels/${bindingChannel.value}/conversations/${encodeURIComponent(conversationKey)}/binding`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        bindingError.value = `清除 binding 失败 (${res.status})`
        return false
      }
      const data = await res.json() as SessionBindingStatusResponse
      bindingStatus.value = {
        ref: data.ref ?? { channel: bindingChannel.value, conversationKey },
        binding: data.binding ?? null,
        session: data.session ?? null,
        activeRun: data.activeRun ?? null,
      }
      bindingTargetSessionId.value = ''
      return true
    } catch (error) {
      bindingError.value = error instanceof Error ? error.message : String(error)
      return false
    } finally {
      bindingLoading.value = false
    }
  }

  function setBindingChannel(channel: 'lark' | 'web' | 'discord') {
    bindingChannel.value = channel
  }

  function setBindingConversationKey(value: string) {
    bindingConversationKey.value = value
  }

  function setBindingTargetSessionId(value: string) {
    bindingTargetSessionId.value = value
  }

  function applyBindingCandidate(sessionId: string) {
    bindingTargetSessionId.value = sessionId
  }

  function selectBindingEntry(entry: SessionBindingStatus) {
    bindingChannel.value = entry.ref.channel
    bindingConversationKey.value = entry.ref.conversationKey
    bindingStatus.value = entry
    bindingTargetSessionId.value = entry.binding?.sessionId || ''
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
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeRunId.value) {
      logger.warn('chat:control-request:blocked', {
        hasSocket: Boolean(ws && ws.readyState === WebSocket.OPEN),
        activeRunId: shortId(activeRunId.value),
        subtype,
      })
      return
    }

    logger.info('chat:control-request', {
      subtype,
      runId: shortId(activeRunId.value),
    })
    ws.send(JSON.stringify({
      action: 'control.request',
      runId: activeRunId.value,
      subtype,
      ...(currentSessionId.value ? { sessionId: currentSessionId.value } : {}),
    }))
  }

  function respondToInteraction(response: { kind: 'permission'; decision: 'approve' | 'deny'; selectedSuggestion?: PermissionSuggestion | null; content?: Record<string, string | number | boolean | string[]> } | { kind: 'elicitation'; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !pendingInteraction.value || !activeRunId.value) {
      logger.warn('chat:interactive:blocked', {
        hasSocket: Boolean(ws && ws.readyState === WebSocket.OPEN),
        interactionKind: pendingInteraction.value?.kind,
        activeRunId: shortId(activeRunId.value),
      })
      return
    }


    logger.info('chat:interactive:respond', {
      kind: response.kind,
      interactionId: shortId(pendingInteraction.value.id),
      runId: shortId(activeRunId.value),
    })

    ws.send(
      JSON.stringify({
        action: 'interactive.respond',
        runId: activeRunId.value,
        interactionId: pendingInteraction.value.id,
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
        ...(currentSessionId.value ? { sessionId: currentSessionId.value } : {}),
      })
    )
  }


  async function initialize() {
    logger.info('initialize:start', {
      hasAuthToken: hasAuthToken.value,
    })
    await checkHealth()
    if (!authRequired.value) {
      connect()
      await fetchSessions()
      await fetchBindingCandidates()
      await fetchBindingList()
      return
    }

    if (hasAuthToken.value) {
      const ok = await fetchSessions()
      if (ok) {
        await fetchBindingCandidates()
        await fetchBindingList()
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
      await fetchBindingCandidates()
      await fetchBindingList()
      return
    }

    const ok = await fetchSessions()
    if (ok) {
      await fetchBindingCandidates()
      await fetchBindingList()
      connect()
    }
  }

  function clearAuthToken() {
    logger.info('auth:clear-token')
    persistAuthToken('')
    clearConnection()
    authError.value = ''
    currentSessionId.value = null
    historyMessages.value = []
    optimisticUserMessages.value = []
    historyMessagesHasMore.value = false
    historyMessagesLoading.value = false
    historyMessagesLoadingOlder.value = false
    historyMessagesBeforeCursor.value = null
    sessions.value = []
    bindingStatus.value = null
    bindingCandidates.value = []
    bindingList.value = []
    bindingConversationKey.value = ''
    bindingTargetSessionId.value = ''
    bindingError.value = ''
    eventLog.value = []
    streamPreviewStates.value = {}
    streamAnimationCursors.value = {}
    observedEventCount = 0
    optimisticMessageCount = 0
    clearRunState('idle')
  }

  function setDebugTimelineVisible(visible: boolean) {
    debugTimelineVisible.value = visible
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
    debugTimelineVisible,
    historyMessagesHasMore,
    historyMessagesLoading,
    historyMessagesLoadingOlder,
    historyMessagesBeforeCursor,
    sessions,
    currentSessionId,
    isConnected,
    isLoading,
    runState,
    authToken,
    authError,
    authRequired,
    authChecked,
    hasAuthToken,
    hasActiveRun,
    activeRunId,
    pendingInteraction,
    controlTransactionsById,
    activeControlOrder,
    recentControlTransactions,
    bindingChannel,
    bindingConversationKey,
    bindingStatus,
    bindingCandidates,
    bindingList,
    bindingLoading,
    bindingError,
    bindingTargetSessionId,
    bindingSummary,
    observabilityEvents,
    eventLog,
    isAwaitingApproval,
    isAwaitingInteraction,
    connect,
    sendMessage,
    respondToInteraction,
    requestControl,
    fetchSessions,
    fetchBindingCandidates,
    fetchBindingList,
    fetchBindingStatus,
    bindConversationToSession,
    clearBindingStatus,
    setBindingChannel,
    setBindingConversationKey,
    setBindingTargetSessionId,
    applyBindingCandidate,
    selectBindingEntry,
    newChat,
    selectSession,
    loadOlderSessionMessages,
    initialize,
    setDebugTimelineVisible,
    setAuthToken,
    clearAuthToken,
  }
})
