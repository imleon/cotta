import type {
  ControlTransactionSummary,
  SessionEvent,
  SessionMessage,
  SessionRunState,
  StreamAnimationCursor,
  StreamPreviewState,
} from '../../contract/runtime'
import {
  advanceStreamAnimationCursor,
  createStreamAnimationCursor,
  reduceStreamPreviewEvent,
} from '../../contract/runtime'

export type SdkMessageEvent = Extract<SessionEvent, { type: 'session.sdk.message' }>

export function reduceRunLifecycleEvent(event: SessionEvent): {
  runState?: SessionRunState
  clearRunState?: SessionRunState
  sessionNotice?: string
} | null {
  switch (event.type) {
    case 'session.run.queued':
      return { runState: 'queued' }
    case 'session.run.started':
      return { runState: 'running' }
    case 'session.run.state_changed':
      if (event.state === 'cancelled') {
        return { clearRunState: 'cancelled' }
      }
      return { runState: event.state }
    case 'session.run.completed': {
      // Legacy runner can report completion with non-zero exit code. Treat it as failed.
      const hasFailure = Boolean(event.error)
        || (typeof event.exitCode === 'number' && event.exitCode !== 0)
      return { clearRunState: hasFailure ? 'failed' : 'completed' }
    }
    case 'session.run.failed':
      return { clearRunState: 'failed', sessionNotice: event.error }
    case 'session.run.cancelled':
      return { clearRunState: 'cancelled' }
    default:
      return null
  }
}

export function reduceInteractiveTransaction(
  prev: {
    controlTransactionsById: Record<string, ControlTransactionSummary>
    activeControlOrder: string[]
    runState: SessionRunState
  },
  transaction: ControlTransactionSummary,
): {
  controlTransactionsById: Record<string, ControlTransactionSummary>
  activeControlOrder: string[]
  runState: SessionRunState
} {
  const controlTransactionsById = {
    ...prev.controlTransactionsById,
    [transaction.requestId]: transaction,
  }

  const existing = new Set(prev.activeControlOrder)
  const activeControlOrder = existing.has(transaction.requestId)
    ? prev.activeControlOrder
    : [...prev.activeControlOrder, transaction.requestId]

  const runState = transaction.status === 'awaiting_user'
    ? 'requires_action'
    : prev.runState

  return {
    controlTransactionsById,
    activeControlOrder,
    runState,
  }
}

export function reduceTransactionEvent(
  prev: {
    controlTransactionsById: Record<string, ControlTransactionSummary>
    activeControlOrder: string[]
    runState: SessionRunState
  },
  event: SessionEvent,
): ({
  controlTransactionsById: Record<string, ControlTransactionSummary>
  activeControlOrder: string[]
  runState: SessionRunState
  sessionId?: string
} | null) {
  switch (event.type) {
    case 'session.interactive.opened':
    case 'session.interactive.awaiting_user':
    case 'session.interactive.responded':
    case 'session.interactive.completed':
    case 'session.interactive.cancelled':
    case 'session.interactive.failed':
    case 'session.control.opened':
    case 'session.control.awaiting_user':
    case 'session.control.responded':
    case 'session.control.completed':
    case 'session.control.cancel_requested':
    case 'session.control.cancelled':
    case 'session.control.failed': {
      const next = reduceInteractiveTransaction(prev, event.transaction)
      return {
        ...next,
        ...('sessionId' in event ? { sessionId: event.sessionId } : {}),
      }
    }
    default:
      return null
  }
}

export function reduceSessionErrorEvent(event: SessionEvent): { sessionNotice?: string } | null {
  switch (event.type) {
    case 'session.error':
      // Keep this minimal: store decides whether to surface it; reducer provides the message.
      return { sessionNotice: event.error }
    default:
      return null
  }
}

export function shouldIncludeSdkMessageInTimeline(
  payload: SdkMessageEvent['payload'],
  isErrorResultPayload: (payload: SdkMessageEvent['payload']) => boolean,
): boolean {
  const messageType = payload?.type
  return messageType === 'assistant' || messageType === 'user' || isErrorResultPayload(payload)
}

export function buildTimelineSdkMessageEvent(input: {
  event: SdkMessageEvent
  receivedAt: number
  parsed: SdkMessageEvent['parsed'] | null
}): SdkMessageEvent {
  return {
    ...input.event,
    receivedAt: input.receivedAt,
    ...(input.parsed ? { parsed: input.parsed } : {}),
  }
}

export function appendEventLog(prev: SdkMessageEvent[], next: SdkMessageEvent, max = 200): SdkMessageEvent[] {
  // Keep the last (max - 1) and append.
  const keep = Math.max(0, max - 1)
  return [...prev.slice(-keep), next]
}

export function isMatchingOptimisticUserMessage(
  message: Pick<SessionMessage, 'role' | 'content' | 'timestamp'>,
  candidate: Pick<SessionMessage, 'role' | 'content'>,
  timestamp: number,
  windowMs: number,
): boolean {
  if (message.role !== 'user' || candidate.role !== 'user') return false
  if (message.content.trim() !== candidate.content.trim()) return false
  const messageTimestamp = typeof message.timestamp === 'number' ? message.timestamp : 0
  return Math.abs(messageTimestamp - timestamp) <= windowMs
}

export function reconcileOptimisticUserMessages<T extends Pick<SessionMessage, 'role' | 'content' | 'timestamp'>>(
  optimistic: T[],
  candidate: Pick<SessionMessage, 'role' | 'content'> | null,
  timestamp: number,
  windowMs: number,
): { nextOptimistic: T[]; matchedTimestamp: number | null } {
  if (!candidate || candidate.role !== 'user') {
    return { nextOptimistic: optimistic, matchedTimestamp: null }
  }

  let matchedOptimisticTimestamp: number | null = null
  let removedOptimistic = false
  const nextOptimistic = optimistic.filter((message) => {
    if (removedOptimistic) return true
    if (!isMatchingOptimisticUserMessage(message, candidate, timestamp, windowMs)) return true
    removedOptimistic = true
    matchedOptimisticTimestamp = typeof message.timestamp === 'number' ? message.timestamp : null
    return false
  })

  return {
    nextOptimistic,
    matchedTimestamp: matchedOptimisticTimestamp,
  }
}

export function getAssistantMaterializeTargets(
  message: SessionMessage | null,
  getTranscriptResponseId: (message: SessionMessage) => string | null,
): { responseId: string | null; toolUseIds: Set<string> } | null {
  if (!message || message.role !== 'assistant') return null
  const toolUseIds = (message.blocks || [])
    .flatMap((block) => block.type === 'tool_use' && typeof block.toolUseId === 'string' ? [block.toolUseId] : [])
  return {
    responseId: getTranscriptResponseId(message),
    toolUseIds: new Set(toolUseIds),
  }
}

export function finalizeStreamPreviewState(preview: StreamPreviewState): StreamPreviewState {
  return {
    ...preview,
    status: 'finalized',
    active: false,
  }
}

export function markStreamPreviewsMaterialized(
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

export function sweepFinalizedStreamPreviews(
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

export type StreamReducerMode = 'active' | 'inactive_pending' | 'inactive_finalized'

export function reduceStreamSdkEvent(
  previewStates: Record<string, StreamPreviewState>,
  animationCursors: Record<string, StreamAnimationCursor>,
  event: Extract<SessionEvent, { type: 'session.sdk.stream_event' }>,
): {
  previewStates: Record<string, StreamPreviewState>
  animationCursors: Record<string, StreamAnimationCursor>
  scopeKey: string
  mode: StreamReducerMode
} {
  const scopeKey = event.event.scope.scopeKey
  const currentPreview = previewStates[scopeKey] ?? null
  const nextPreview = reduceStreamPreviewEvent(currentPreview, event.event)
  const nextPreviewStates = {
    ...previewStates,
    [scopeKey]: nextPreview,
  }

  const currentCursor = animationCursors[scopeKey] ?? null
  const { cursor: nextCursor } = advanceStreamAnimationCursor(currentCursor, nextPreview)
  const nextAnimationCursors: Record<string, StreamAnimationCursor> = {
    ...animationCursors,
    [scopeKey]: nextCursor,
  }

  if (!nextPreview.active) {
    nextAnimationCursors[scopeKey] = createStreamAnimationCursor(nextPreview)
    if (nextPreview.status === 'finalized') {
      const swept = sweepFinalizedStreamPreviews(nextPreviewStates, nextAnimationCursors)
      return {
        previewStates: swept.previewStates,
        animationCursors: swept.animationCursors,
        scopeKey,
        mode: 'inactive_finalized',
      }
    }
    return { previewStates: nextPreviewStates, animationCursors: nextAnimationCursors, scopeKey, mode: 'inactive_pending' }
  }

  return { previewStates: nextPreviewStates, animationCursors: nextAnimationCursors, scopeKey, mode: 'active' }
}

export function advanceStreamAnimationFrame(
  previewStates: Record<string, StreamPreviewState>,
  animationCursors: Record<string, StreamAnimationCursor>,
): {
  animationCursors: Record<string, StreamAnimationCursor>
  shouldContinue: boolean
  changed: boolean
} {
  const nextAnimationCursors: Record<string, StreamAnimationCursor> = {}
  let shouldContinue = false
  let changed = false

  for (const [scopeKey, preview] of Object.entries(previewStates)) {
    const currentCursor = animationCursors[scopeKey] ?? null
    const { cursor, changed: cursorChanged, done } = advanceStreamAnimationCursor(currentCursor, preview)
    nextAnimationCursors[scopeKey] = cursor
    changed = changed || cursorChanged || currentCursor === null
    shouldContinue = shouldContinue || (preview.active && !done)
  }

  return {
    animationCursors: nextAnimationCursors,
    shouldContinue,
    changed,
  }
}

export type RunClaimState = {
  activeRunId: string | null
  awaitingRunStart: boolean
}

export type RunClaimDecision = {
  accept: boolean
  next: RunClaimState
  log?: { level: 'info' | 'warn'; kind: 'run-claimed' | 'ignored-unclaimed-run'; runId: string; eventType: string }
}

export function getEventRunId(event: SessionEvent): string | null {
  return 'runId' in event && typeof event.runId === 'string' ? event.runId : null
}

export function isRunScopedEvent(event: SessionEvent): boolean {
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
      return typeof (event as any).runId === 'string'
    case 'session.error':
      return typeof (event as any).runId === 'string'
    default:
      return true
  }
}

export function decideRunClaim(prev: RunClaimState, event: SessionEvent): RunClaimDecision {
  if (!isRunScopedEvent(event)) {
    return { accept: true, next: prev }
  }

  const eventRunId = getEventRunId(event)
  if (!eventRunId) {
    return { accept: prev.activeRunId === null, next: prev }
  }

  if (prev.activeRunId) {
    return { accept: prev.activeRunId === eventRunId, next: prev }
  }

  if (prev.awaitingRunStart) {
    return {
      accept: true,
      next: { activeRunId: eventRunId, awaitingRunStart: false },
      log: { level: 'info', kind: 'run-claimed', runId: eventRunId, eventType: event.type },
    }
  }

  return {
    accept: false,
    next: prev,
    log: { level: 'warn', kind: 'ignored-unclaimed-run', runId: eventRunId, eventType: event.type },
  }
}

export type ClearedRunState = {
  activeRunId: string | null
  awaitingRunStart: boolean
  controlTransactionsById: Record<string, ControlTransactionSummary>
  activeControlOrder: string[]
  streamPreviewStates: Record<string, StreamPreviewState>
  streamAnimationCursors: Record<string, StreamAnimationCursor>
  runState: SessionRunState
}

export function buildClearedRunState(nextState: SessionRunState = 'idle'): ClearedRunState {
  return {
    activeRunId: null,
    awaitingRunStart: false,
    controlTransactionsById: {},
    activeControlOrder: [],
    streamPreviewStates: {},
    streamAnimationCursors: {},
    runState: nextState,
  }
}
