import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  AssistantDisplayItem,
  CollapsedToolBatchDisplayItem,
  DisplayItem,
  GroupedToolUseDisplayItem,
  PendingInteraction,
  PermissionSuggestion,
  SessionEvent,
  SessionMessage,
  SessionMessageBlock,
  SessionRunState,
  SessionStreamEvent,
  SessionSummary,
  StreamDisplayState,
  StreamPreviewState,
  TimelineLivePreviewItem,
  TimelineRenderableItem,
  TranscriptAtom,
} from '../../../shared/message-types.js'
import {
  getSdkMessageLayer,
  isBusinessSdkMessage,
} from '../../../shared/message-types.js'
import {
  getHiddenAtomsForDebug,
  buildDisplayItems,
  buildTranscriptAtom,
} from '../../../shared/transcript-display.js'
import {
  advanceStreamDisplayState,
  createStreamDisplayState,
  reduceStreamPreviewEvent,
  getTranscriptMessageId,
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

const AUTH_TOKEN_STORAGE_KEY = 'cotta-auth-token'
const DEFAULT_HISTORY_PAGE_SIZE = 100
const logger = createDebugLogger('session-store')
const EVENT_LOG_INTERVAL = 20
const OPTIMISTIC_USER_MATCH_WINDOW_MS = 30_000

type HistoryMessage = SessionMessage & {
  optimistic?: boolean
  localId?: string
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

function isMatchingOptimisticUserMessage(message: HistoryMessage, candidate: SessionMessage, timestamp: number): boolean {
  if (!message.optimistic || message.role !== 'user' || candidate.role !== 'user') return false
  if (message.content.trim() !== candidate.content.trim()) return false
  const messageTimestamp = typeof message.timestamp === 'number' ? message.timestamp : 0
  return Math.abs(messageTimestamp - timestamp) <= OPTIMISTIC_USER_MATCH_WINDOW_MS
}

function getStreamScopeKey(event: SessionStreamEvent): string {
  return event.scope.scopeKey
}

function clearStreamStateByMessageId(
  previewStates: Record<string, StreamPreviewState>,
  displayStates: Record<string, StreamDisplayState>,
  messageId?: string | null,
): { previewStates: Record<string, StreamPreviewState>; displayStates: Record<string, StreamDisplayState> } {
  if (!messageId) return { previewStates, displayStates }
  const nextPreview = { ...previewStates }
  const nextDisplay = { ...displayStates }
  for (const scopeKey of Object.keys(previewStates)) {
    if (previewStates[scopeKey]?.scope.messageId === messageId) {
      delete nextPreview[scopeKey]
      delete nextDisplay[scopeKey]
      break
    }
  }
  return { previewStates: nextPreview, displayStates: nextDisplay }
}

function clearStreamStateByParentToolUseIds(
  previewStates: Record<string, StreamPreviewState>,
  displayStates: Record<string, StreamDisplayState>,
  toolUseIds: string[],
): { previewStates: Record<string, StreamPreviewState>; displayStates: Record<string, StreamDisplayState> } {
  if (!toolUseIds.length) return { previewStates, displayStates }
  const nextPreview = { ...previewStates }
  const nextDisplay = { ...displayStates }
  for (const [scopeKey, state] of Object.entries(previewStates)) {
    if (state?.scope.parentToolUseId && toolUseIds.includes(state.scope.parentToolUseId)) {
      delete nextPreview[scopeKey]
      delete nextDisplay[scopeKey]
    }
  }
  return { previewStates: nextPreview, displayStates: nextDisplay }
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
      return 'streaming_progress'
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
  if (overlay.anchor.parentToolUseId) {
    return getDisplayItemToolUseIds(item).includes(overlay.anchor.parentToolUseId)
  }

  if (overlay.anchor.messageId) {
    return getTranscriptMessageId(item.anchorMessage) === overlay.anchor.messageId
  }

  return false
}

function getOverlayHostPriority(
  item: AssistantDisplayItem | GroupedToolUseDisplayItem | CollapsedToolBatchDisplayItem,
  overlay: TimelineLivePreviewItem,
): number {
  if (!shouldAttachOverlayToItem(item, overlay)) return -1
  if (overlay.anchor.parentToolUseId) {
    if (item.kind === 'grouped_tool_use') return 3
    if (item.kind === 'collapsed_tool_batch') return 2
    return 1
  }
  if (overlay.anchor.messageId) {
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
  const historyMessages = ref<HistoryMessage[]>([])
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
  const pendingInteraction = ref<PendingInteraction | null>(null)
  const eventLog = ref<Array<Extract<SessionEvent, { type: 'session.sdk.message' }>>>([])
  const streamPreviewStates = ref<Record<string, StreamPreviewState>>({})
  const streamDisplayStates = ref<Record<string, StreamDisplayState>>({})
  let streamAnimationFrame: number | null = null

  const isLoading = computed(() => ['queued', 'running', 'requires_action'].includes(runState.value))
  const hasAuthToken = computed(() => authToken.value.trim().length > 0)
  const isAwaitingApproval = computed(() => pendingInteraction.value?.kind === 'permission' && pendingInteraction.value?.status === 'pending')
  const isAwaitingInteraction = computed(() => pendingInteraction.value?.status === 'pending')
  const hasActiveRun = computed(() => awaitingRunStart || activeRunId.value !== null)
  const observabilityEvents = computed(() => eventLog.value.filter((event) => {
    if (getSdkMessageLayer(event.payload) !== 'debug-observability') return false
    return !(event.payload?.type === 'system' && event.payload?.subtype === 'init')
  }))
  const debugTimelineVisible = ref(false)
  const historyAtoms = computed<TranscriptAtom[]>(() =>
    historyMessages.value.map((message, index) => buildTranscriptAtom(message, {
      source: 'history',
      sourceIndex: index,
      timestamp: message.timestamp,
      optimistic: Boolean(message.optimistic),
      ...(message.localId ? { localId: message.localId } : {}),
    }))
  )
  const liveAtoms = computed<TranscriptAtom[]>(() =>
    eventLog.value
      .filter((event) => isBusinessSdkMessage(event.payload))
      .map((event, index) => {
        const message = getTimelineMessageFromEvent(event)
        if (!message) return null
        return buildTranscriptAtom(message, {
          source: 'live',
          sourceIndex: index,
          timestamp: typeof event.receivedAt === 'number' ? event.receivedAt : message.timestamp,
          sequence: event.sequence,
        })
      })
      .filter((atom): atom is TranscriptAtom => atom !== null && atom.semanticKind !== 'meta')
  )
  const defaultTimelineItems = computed<DisplayItem[]>(() =>
    buildDisplayItems([...historyAtoms.value, ...liveAtoms.value], {
      mode: 'default',
      includeHiddenAtoms: false,
    })
  )
  const attachedHiddenAtomIds = computed<Set<string>>(() => {
    const ids = new Set<string>()
    for (const item of defaultTimelineItems.value) {
      if (item.kind === 'assistant' && item.hiddenAtomIds?.length) {
        for (const atomId of item.hiddenAtomIds) ids.add(atomId)
      }
    }
    return ids
  })
  const hiddenTimelineItems = computed<TimelineRenderableItem[]>(() =>
    getHiddenAtomsForDebug([...historyAtoms.value, ...liveAtoms.value], {
      mode: 'default',
      includeHiddenAtoms: true,
    })
      .filter((atom) => !attachedHiddenAtomIds.value.has(atom.id))
      .filter((atom) => atom.semanticKind !== 'thinking' || Boolean(atom.assistant.stopReason))
      .map((atom) => ({
        kind: 'hidden_debug_atom' as const,
        id: `hidden-${atom.id}`,
        key: `hidden-${atom.id}`,
        timestamp: atom.order.timestamp,
        atomIds: [atom.id],
        atom,
        reason: atom.semanticKind === 'meta'
          ? 'meta'
          : atom.semanticKind === 'summary'
            ? 'summary'
            : 'redacted_thinking',
      }))
  )
  const livePreviewItems = computed<TimelineLivePreviewItem[]>(() =>
    Object.values(streamDisplayStates.value)
      .filter((preview) => preview.active && preview.blocks.length > 0)
      .slice()
      .sort((left, right) => {
        const leftTimestamp = streamPreviewStates.value[left.scope.scopeKey]?.receivedAt ?? 0
        const rightTimestamp = streamPreviewStates.value[right.scope.scopeKey]?.receivedAt ?? 0
        if (leftTimestamp !== rightTimestamp) return leftTimestamp - rightTimestamp
        const leftSequence = streamPreviewStates.value[left.scope.scopeKey]?.sequence ?? 0
        const rightSequence = streamPreviewStates.value[right.scope.scopeKey]?.sequence ?? 0
        return leftSequence - rightSequence
      })
      .map((preview) => ({
        kind: 'live_preview',
        layer: 'overlay',
        overlayKind: getLivePreviewOverlayKind(streamPreviewStates.value[preview.scope.scopeKey] || {
          scope: preview.scope,
          phase: preview.phase,
          active: preview.active,
          blocks: [],
        }),
        anchor: {
          scopeKey: preview.scope.scopeKey || 'unknown',
          ...(preview.scope.messageId ? { messageId: preview.scope.messageId } : {}),
          ...(preview.scope.parentToolUseId !== undefined ? { parentToolUseId: preview.scope.parentToolUseId } : {}),
        },
        id: `live-preview-${preview.scope.scopeKey || 'unknown'}`,
        key: `live-preview-${preview.scope.scopeKey || 'unknown'}`,
        timestamp: streamPreviewStates.value[preview.scope.scopeKey]?.receivedAt ?? Date.now(),
        preview,
      }))
  )
  const timeline = computed<TimelineRenderableItem[]>(() => {
    const visibleItems = defaultTimelineItems.value
    const debugOnlyHiddenItems = debugTimelineVisible.value ? hiddenTimelineItems.value : []
    const { items: itemsWithOverlays, unattachedOverlays } = attachOverlaysToDisplayItems(
      visibleItems,
      livePreviewItems.value,
    )

    return [...itemsWithOverlays, ...debugOnlyHiddenItems, ...unattachedOverlays]
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
    pendingInteraction.value = null
    streamPreviewStates.value = {}
    streamDisplayStates.value = {}
    if (streamAnimationFrame !== null) {
      window.clearTimeout(streamAnimationFrame)
      streamAnimationFrame = null
    }
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
      historyMessages.value = historyMessages.value.filter((message) => {
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
        const clearedByMessage = clearStreamStateByMessageId(
          streamPreviewStates.value,
          streamDisplayStates.value,
          getTranscriptMessageId(parsedMessage),
        )
        const toolUseIds = (parsedMessage.blocks || [])
          .flatMap((block) => block.type === 'tool_use' && typeof block.toolUseId === 'string' ? [block.toolUseId] : [])
        const clearedByTools = clearStreamStateByParentToolUseIds(
          clearedByMessage.previewStates,
          clearedByMessage.displayStates,
          toolUseIds,
        )
        streamPreviewStates.value = clearedByTools.previewStates
        streamDisplayStates.value = clearedByTools.displayStates
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
      const nextDisplayStates: Record<string, StreamDisplayState> = {}
      let changed = false
      for (const [scopeKey, preview] of Object.entries(streamPreviewStates.value)) {
        const currentDisplay = streamDisplayStates.value[scopeKey] ?? null
        const nextDisplay = advanceStreamDisplayState(currentDisplay, preview)
        nextDisplayStates[scopeKey] = nextDisplay
        if (JSON.stringify(currentDisplay) !== JSON.stringify(nextDisplay)) {
          changed = true
        }
      }
      if (changed) {
        streamDisplayStates.value = nextDisplayStates
        scheduleStreamDisplayAdvance()
      }
    }, 32)
  }

  function applyStreamEvent(
    previewStates: Record<string, StreamPreviewState>,
    displayStates: Record<string, StreamDisplayState>,
    event: Extract<SessionEvent, { type: 'session.sdk.stream_event' }>,
  ): { previewStates: Record<string, StreamPreviewState>; displayStates: Record<string, StreamDisplayState> } {
    syncSessionId(event.sessionId)
    const scopeKey = getStreamScopeKey(event.event)
    const clientReceivedAt = Date.now()
    const eventForPreview: SessionStreamEvent = {
      ...event.event,
      receivedAt: clientReceivedAt,
    }
    const currentPreview = previewStates[scopeKey] ?? null
    const nextPreview = reduceStreamPreviewEvent(currentPreview, eventForPreview)
    const nextPreviewStates = {
      ...previewStates,
      [scopeKey]: nextPreview,
    }
    const currentDisplay = displayStates[scopeKey] ?? null
    const nextDisplay = advanceStreamDisplayState(currentDisplay, nextPreview)
    const nextDisplayStates = {
      ...displayStates,
      [scopeKey]: nextDisplay,
    }
    if (!nextPreview.active) {
      const completedDisplay = createStreamDisplayState(nextPreview)
      nextDisplayStates[scopeKey] = completedDisplay
      window.setTimeout(() => {
        const previewSnapshot = { ...streamPreviewStates.value }
        const displaySnapshot = { ...streamDisplayStates.value }
        delete previewSnapshot[scopeKey]
        delete displaySnapshot[scopeKey]
        streamPreviewStates.value = previewSnapshot
        streamDisplayStates.value = displaySnapshot
      }, 120)
    } else {
      scheduleStreamDisplayAdvance()
    }
    return { previewStates: nextPreviewStates, displayStates: nextDisplayStates }
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
        } else if (event.state !== 'requires_action' && pendingInteraction.value?.status === 'pending') {
          pendingInteraction.value = null
        }
        break

      case 'session.run.completed':
        pendingInteraction.value = null
        streamPreviewStates.value = {}
        streamDisplayStates.value = {}
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
        historyMessages.value.push({
          role: 'system',
          content: `Error: ${event.error}`,
          timestamp: Date.now(),
        })
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
        const next = applyStreamEvent(streamPreviewStates.value, streamDisplayStates.value, event)
        streamPreviewStates.value = next.previewStates
        streamDisplayStates.value = next.displayStates
        break
      }

      case 'session.sdk.transport':
        applyTransportEvent(event)
        break

      case 'session.sdk.control.requested':
        pendingInteraction.value = event.interaction
        runState.value = 'requires_action'
        logger.info('chat:interaction:requested', {
          kind: event.interaction.kind,
          interactionId: shortId(event.interaction.id),
          sessionId: shortId(event.sessionId),
        })
        syncSessionId(event.sessionId)
        break

      case 'session.sdk.control.resolved':
        if (pendingInteraction.value?.id === event.interaction.id) {
          pendingInteraction.value = null
        }
        logger.info('chat:interaction:resolved', {
          kind: event.interaction.kind,
          interactionId: shortId(event.interaction.id),
          sessionId: shortId(event.sessionId),
        })
        syncSessionId(event.sessionId)
        break

      case 'session.error':
        historyMessages.value.push({
          role: 'system',
          content: `Error: ${event.error}`,
          timestamp: Date.now(),
        })
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
    pendingInteraction.value = null
    runState.value = 'queued'
    optimisticMessageCount += 1
    historyMessages.value = [
      ...historyMessages.value,
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

  function newChat() {
    logger.info('chat:new')
    currentSessionId.value = null
    historyMessages.value = []
    historyMessagesHasMore.value = false
    historyMessagesLoading.value = false
    historyMessagesLoadingOlder.value = false
    historyMessagesBeforeCursor.value = null
    eventLog.value = []
    streamPreviewStates.value = {}
    streamDisplayStates.value = {}
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
    historyMessagesHasMore.value = false
    historyMessagesLoading.value = false
    historyMessagesLoadingOlder.value = false
    historyMessagesBeforeCursor.value = null
    eventLog.value = []
    streamPreviewStates.value = {}
    streamDisplayStates.value = {}
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
        eventLog.value = eventLog.value.filter((event) => {
          if ('sessionId' in event && event.sessionId && event.sessionId !== id) return true
          if (event.type !== 'session.sdk.message') return false
          return !isBusinessSdkMessage(event.payload)
        })
        streamPreviewStates.value = {}
        streamDisplayStates.value = {}
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

  function respondToPermission(
    decision: 'approve' | 'deny',
    selectedSuggestion?: PermissionSuggestion | null,
    content?: Record<string, string | number | boolean | string[]>
  ) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !pendingInteraction.value || pendingInteraction.value.kind !== 'permission' || !activeRunId.value) {
      logger.warn('chat:permission:blocked', {
        hasSocket: Boolean(ws && ws.readyState === WebSocket.OPEN),
        interactionKind: pendingInteraction.value?.kind,
        activeRunId: shortId(activeRunId.value),
      })
      return
    }

    logger.info('chat:permission:respond', {
      decision,
      selectedAction: selectedSuggestion?.action,
      interactionId: shortId(pendingInteraction.value.id),
      runId: shortId(activeRunId.value),
    })
    ws.send(
      JSON.stringify({
        action: 'permission.respond',
        runId: activeRunId.value,
        permissionId: pendingInteraction.value.id,
        decision,
        ...(selectedSuggestion !== undefined ? { selectedSuggestion } : {}),
        ...(content ? { content } : {}),
      })
    )
  }

  function respondToElicitation(response: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !pendingInteraction.value || pendingInteraction.value.kind !== 'elicitation' || !activeRunId.value) {
      logger.warn('chat:elicitation:blocked', {
        hasSocket: Boolean(ws && ws.readyState === WebSocket.OPEN),
        interactionKind: pendingInteraction.value?.kind,
        activeRunId: shortId(activeRunId.value),
      })
      return
    }

    logger.info('chat:elicitation:respond', {
      action: response.action,
      interactionId: shortId(pendingInteraction.value.id),
      runId: shortId(activeRunId.value),
    })
    ws.send(
      JSON.stringify({
        action: 'elicitation.respond',
        runId: activeRunId.value,
        requestId: pendingInteraction.value.id,
        responseAction: response.action,
        ...(response.content ? { content: response.content } : {}),
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
    currentSessionId.value = null
    historyMessages.value = []
    historyMessagesHasMore.value = false
    historyMessagesLoading.value = false
    historyMessagesLoadingOlder.value = false
    historyMessagesBeforeCursor.value = null
    sessions.value = []
    eventLog.value = []
    streamPreviewStates.value = {}
    streamDisplayStates.value = {}
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
    historyAtoms,
    liveAtoms,
    streamPreviewStates,
    streamDisplayStates,
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
    observabilityEvents,
    eventLog,
    isAwaitingApproval,
    isAwaitingInteraction,
    connect,
    sendMessage,
    respondToPermission,
    respondToElicitation,
    fetchSessions,
    newChat,
    selectSession,
    loadOlderSessionMessages,
    initialize,
    setDebugTimelineVisible,
    setAuthToken,
    clearAuthToken,
  }
})
