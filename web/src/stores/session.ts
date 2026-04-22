import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  ControlTransactionSummary,
  LiveLaneKind,
  PendingInteraction,
  SessionEvent,
  SessionMessage,
  SessionRunState,
  SessionSummary,
  StreamAnimationCursor,
  StreamPreviewState,
  TranscriptAtom,
} from '../contract/runtime'
import {
  buildTranscriptAtom,
  classifySdkMessageLane,
  createStreamAnimationCursor,
  getTranscriptStopReason,
  getTranscriptResponseId,
} from '../contract/runtime'
import { apiFetch as baseApiFetch } from '../api/http'
import { fetchHealthRequest } from '../api/health'
import { fetchAgentsRequest } from '../api/agents'
import { createRunRequest } from '../api/runs'
import {
  cancelSessionInteractionRequest,
  fetchSessionsRequest,
  loadSessionMessagesRequest,
  rebuildSessionRequest,
  requestSessionControl,
  respondToSessionInteractionRequest,
  stopSessionRequest,
} from '../api/sessions'
import { buildSessionInteractionResponseInput, mapPendingInteraction } from '../domain/session/interactionVm'
import {
  advanceStreamAnimationFrame,
  appendEventLog,
  buildClearedRunState,
  decideRunClaim,
  finalizeStreamPreviewState,
  getAssistantMaterializeTargets,
  buildTimelineSdkMessageEvent,
  markStreamPreviewsMaterialized,
  reconcileOptimisticUserMessages,
  reduceStreamSdkEvent,
  reduceInteractiveTransaction,
  reduceRunLifecycleEvent,
  reduceSessionErrorEvent,
  reduceTransactionEvent,
  shouldIncludeSdkMessageInTimeline,
  sweepFinalizedStreamPreviews,
} from '../domain/session/reducer'
import type { TimelineInteractionResponse } from '../models/interaction'
import type { TimelineRenderableItemModel } from '../models/timeline'
import type {
  PendingInteractionModel,
  SessionEventModel,
  SessionMessageBlockModel,
  SessionMessageModel,
  SessionRunStateModel,
  SessionSummaryModel,
  TimelineItemModel,
} from '../models/session'
import {
  isWorkerOutputEvent,
  translateWorkerOutputEvent,
} from '../domain/session/liveWire'
import {
  createSessionSocketController,
} from '../domain/session/socket'
import {
  buildAtomTimelineItems,
  buildHistoryTimelineItems,
  buildLivePreviewItems,
} from '../domain/timeline/buildTimeline'
import { buildFourSegmentTimelineSections } from '../domain/timeline/fourSegment'
import { createDebugLogger } from '../lib/debug.js'

export type {
  TimelineItemModel as TimelineItem,
  PendingInteractionModel as PendingInteraction,
  SessionEventModel as SessionEvent,
  SessionMessageModel as SessionMessage,
  SessionMessageBlockModel as SessionMessageBlock,
  SessionRunStateModel as SessionRunState,
  SessionSummaryModel as SessionSummary,
  TimelineRenderableItemModel as TimelineRenderableItem,
  TranscriptAtom,
}
function generateUuid(): string {
  const cryptoApi = (globalThis as unknown as { crypto?: Crypto }).crypto
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID()
  return `uuid-${Date.now()}-${Math.random().toString(16).slice(2)}`
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
  const pendingRuntimeInteraction = computed<PendingInteraction | null>(() => activeInteractiveControl.value?.interaction ?? null)
  const pendingInteraction = computed(() => mapPendingInteraction(pendingRuntimeInteraction.value))
  const isAwaitingApproval = computed(() => pendingRuntimeInteraction.value?.kind === 'permission' && pendingRuntimeInteraction.value?.status === 'pending')
  const isAwaitingInteraction = computed(() => pendingRuntimeInteraction.value?.status === 'pending')
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
      if (preview.phase !== 'thinking' && preview.phase !== 'responding' && preview.phase !== 'tool-input') continue
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
  const liveAssistantTimelineItems = computed(() => {
    const combined = [...liveLaneEvents.value.user, ...liveLaneEvents.value.assistant]
      .slice()
      .sort((left, right) => left.sequence - right.sequence)
    return combined.flatMap((event, index) => {
      const message = getTimelineMessageFromEvent(event)
      if (!message) return []
      const responseId = getTranscriptResponseId(message)
      if (
        message.role === 'assistant'
        && responseId
        && liveAssistantResponseIdsCoveredByPreview.value.has(responseId)
        && getTranscriptStopReason(message) == null
      ) {
        return []
      }
      const atom = buildTranscriptAtom(message, {
        source: 'live',
        sourceIndex: index,
        timestamp: typeof event.receivedAt === 'number' ? event.receivedAt : message.timestamp,
        sequence: event.sequence,
      })
      if (atom.semanticKind === 'meta') return []
      return buildAtomTimelineItems([atom])
    })
  })
  const historyTimelineItems = computed(() => buildHistoryTimelineItems(historyMessages.value))
  const userTimelineItems = computed(() => buildAtomTimelineItems(userLaneAtoms.value))
  const livePreviewItems = computed(() =>
    buildLivePreviewItems(
      streamPreviewStates.value,
      streamAnimationCursors.value,
    )
  )
  const fourSegmentSections = computed(() =>
    buildFourSegmentTimelineSections({
      historyFromServerItems: historyTimelineItems.value,
      userTimelineItems: userTimelineItems.value,
      liveTimelineItems: liveAssistantTimelineItems.value,
      livePreviewItems: livePreviewItems.value,
      hasActiveRun: hasActiveRun.value,
    })
  )
  const historyFromServerItems = computed(() => fourSegmentSections.value.historyFromServerItems)
  const committedTurnsLocalItems = computed(() => fourSegmentSections.value.committedTurnsLocalItems)
  const currentTurnUserItems = computed(() => fourSegmentSections.value.currentTurnUserItems)
  const currentTurnAssistantItems = computed(() => fourSegmentSections.value.currentTurnAssistantItems)
  const timeline = computed<TimelineRenderableItemModel[]>(() => fourSegmentSections.value.timeline)

  let eventSequence = 0
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
    const next = buildClearedRunState(nextState)
    activeRunId.value = next.activeRunId
    awaitingRunStart = next.awaitingRunStart
    controlTransactionsById.value = next.controlTransactionsById
    activeControlOrder.value = next.activeControlOrder
    streamPreviewStates.value = next.streamPreviewStates
    streamAnimationCursors.value = next.streamAnimationCursors
    clearStreamTimers()
    runState.value = next.runState
  }

  function clearSessionNotice() {
    sessionNotice.value = ''
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
    const decision = decideRunClaim(
      { activeRunId: activeRunId.value, awaitingRunStart },
      event,
    )
    awaitingRunStart = decision.next.awaitingRunStart
    activeRunId.value = decision.next.activeRunId

    if (decision.log) {
      if (decision.log.level === 'info' && decision.log.kind === 'run-claimed') {
        logger.info('chat:run-claimed', { runId: shortId(decision.log.runId) })
      } else if (decision.log.level === 'warn' && decision.log.kind === 'ignored-unclaimed-run') {
        logger.warn('chat:event:ignored-unclaimed-run', {
          type: decision.log.eventType,
          runId: shortId(decision.log.runId),
        })
      }
    }

    return decision.accept
  }

  function applySdkMessage(event: Extract<SessionEvent, { type: 'session.sdk.message' }>) {
    const clientReceivedAt = Date.now()
    const parsedMessage = getTimelineMessageFromEvent(event)
    let timelineReceivedAt = clientReceivedAt

    if (parsedMessage?.role === 'user') {
      const reconciled = reconcileOptimisticUserMessages(
        optimisticUserMessages.value,
        parsedMessage,
        clientReceivedAt,
        OPTIMISTIC_USER_MATCH_WINDOW_MS,
      )
      optimisticUserMessages.value = reconciled.nextOptimistic
      if (reconciled.matchedTimestamp !== null) {
        timelineReceivedAt = reconciled.matchedTimestamp
      }
    }

    const timelineEvent: Extract<SessionEvent, { type: 'session.sdk.message' }> = {
      ...event,
      receivedAt: timelineReceivedAt,
      ...(parsedMessage ? { parsed: parsedMessage } : {}),
    }
    const shouldIncludeInMainline = shouldIncludeSdkMessageInTimeline(
      timelineEvent.payload,
      isErrorResultPayload,
    )

    if (!shouldIncludeInMainline) {
      syncSessionId(timelineEvent.sessionId)
      return
    }

    const nextTimelineEvent = buildTimelineSdkMessageEvent({
      event,
      receivedAt: timelineReceivedAt,
      parsed: parsedMessage,
    })
    eventLog.value = appendEventLog(eventLog.value, nextTimelineEvent)
    const targets = getAssistantMaterializeTargets(parsedMessage, getTranscriptResponseId)
    if (targets) {
      const materialized = markStreamPreviewsMaterialized(
        streamPreviewStates.value,
        streamAnimationCursors.value,
        targets.responseId,
        targets.toolUseIds,
      )
      streamPreviewStates.value = materialized.previewStates
      streamAnimationCursors.value = materialized.animationCursors
      scheduleFinalizedPreviewSweep()
    }
    syncSessionId(nextTimelineEvent.sessionId)
    if (eventLog.value.length === 1 || eventLog.value.length % EVENT_LOG_INTERVAL === 0) {
      logger.debug('chat:sdk-message', {
        count: eventLog.value.length,
        payloadType: nextTimelineEvent.payload?.type,
        sequence: nextTimelineEvent.sequence,
        sessionId: shortId(nextTimelineEvent.sessionId),
      })
    }
  }

  function applyInteractiveTransaction(transaction: ControlTransactionSummary) {
    const next = reduceInteractiveTransaction({
      controlTransactionsById: controlTransactionsById.value,
      activeControlOrder: activeControlOrder.value,
      runState: runState.value,
    }, transaction)
    controlTransactionsById.value = next.controlTransactionsById
    activeControlOrder.value = next.activeControlOrder
    runState.value = next.runState
  }

  function scheduleStreamDisplayAdvance() {
    if (streamAnimationFrame !== null) return
    streamAnimationFrame = window.setTimeout(() => {
      streamAnimationFrame = null
      const next = advanceStreamAnimationFrame(streamPreviewStates.value, streamAnimationCursors.value)
      if (next.changed) {
        streamAnimationCursors.value = next.animationCursors
      }
      if (next.shouldContinue) {
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
    const next = reduceStreamSdkEvent(previewStates, animationCursors, event)
    if (next.mode === 'inactive_finalized') {
      scheduleFinalizedPreviewSweep(0)
      return { previewStates: next.previewStates, animationCursors: next.animationCursors }
    }

    if (next.mode === 'inactive_pending') {
      scheduleStreamFinalize(next.scopeKey)
      return { previewStates: next.previewStates, animationCursors: next.animationCursors }
    }

    const existingFinalizeTimer = streamFinalizeTimers[next.scopeKey]
    if (existingFinalizeTimer !== undefined) {
      window.clearTimeout(existingFinalizeTimer)
      const { [next.scopeKey]: _removedTimer, ...restTimers } = streamFinalizeTimers
      streamFinalizeTimers = restTimers
    }
    scheduleStreamDisplayAdvance()
    return { previewStates: next.previewStates, animationCursors: next.animationCursors }
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

    const tx = reduceTransactionEvent({
      controlTransactionsById: controlTransactionsById.value,
      activeControlOrder: activeControlOrder.value,
      runState: runState.value,
    }, event)
    if (tx) {
      controlTransactionsById.value = tx.controlTransactionsById
      activeControlOrder.value = tx.activeControlOrder
      runState.value = tx.runState
      syncSessionId(tx.sessionId)
      return
    }

    const runLifecycle = reduceRunLifecycleEvent(event)
    if (runLifecycle) {
      if (runLifecycle.sessionNotice !== undefined) {
        sessionNotice.value = runLifecycle.sessionNotice
      }
      if (runLifecycle.clearRunState) {
        clearRunState(runLifecycle.clearRunState)
      } else if (runLifecycle.runState) {
        runState.value = runLifecycle.runState
      }
      if ('sessionId' in event) {
        syncSessionId(event.sessionId)
      }
      if (event.type === 'session.run.completed') {
        logger.info('chat:done', {
          runId: shortId(event.runId),
          sessionId: shortId(event.sessionId),
          exitCode: event.exitCode,
          hasError: Boolean(event.error),
        })
      } else if (event.type === 'session.run.failed') {
        logger.error('chat:error', {
          runId: shortId(event.runId),
          sessionId: shortId(event.sessionId),
          error: event.error,
        })
      } else if (event.type === 'session.run.cancelled') {
        logger.warn('chat:cancelled', {
          runId: shortId(event.runId),
          sessionId: shortId(event.sessionId),
        })
      }
      return
    }

    const sessionError = reduceSessionErrorEvent(event)
    if (sessionError) {
      // Preserve existing logging behavior; reducer only provides the message.
      logger.error('chat:error', {
        runId: shortId((event as any).runId),
        error: sessionError.sessionNotice,
      })
      if (sessionError.sessionNotice) {
        sessionNotice.value = sessionError.sessionNotice
      }
      return
    }

    switch (event.type) {
      case 'session.sdk.message':
        applySdkMessage(event)
        break

      case 'session.sdk.stream_event': {
        const next = applyStreamEvent(streamPreviewStates.value, streamAnimationCursors.value, event)
        streamPreviewStates.value = next.previewStates
        streamAnimationCursors.value = next.animationCursors
        break
      }

    }
  }

  async function checkHealth() {
    logger.info('health:request')
    try {
      const result = await fetchHealthRequest((input, init) => fetch(input, init))
      authRequired.value = Boolean(result.data.authEnabled)
      logger.info('health:success', {
        status: result.data.status,
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
        const result = await fetchAgentsRequest(apiFetch)
        if (!result.ok) {
          agentIdCache = stored ?? 'local-dev'
          return agentIdCache
        }
        const agents = result.data.agents
        const agentIds = agents
          .map((agent) => (typeof agent?.agentId === 'string' ? agent.agentId.trim() : ''))
          .filter((id) => Boolean(id))

        const defaultFromServer = typeof result.data.defaultAgentId === 'string' ? result.data.defaultAgentId.trim() : ''
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

  async function apiFetch(input: string, init: RequestInit = {}) {
    return await baseApiFetch(input, init, {
      authToken: authToken.value,
      onRequest: (requestInput, requestInit) => {
        logger.debug('http:request', {
          input: requestInput,
          method: requestInit.method || 'GET',
          hasAuthToken: hasAuthToken.value,
        })
      },
      onUnauthorized: () => {
        authError.value = '认证失败，请重新输入访问令牌。'
        isConnected.value = false
        logger.warn('auth:401', {
          input,
          method: init.method || 'GET',
        })
      },
    })
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
    const kind = wire.kind

    // Keep UI sessionId in sync even if we drop the event.
    syncSessionId(sessionId)

    if (runId && terminalRunIds.has(runId) && kind === 'session_state_changed' && wire.state === 'idle') {
      // Avoid overriding "completed/failed" with "idle" after terminal result.
      return
    }

    const sequence = ++eventSequence
    const translation = translateWorkerOutputEvent({
      wire,
      sequence,
      activeStreamMessageIds,
    })

    if (translation.terminalRunId) {
      terminalRunIds.add(translation.terminalRunId)
    }

    if (translation.events.length === 0 && kind === 'control_transaction' && wire.transaction) {
      const targetSessionId = wire.transaction.sessionId ?? sessionId
      applyInteractiveTransaction(wire.transaction)
      syncSessionId(targetSessionId)
      return
    }

    for (const event of translation.events) {
      applyEvent(event)
    }

    if (translation.footerPatch) {
      patchLastAssistantMessageFooterFromResult(translation.footerPatch)
    }

    // worker_closed: currently ignored by the main chat UI.
  }

  const socketController = createSessionSocketController({
    getSessionId: () => currentSessionId.value,
    getAuthToken: () => authToken.value,
    getHasAuthToken: () => hasAuthToken.value,
    getAuthRequired: () => authRequired.value,
    onBlocked: () => {
      authError.value = '请输入访问令牌。'
      logger.warn('ws:connect:blocked', {
        authRequired: authRequired.value,
        hasAuthToken: hasAuthToken.value,
      })
    },
    onConnectStart: (wsUrl, sessionId) => {
      authError.value = ''
      eventSequence = 0
      logger.info('ws:connect:start', {
        url: redactUrl(wsUrl),
        hasAuthToken: hasAuthToken.value,
        authRequired: authRequired.value,
        sessionId: shortId(sessionId),
      })
    },
    onOpen: (sessionId) => {
      isConnected.value = true
      authError.value = ''
      logger.info('ws:open', { sessionId: shortId(sessionId) })
    },
    onClose: (event) => {
      isConnected.value = false
      logger.warn('ws:close', {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      })
    },
    onError: () => {
      isConnected.value = false
      logger.warn('ws:error', {
        authRequired: authRequired.value,
        hasAuthToken: hasAuthToken.value,
      })
      if (authRequired.value && hasAuthToken.value) {
        authError.value = '连接失败，请检查访问令牌是否正确。'
      }
    },
    onRawMessage: (raw) => {
      try {
        const parsed = JSON.parse(raw)
        applyWireEvent(parsed)
      } catch (error) {
        logger.warn('ws:message:parse-error', {
          error: error instanceof Error ? error.message : String(error),
          raw: raw.slice(0, 160),
        })
      }
    },
    onBeforeDisconnect: (readyState) => {
      logger.info('ws:clear-connection', { readyState })
      isConnected.value = false
    },
    onReconnectScheduled: (delayMs) => {
      logger.info('ws:reconnect:scheduled', { delayMs })
    },
    shouldReconnect: () => !authError.value && (!authRequired.value || hasAuthToken.value),
    reconnectDelayMs: 3000,
  })

  function connect() {
    socketController.connect()
    void ensureAgentId()
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
    if (!socketController.isOpenForSession(sessionId)) {
      connect()
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
      const result = await createRunRequest(apiFetch, {
        sessionId,
        agentId,
        text: trimmed,
        mode,
      })
      if (!result.ok) {
        const message = result.error || `HTTP ${result.status}`
        if (result.status === 409 && result.error === 'session_busy') {
          const activeRun = result.data.activeRunId ? shortId(result.data.activeRunId) : undefined
          const status = result.data.sessionStatus || 'running'
          sessionNotice.value = activeRun
            ? `当前 Session 正忙（${status}，run ${activeRun}），请先等待，或执行中断 / 重建。`
            : `当前 Session 正忙（${status}），请先等待，或执行中断 / 重建。`
        } else {
          sessionNotice.value = message
        }
        applyEvent({ type: 'session.run.failed', sessionId, error: message })
        return
      }

      const runId = result.data.runId
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
      const result = await fetchSessionsRequest(apiFetch)
      if (!result.ok) {
        logger.warn('sessions:fetch:error', { status: result.status })
        return false
      }
      sessions.value = result.data.sessions.map((s: any) => normalizeSession(s)).filter((s: SessionSummary) => s.id)
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
      const result = await stopSessionRequest(apiFetch, trimmed)
      if (!result.ok) {
        logger.warn('session:stop:error', {
          sessionId: shortId(trimmed),
          status: result.status,
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
      const result = await rebuildSessionRequest(apiFetch, trimmed)
      if (!result.ok) {
        logger.warn('session:rebuild:error', {
          sessionId: shortId(trimmed),
          status: result.status,
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
      const result = await loadSessionMessagesRequest(apiFetch, id, {
        limit: DEFAULT_HISTORY_PAGE_SIZE,
        before: options.before,
      })
      if (!result.ok) {
        logger.warn('messages:load:error', {
          sessionId: shortId(id),
          status: result.status,
          reset: Boolean(options.reset),
          prepend: Boolean(options.prepend),
        })
        return false
      }
      const messages = result.data.messages
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
      historyMessagesHasMore.value = result.data.hasMore
      historyMessagesBeforeCursor.value = result.data.nextBefore
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
    const sessionId = currentSessionId.value
    if (!sessionId) {
      logger.warn('chat:control:blocked', {
        subtype,
        activeRunId: shortId(activeRunId.value),
        sessionId: shortId(currentSessionId.value),
      })
      return
    }

    logger.info('chat:control-request', {
      subtype,
      sessionId: shortId(sessionId),
    })
    clearSessionNotice()
    void requestSessionControl(apiFetch, sessionId, subtype).then((result) => {
      if (result.ok) return
      const error = result.error || `HTTP ${result.status}`
      sessionNotice.value = error
      logger.warn('chat:control-request:error', {
        subtype,
        sessionId: shortId(sessionId),
        error,
      })
    }).catch((error) => {
      sessionNotice.value = error instanceof Error ? error.message : String(error)
      logger.warn('chat:control-request:error', {
        subtype,
        sessionId: shortId(sessionId),
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  function respondToInteraction(response: TimelineInteractionResponse) {
    if (!currentSessionId.value || !pendingRuntimeInteraction.value) {
      logger.warn('chat:interactive:blocked', {
        kind: response.kind,
        sessionId: shortId(currentSessionId.value),
        interactionId: shortId(pendingRuntimeInteraction.value?.id),
      })
      return
    }

    logger.info('chat:interactive:respond', {
      kind: response.kind,
      interactionId: shortId(pendingRuntimeInteraction.value.id),
      sessionId: shortId(currentSessionId.value),
    })
    clearSessionNotice()

    const request = buildSessionInteractionResponseInput(response, pendingRuntimeInteraction.value)

    void respondToSessionInteractionRequest(apiFetch, currentSessionId.value, request).then((result) => {
      if (result.ok) return
      const error = result.error || `HTTP ${result.status}`
      sessionNotice.value = error
      logger.warn('chat:interactive:respond:error', {
        kind: response.kind,
        sessionId: shortId(currentSessionId.value),
        interactionId: shortId(pendingRuntimeInteraction.value?.id),
        error,
      })
    }).catch((error) => {
      sessionNotice.value = error instanceof Error ? error.message : String(error)
      logger.warn('chat:interactive:respond:error', {
        kind: response.kind,
        sessionId: shortId(currentSessionId.value),
        interactionId: shortId(pendingRuntimeInteraction.value?.id),
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  function cancelPendingInteraction() {
    if (!currentSessionId.value || !pendingRuntimeInteraction.value) {
      logger.warn('chat:interactive:cancel:blocked', {
        sessionId: shortId(currentSessionId.value),
        interactionId: shortId(pendingRuntimeInteraction.value?.id),
      })
      return
    }

    logger.info('chat:interactive:cancel', {
      sessionId: shortId(currentSessionId.value),
      interactionId: shortId(pendingRuntimeInteraction.value.id),
    })
    clearSessionNotice()
    void cancelSessionInteractionRequest(
      apiFetch,
      currentSessionId.value,
      pendingRuntimeInteraction.value.id,
    ).then((result) => {
      if (result.ok) return
      const error = result.error || `HTTP ${result.status}`
      sessionNotice.value = error
      logger.warn('chat:interactive:cancel:error', {
        sessionId: shortId(currentSessionId.value),
        interactionId: shortId(pendingRuntimeInteraction.value?.id),
        error,
      })
    }).catch((error) => {
      sessionNotice.value = error instanceof Error ? error.message : String(error)
      logger.warn('chat:interactive:cancel:error', {
        sessionId: shortId(currentSessionId.value),
        interactionId: shortId(pendingRuntimeInteraction.value?.id),
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
    socketController.disconnect()
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
    historyFromServerItems,
    historyTimelineItems,
    committedTurnsLocalItems,
    currentTurnUserItems,
    currentTurnAssistantItems,
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
