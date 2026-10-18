import {
  type AskUserQuestionDecisionRequest,
  type LiveBackgroundTask,
  type RawSessionTask,
  type SessionTimelineControlResponse,
  type SessionTimelineResponse,
  type ToolApprovalRequest,
  type TurnSubagentsTreeResponse,
  type TurnSubagentTranscriptResponse,
  type TurnSummary,
  timelineLocalCommandFeedback,
} from '@cotta/shared'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { createShare, fetchSessionRawMessages, fetchSessionTimeline, fetchSessionTimelineControl, fetchTurnSubagentsTree, fetchTurnSubagentTranscript, TimelineSnapshotStaleError } from '../api'
import { sessionQueryKeys } from '../app/session-query-refresh'
import {
  AssistantResponseFrameView,
  CliStaticSparkIcon,
  FooterStatus,
  LocalCommandRow,
  PrimaryInputView,
  RawMessagesDialog,
  SubagentsDialog,
  TimelineRenderItemView,
  type ToastNotification,
} from './renderers'

export { CliStaticSparkIcon }

import { timelineMessageClass } from './content'
import {
  appendMessageToTurn,
  applySdkMessage,
  assistantFrameSource,
  assistantResponseFrameHasVisibleContent,
  belongsToTimelineSession,
  clearOptimisticOverlaySources,
  coalesceTranscriptSignal,
  effectiveActiveTurnId,
  groupAssistantResponseFrames,
  groupTimelineBlocks,
  hasTerminalEvidence,
  isPrimaryInputBlock,
  isPrimaryUserMessage,
  isRecord,
  isTerminalLiveEvent,
  localCommandRoot,
  localCommandRootForSubmission,
  materializeTimelineTurns,
  messageIdentity,
  messageIsRepresentedBy,
  type OverlayMessageSource,
  type ProjectedTimelineTurn,
  prependOlderTimelineTurns,
  primaryMessageSource,
  projectTimelineTurn,
  reconcileTimelineTurns,
  replaceTimelineTail,
  resolvePendingSubmission,
  resultFailureMessage,
  type SessionTimelineScope,
  sdkMessageUuid,
  shouldHoldResponseSkeleton,
  shouldResetSessionTimeline,
  shouldShowResponseSkeleton,
  type TimelineControlSignal,
  type TimelineTurnIndex,
  type TranscriptSignal,
  type TurnFooterState,
  type TurnPhase,
  timelineBlockHasTranscriptEvidence,
  timelineRenderItemBlocks,
  timelineRenderItemKey,
  timelineTurnIndex,
  turnActiveTaskLabel,
  turnCookingLabel,
  turnFooterState,
  turnPhase,
} from './core'
import { AskUserQuestionToolContent } from './tools'

export type ProvisionalSlashSubmission = { submissionUuid: string; localKey: string; text: string; timestamp: number; phase: TurnPhase }

export type {
  OverlayMessageSource,
  PrimaryMessageSource,
  ResponseSource,
  SessionTimelineScope,
  SubmitState,
  TimelineControlSignal,
  TimelineRenderItem,
  TimelineTurnIndex,
  TranscriptSignal,
  TurnFooterState,
  TurnPhase,
} from './core'
export {
  activityGroupSummary,
  applySdkMessage,
  assistantFrameSource,
  assistantResponseFrameForkMessageId,
  assistantResponseFrameHasVisibleContent,
  assistantResponseText,
  authoritativeTurnPhase,
  belongsToTimelineSession,
  COOKING_VERBS,
  canForkAssistantResponse,
  clearOptimisticOverlaySources,
  coalesceTranscriptSignal,
  groupAssistantResponseFrames,
  groupTimelineBlocks,
  isPrimaryUserMessage,
  materializeTimelineTurns,
  primaryMessageSource,
  projectTimelineTurn,
  rawMessageTimestampMs,
  reconcileTimelineTurns,
  replaceTimelineTail,
  shouldHoldResponseSkeleton,
  shouldResetSessionTimeline,
  shouldShowResponseSkeleton,
  submitStateFor,
  thinkingBlockTitle,
  timelineTurnIndex,
  turnCookingLabel,
  turnDurationLabel,
  turnFooterState,
  turnPendingAgentLabel,
  turnPhase,
} from './core'

/** Creates (or reuses) a share for a turn and opens it in a new tab; opens the tab synchronously to dodge popup blockers. */
async function openShareInNewTab(projectId: string, sessionId: string, turnId: string, onNotify?: (toast: ToastNotification) => void): Promise<void> {
  const tab = window.open('about:blank', '_blank')
  try {
    const { token } = await createShare({ projectId, sessionId, turnId })
    const url = `${window.location.origin}/share/${token}`
    if (tab) tab.location.href = url
    else window.open(url, '_blank')
  } catch (error) {
    tab?.close()
    onNotify?.({ message: error instanceof Error ? error.message : 'Share failed', tone: 'error' })
  }
}

function useSessionTimelineData(
  projectId: string | null,
  sessionId: string | null,
  historyEnabled: boolean,
  transcriptSignal: TranscriptSignal | null | undefined,
  timelineControlSignal: TimelineControlSignal | null | undefined,
  searchAnchorTurnId: string | null | undefined,
  pendingTurn: TurnSummary | null | undefined,
  provisionalSlash: ProvisionalSlashSubmission | null | undefined,
  onLiveTurnChange: ((sessionId: string, userMessageUuid: string | null) => void) | undefined,
  onPendingTurnReconciled: ((sessionId: string, userMessageUuid: string) => void) | undefined,
  onSessionListStale: (() => void) | undefined,
  onTurnOptionsChange: ((meta: SessionTimelineResponse['turnOptions']) => void) | undefined,
  onContextUsageChange: ((contextUsage: SessionTimelineResponse['contextUsage']) => void) | undefined,
  onActivityChange: ((activity: SessionTimelineResponse['activity']) => void) | undefined,
  onTasksChange: ((tasks: SessionTimelineResponse['tasks']) => void) | undefined,
  onSearchAnchorStale: (() => void) | undefined,
  isTimelineAtBottom: () => boolean,
) {
  const [turns, setTurns] = useState<TurnSummary[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [hasNewer, setHasNewer] = useState(false)
  const [olderError, setOlderError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [liveConnectionError, setLiveConnectionError] = useState<string | null>(null)
  const [controlError, setControlError] = useState<string | null>(null)
  const [controlRetry, setControlRetry] = useState(0)
  const [controlTerminalRefetchSubmission, setControlTerminalRefetchSubmission] = useState<{ submissionUuid: string } | null>(null)
  const [liveActive, setLiveActive] = useState(false)
  const [historyReady, setHistoryReady] = useState(false)
  const [timelineControl, setTimelineControl] = useState<
    Pick<SessionTimelineResponse, 'pendingPermission' | 'runState' | 'activity'> & { liveBackgroundTasks: LiveBackgroundTask[] | null; tasks: RawSessionTask[] | null; known: boolean }
  >({
    pendingPermission: null,
    runState: null,
    activity: { owner: null, phase: 'idle', activeTurnId: null },
    liveBackgroundTasks: null,
    tasks: null,
    known: false,
  })
  const shouldScrollToBottomRef = useRef(false)
  const lastAppliedTimelineVersionRef = useRef<string | null>(null)
  const lastAppliedControlVersionRef = useRef<string | null>(null)
  const timelineControlSignalRef = useRef(timelineControlSignal)
  timelineControlSignalRef.current = timelineControlSignal
  const controlRequestRef = useRef(0)
  const historyIndexRef = useRef<TimelineTurnIndex>(timelineTurnIndex([]))
  const transcriptTurnsRef = useRef<TurnSummary[]>([])
  const turnsRef = useRef<TurnSummary[]>([])
  const overlaySourcesRef = useRef(new Map<string, OverlayMessageSource>())
  const reconcilingTurnIdsRef = useRef(new Set<string>())
  const liveUserMessageUuidRef = useRef<string | null>(null)
  const visibleUserMessageUuidRef = useRef<string | null>(null)
  const pendingPrimaryTurnUuidRef = useRef<string | null>(null)
  const pendingMessagesRef = useRef<unknown[]>([])
  const activeUserMessageUuidRef = useRef<string | null>(null)
  const completedLiveTurnIdRef = useRef<string | null>(null)
  const waitContextForNextTimelineRef = useRef(false)
  const loadOlderRequestRef = useRef(0)
  const transcriptRequestRef = useRef(0)
  const pendingTranscriptSignalRef = useRef<TranscriptSignal | null>(null)
  const activeTranscriptSignalRef = useRef<TranscriptSignal | null>(null)
  const onLiveTurnChangeRef = useRef(onLiveTurnChange)
  const onPendingTurnReconciledRef = useRef(onPendingTurnReconciled)
  const onSessionListStaleRef = useRef(onSessionListStale)
  const onTurnOptionsChangeRef = useRef(onTurnOptionsChange)
  const onContextUsageChangeRef = useRef(onContextUsageChange)
  const onActivityChangeRef = useRef(onActivityChange)
  const onTasksChangeRef = useRef(onTasksChange)
  const onSearchAnchorStaleRef = useRef(onSearchAnchorStale)
  const handledStaleAnchorScopeRef = useRef<string | null>(null)
  const searchAnchorScope = sessionId && searchAnchorTurnId ? `${sessionId}\0${searchAnchorTurnId}` : null
  const isTimelineAtBottomRef = useRef(isTimelineAtBottom)
  const previousScopeRef = useRef<SessionTimelineScope | null>(null)
  const pendingPrimaryTurnUuid = pendingTurn?.primaryUserUuid ?? null
  const provisionalFeedbackRef = useRef(new Map<string, Record<string, unknown>[]>())
  const controlTerminalRefetchSubmissionRef = useRef<string | null>(null)
  const provisionalSlashRef = useRef(provisionalSlash)
  provisionalSlashRef.current = provisionalSlash
  const liveEnabled = Boolean(projectId && sessionId)
  const historyQueryEnabled = liveEnabled && historyEnabled

  const materialize = useCallback((baseline = transcriptTurnsRef.current) => {
    transcriptTurnsRef.current = baseline
    const next = materializeTimelineTurns(turnsRef.current, baseline, overlaySourcesRef.current)
    historyIndexRef.current = next.transcriptIndex
    for (const id of [...overlaySourcesRef.current.keys()]) {
      const owner = turnsRef.current.find((turn) => turn.messages.some((message) => messageIdentity(message) === id))?.primaryUserUuid
      const message = turnsRef.current.flatMap((turn) => turn.messages).find((item) => messageIdentity(item) === id)
      if (message && messageIsRepresentedBy(message, next.transcriptIndex)) overlaySourcesRef.current.delete(id)
      if (owner && reconcilingTurnIdsRef.current.has(owner)) {
        const responseBlocks = projectTimelineTurn(next.turns.find((turn) => turn.primaryUserUuid === owner) ?? { primaryUserUuid: owner, messages: [] }).filter((block) => !isPrimaryInputBlock(block))
        if (responseBlocks.length > 0 && responseBlocks.every((block) => timelineBlockHasTranscriptEvidence(block, next.transcriptIndex))) reconcilingTurnIdsRef.current.delete(owner)
      }
    }
    turnsRef.current = next.turns
    setTurns(next.turns)
    return next.turns
  }, [])

  const applyTimelineControl = useCallback((page: SessionTimelineControlResponse) => {
    setTimelineControl({ pendingPermission: page.pendingPermission, runState: page.runState, activity: page.activity, liveBackgroundTasks: page.liveBackgroundTasks, tasks: page.tasks, known: true })
    const activeTurnId = page.activity.owner === 'cotta' ? page.activity.activeTurnId : null
    activeUserMessageUuidRef.current = activeTurnId
    // A pending optimistic turn owns the live state until it reconciles; don't let a
    // control refresh whose run-state read lags the submit tear it down mid-turn.
    const keepLive = activeTurnId === null && pendingPrimaryTurnUuidRef.current !== null
    if (!keepLive && liveUserMessageUuidRef.current !== activeTurnId) {
      liveUserMessageUuidRef.current = activeTurnId
      setLiveActive(activeTurnId !== null)
      if (activeTurnId) completedLiveTurnIdRef.current = null
      onLiveTurnChangeRef.current?.(page.sessionId, activeTurnId)
    }
    onActivityChangeRef.current?.(page.activity)
    onTasksChangeRef.current?.(page.tasks)
  }, [])

  const fetchCurrentTimeline = useCallback(async () => {
    const waitContext = waitContextForNextTimelineRef.current
    const pendingSubmissionUuid = provisionalSlashRef.current?.submissionUuid
    const page = await fetchSessionTimeline(sessionId!, {
      ...(searchAnchorTurnId ? { anchorTurnId: searchAnchorTurnId } : {}),
      ...(waitContext ? { waitContext } : {}),
      ...(pendingSubmissionUuid ? { pendingSubmissionUuid } : {}),
    })
    if (waitContext) waitContextForNextTimelineRef.current = false
    return page
  }, [searchAnchorTurnId, sessionId])
  const applyTimelineControlRefresh = useCallback(
    (page: SessionTimelineControlResponse) => {
      onTurnOptionsChangeRef.current?.(page.turnOptions)
      onContextUsageChangeRef.current?.(page.contextUsage)
      applyTimelineControl(page)
      lastAppliedControlVersionRef.current = page.state.version
    },
    [applyTimelineControl],
  )
  const applyTimelineFullRefresh = useCallback(
    (page: SessionTimelineControlResponse, transcriptVersion?: string) => {
      const controlSignal = timelineControlSignalRef.current
      if (controlSignal && page.state.version !== controlSignal.version && page.state.version !== transcriptVersion) return
      controlRequestRef.current += 1
      setControlError(null)
      applyTimelineControlRefresh(page)
    },
    [applyTimelineControlRefresh],
  )
  const timeline = useQuery({
    queryKey: sessionQueryKeys.sessionTimeline(sessionId!, searchAnchorTurnId ?? null),
    queryFn: fetchCurrentTimeline,
    enabled: historyQueryEnabled,
    retry: false,
    staleTime: searchAnchorTurnId ? Number.POSITIVE_INFINITY : 0,
    refetchOnWindowFocus: false,
  })
  useEffect(() => {
    onLiveTurnChangeRef.current = onLiveTurnChange
    onPendingTurnReconciledRef.current = onPendingTurnReconciled
    onSessionListStaleRef.current = onSessionListStale
    onTurnOptionsChangeRef.current = onTurnOptionsChange
    onContextUsageChangeRef.current = onContextUsageChange
    onActivityChangeRef.current = onActivityChange
    onTasksChangeRef.current = onTasksChange
    onSearchAnchorStaleRef.current = onSearchAnchorStale
    isTimelineAtBottomRef.current = isTimelineAtBottom
  })
  useEffect(() => {
    if (!searchAnchorScope) handledStaleAnchorScopeRef.current = null
  }, [searchAnchorScope])
  useEffect(() => {
    if (!searchAnchorTurnId || !(timeline.error instanceof TimelineSnapshotStaleError) || handledStaleAnchorScopeRef.current === searchAnchorScope) return
    handledStaleAnchorScopeRef.current = searchAnchorScope
    onSearchAnchorStaleRef.current?.()
  }, [searchAnchorScope, searchAnchorTurnId, timeline.error])

  useLayoutEffect(() => {
    const nextScope = { sessionId, pendingPrimaryTurnUuid, anchorTurnId: searchAnchorTurnId }
    const reset = shouldResetSessionTimeline(previousScopeRef.current, nextScope)
    previousScopeRef.current = nextScope
    if (!reset) return
    loadOlderRequestRef.current += 1
    transcriptRequestRef.current += 1
    pendingTranscriptSignalRef.current = null
    activeTranscriptSignalRef.current = null
    transcriptTurnsRef.current = []
    turnsRef.current = []
    overlaySourcesRef.current.clear()
    reconcilingTurnIdsRef.current.clear()
    setTurns([])
    setNextCursor(null)
    setHasMore(false)
    setHasNewer(false)
    setOlderError(null)
    setLoadingOlder(false)
    setLiveConnectionError(null)
    setControlError(null)
    setHistoryReady(false)
    setTimelineControl({ pendingPermission: null, runState: null, activity: { owner: null, phase: 'idle', activeTurnId: null }, liveBackgroundTasks: null, tasks: null, known: false })
    activeUserMessageUuidRef.current = null
    lastAppliedTimelineVersionRef.current = null
    lastAppliedControlVersionRef.current = null
    controlRequestRef.current += 1
    historyIndexRef.current = timelineTurnIndex([])
    liveUserMessageUuidRef.current = null
    visibleUserMessageUuidRef.current = null
    completedLiveTurnIdRef.current = null
    pendingPrimaryTurnUuidRef.current = null
    pendingMessagesRef.current = []
    provisionalFeedbackRef.current.clear()
    controlTerminalRefetchSubmissionRef.current = null
    setControlTerminalRefetchSubmission(null)
    waitContextForNextTimelineRef.current = false
    setLiveActive(false)
  }, [pendingPrimaryTurnUuid, searchAnchorTurnId, sessionId])

  useEffect(() => {
    const previousPending = pendingPrimaryTurnUuidRef.current
    if (!pendingTurn) {
      if (provisionalSlash) {
        pendingPrimaryTurnUuidRef.current = provisionalSlash.submissionUuid
        visibleUserMessageUuidRef.current = provisionalSlash.submissionUuid
        if (liveUserMessageUuidRef.current !== provisionalSlash.submissionUuid) {
          shouldScrollToBottomRef.current = true
          liveUserMessageUuidRef.current = provisionalSlash.submissionUuid
          setLiveActive(true)
          if (sessionId) onLiveTurnChangeRef.current?.(sessionId, provisionalSlash.submissionUuid)
        }
        return
      }
      if (!previousPending) return
      const pendingLive =
        turnsRef.current
          .find((turn) => turn.primaryUserUuid === previousPending)
          ?.messages.some((message) => {
            const id = messageIdentity(message)
            return id !== null && overlaySourcesRef.current.get(id) === 'LIVE'
          }) ?? false
      clearOptimisticOverlaySources(overlaySourcesRef.current, new Set(pendingMessagesRef.current.map(messageIdentity).filter((id): id is string => id !== null)))
      pendingPrimaryTurnUuidRef.current = null
      pendingMessagesRef.current = []
      const pendingOwnedVisible = visibleUserMessageUuidRef.current === previousPending
      if (!provisionalSlash && liveUserMessageUuidRef.current === previousPending && pendingOwnedVisible && !pendingLive && activeUserMessageUuidRef.current !== previousPending) {
        liveUserMessageUuidRef.current = null
        setLiveActive(false)
        if (sessionId) onLiveTurnChangeRef.current?.(sessionId, null)
      }
      materialize()
      return
    }
    for (const message of pendingTurn.messages) {
      const id = messageIdentity(message)
      if (id && overlaySourcesRef.current.get(id) !== 'LIVE') overlaySourcesRef.current.set(id, 'OPTIMISTIC')
    }
    pendingPrimaryTurnUuidRef.current = pendingTurn.primaryUserUuid
    pendingMessagesRef.current = pendingTurn.messages
    visibleUserMessageUuidRef.current = pendingTurn.primaryUserUuid
    if (liveUserMessageUuidRef.current !== pendingTurn.primaryUserUuid) {
      shouldScrollToBottomRef.current = true
      liveUserMessageUuidRef.current = pendingTurn.primaryUserUuid
      setLiveActive(true)
      if (sessionId) onLiveTurnChangeRef.current?.(sessionId, pendingTurn.primaryUserUuid)
    }
    if (!turnsRef.current.some((turn) => turn.primaryUserUuid === pendingTurn.primaryUserUuid)) turnsRef.current = [...turnsRef.current, pendingTurn]
    materialize()
  }, [materialize, pendingTurn, provisionalSlash, sessionId])

  useEffect(() => {
    if (!timeline.data || (transcriptSignal && timeline.data.state.version !== transcriptSignal.version)) return
    const nextVersion = timeline.data.state.version
    shouldScrollToBottomRef.current ||= isTimelineAtBottomRef.current()
    materialize(reconcileTimelineTurns(transcriptTurnsRef.current, timeline.data.turns))
    setNextCursor(timeline.data.nextCursor)
    setHasMore(timeline.data.hasMore)
    setHasNewer(timeline.data.hasNewer)
    applyTimelineFullRefresh(timeline.data, transcriptSignal?.version)
    const slashResolution = provisionalSlash ? resolvePendingSubmission(timeline.data, provisionalSlash.submissionUuid, !searchAnchorTurnId) : null
    if (sessionId && slashResolution) onPendingTurnReconciledRef.current?.(sessionId, provisionalSlash!.submissionUuid)
    if (sessionId && pendingPrimaryTurnUuid && timeline.data.turns.some((turn) => turn.primaryUserUuid === pendingPrimaryTurnUuid) && pendingPrimaryTurnUuidRef.current === pendingPrimaryTurnUuid) {
      const pendingIds = new Set(pendingMessagesRef.current.map(messageIdentity).filter((id): id is string => id !== null))
      clearOptimisticOverlaySources(overlaySourcesRef.current, pendingIds)
      pendingPrimaryTurnUuidRef.current = null
      pendingMessagesRef.current = []
      onPendingTurnReconciledRef.current?.(sessionId, pendingPrimaryTurnUuid)
    }
    setOlderError(null)
    lastAppliedTimelineVersionRef.current = nextVersion
    setHistoryReady(true)
  }, [applyTimelineFullRefresh, materialize, pendingPrimaryTurnUuid, provisionalSlash, searchAnchorTurnId, sessionId, timeline.data, transcriptSignal])

  useEffect(() => {
    if (!timelineControlSignal || !projectId || !sessionId || !historyEnabled || timelineControlSignal.version === lastAppliedControlVersionRef.current) return
    const request = controlRequestRef.current + 1
    controlRequestRef.current = request
    const version = timelineControlSignal.version
    const waitContext = waitContextForNextTimelineRef.current
    setControlError(null)
    void fetchSessionTimelineControl(sessionId, waitContext ? { waitContext: true } : {})
      .then((page) => {
        if (controlRequestRef.current !== request) return
        if (waitContext) waitContextForNextTimelineRef.current = false
        applyTimelineControlRefresh(page)
        const slash = provisionalSlashRef.current
        if (slash && page.runState?.phase === 'idle' && page.runState.lastTurn?.id === slash.submissionUuid) {
          controlTerminalRefetchSubmissionRef.current = slash.submissionUuid
          setControlTerminalRefetchSubmission({ submissionUuid: slash.submissionUuid })
        }
      })
      .catch((error) => {
        if (controlRequestRef.current === request && timelineControlSignalRef.current?.version === version) setControlError(error instanceof Error ? error.message : String(error))
      })
  }, [applyTimelineControlRefresh, controlRetry, historyEnabled, projectId, sessionId, timelineControlSignal])

  useEffect(() => {
    if (!controlTerminalRefetchSubmission || !sessionId) return
    let cancelled = false
    const submissionUuid = controlTerminalRefetchSubmission.submissionUuid
    const targetVersion = timelineControlSignalRef.current?.version ?? lastAppliedTimelineVersionRef.current
    const appliedVersion = lastAppliedTimelineVersionRef.current
    const transcriptGeneration = transcriptRequestRef.current
    const isCurrent = () =>
      !cancelled &&
      previousScopeRef.current?.sessionId === sessionId &&
      provisionalSlashRef.current?.submissionUuid === submissionUuid &&
      controlTerminalRefetchSubmissionRef.current === submissionUuid &&
      (timelineControlSignalRef.current?.version ?? lastAppliedTimelineVersionRef.current) === targetVersion &&
      lastAppliedTimelineVersionRef.current === appliedVersion &&
      transcriptRequestRef.current === transcriptGeneration &&
      activeTranscriptSignalRef.current === null &&
      pendingTranscriptSignalRef.current === null
    const clearRequest = () => {
      if (controlTerminalRefetchSubmissionRef.current !== submissionUuid) return
      controlTerminalRefetchSubmissionRef.current = null
      setControlTerminalRefetchSubmission(null)
    }
    void fetchSessionTimeline(sessionId, { pendingSubmissionUuid: submissionUuid })
      .then((page) => {
        const resolution = resolvePendingSubmission(page, submissionUuid, true)
        if (!isCurrent() || page.state.version !== targetVersion) {
          if (!cancelled && previousScopeRef.current?.sessionId === sessionId && provisionalSlashRef.current?.submissionUuid === submissionUuid && resolution)
            onPendingTurnReconciledRef.current?.(sessionId, submissionUuid)
          if (!cancelled) clearRequest()
          return
        }
        if (!resolution) {
          clearRequest()
          return
        }
        shouldScrollToBottomRef.current ||= isTimelineAtBottomRef.current()
        materialize(reconcileTimelineTurns(transcriptTurnsRef.current, page.turns))
        setNextCursor(page.nextCursor)
        setHasMore(page.hasMore)
        setHasNewer(page.hasNewer)
        applyTimelineFullRefresh(page)
        onPendingTurnReconciledRef.current?.(sessionId, submissionUuid)
        lastAppliedTimelineVersionRef.current = page.state.version
        setHistoryReady(true)
        setControlTerminalRefetchSubmission(null)
      })
      .catch((error) => {
        if (!isCurrent()) return
        clearRequest()
        setControlError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [applyTimelineFullRefresh, controlTerminalRefetchSubmission, materialize, sessionId])

  useEffect(() => {
    if (!transcriptSignal || !projectId || !sessionId || !historyEnabled || transcriptSignal.version === lastAppliedTimelineVersionRef.current) return
    if (transcriptSignal.source === 'snapshot' && lastAppliedTimelineVersionRef.current === null && timeline.isFetching) return
    setHistoryReady(false)
    pendingTranscriptSignalRef.current = coalesceTranscriptSignal(pendingTranscriptSignalRef.current, transcriptSignal, transcriptTurnsRef.current)
    if (activeTranscriptSignalRef.current) return
    const requestId = transcriptRequestRef.current + 1
    transcriptRequestRef.current = requestId
    loadOlderRequestRef.current += 1
    setLoadingOlder(false)
    async function drain() {
      while (pendingTranscriptSignalRef.current && transcriptRequestRef.current === requestId) {
        const signal = pendingTranscriptSignalRef.current
        pendingTranscriptSignalRef.current = null
        activeTranscriptSignalRef.current = signal
        try {
          const waitContext = waitContextForNextTimelineRef.current
          const fromTurnId = searchAnchorTurnId ? undefined : signal.source === 'snapshot' ? transcriptTurnsRef.current[0]?.primaryUserUuid : signal.reset ? undefined : signal.invalidateFromTurnId
          const pendingSubmissionUuid = provisionalSlashRef.current?.submissionUuid
          const page = await fetchSessionTimeline(sessionId!, {
            ...(searchAnchorTurnId ? { anchorTurnId: searchAnchorTurnId } : fromTurnId ? { fromTurnId } : {}),
            ...(waitContext ? { waitContext } : {}),
            ...(pendingSubmissionUuid ? { pendingSubmissionUuid } : {}),
          })
          if (transcriptRequestRef.current !== requestId) return
          if (pendingTranscriptSignalRef.current) {
            activeTranscriptSignalRef.current = null
            continue
          }
          const nextBaseline = signal.reset
            ? page.turns
            : fromTurnId
              ? replaceTimelineTail(transcriptTurnsRef.current, page.snapshotFromTurnId ?? fromTurnId, page.turns)
              : reconcileTimelineTurns(transcriptTurnsRef.current, page.turns)
          if (!nextBaseline) {
            pendingTranscriptSignalRef.current = { ...signal, reset: true, invalidateFromTurnId: null }
            activeTranscriptSignalRef.current = null
            continue
          }
          materialize(nextBaseline)
          if (signal.reset || (!fromTurnId && (signal.source !== 'snapshot' || lastAppliedTimelineVersionRef.current === null))) {
            setNextCursor(page.nextCursor)
            setHasMore(page.hasMore)
          }
          setHasNewer(page.hasNewer)
          applyTimelineFullRefresh(page, signal.version)
          const slash = provisionalSlashRef.current
          if (slash && resolvePendingSubmission(page, slash.submissionUuid, !searchAnchorTurnId && !fromTurnId)) onPendingTurnReconciledRef.current?.(sessionId!, slash.submissionUuid)
          if (waitContext) waitContextForNextTimelineRef.current = false
          if (pendingPrimaryTurnUuid && page.turns.some((turn) => turn.primaryUserUuid === pendingPrimaryTurnUuid)) {
            if (pendingPrimaryTurnUuidRef.current === pendingPrimaryTurnUuid) {
              const pendingIds = new Set(pendingMessagesRef.current.map(messageIdentity).filter((id): id is string => id !== null))
              clearOptimisticOverlaySources(overlaySourcesRef.current, pendingIds)
              pendingPrimaryTurnUuidRef.current = null
              pendingMessagesRef.current = []
              onPendingTurnReconciledRef.current?.(sessionId!, pendingPrimaryTurnUuid)
            }
          }
          setOlderError(null)
          lastAppliedTimelineVersionRef.current = page.state.version
          setHistoryReady(true)
          activeTranscriptSignalRef.current = null
        } catch (error) {
          if (transcriptRequestRef.current !== requestId) return
          if (error instanceof TimelineSnapshotStaleError && searchAnchorTurnId) {
            pendingTranscriptSignalRef.current = null
            activeTranscriptSignalRef.current = null
            if (handledStaleAnchorScopeRef.current !== searchAnchorScope) {
              handledStaleAnchorScopeRef.current = searchAnchorScope
              onSearchAnchorStaleRef.current?.()
            }
            return
          }
          if (error instanceof TimelineSnapshotStaleError && !signal.reset) {
            pendingTranscriptSignalRef.current = { ...signal, reset: true, invalidateFromTurnId: null }
            activeTranscriptSignalRef.current = null
            continue
          }
          pendingTranscriptSignalRef.current = pendingTranscriptSignalRef.current ? coalesceTranscriptSignal(signal, pendingTranscriptSignalRef.current, transcriptTurnsRef.current) : signal
          setOlderError(error instanceof Error ? error.message : String(error))
          await new Promise((resolve) => window.setTimeout(resolve, 1_000))
          activeTranscriptSignalRef.current = null
        }
      }
    }
    void drain()
  }, [applyTimelineFullRefresh, historyEnabled, materialize, pendingPrimaryTurnUuid, searchAnchorTurnId, sessionId, timeline.isFetching, transcriptSignal])

  useEffect(() => {
    if (!sessionId) return
    let active = true
    const events = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events`)
    events.onmessage = (message) => {
      if (!active) return
      let raw: unknown
      try {
        raw = JSON.parse(message.data)
      } catch (error) {
        console.error('timeline:sse invalid event', error)
        setLiveConnectionError('Live connection sent an invalid event; waiting for history…')
        setLiveActive(false)
        return
      }
      if (isRecord(raw) && typeof raw.session_id === 'string' && !belongsToTimelineSession(sessionId, raw.session_id)) return
      if (searchAnchorTurnId) {
        setHasNewer(true)
        return
      }
      const failure = resultFailureMessage(raw)
      const slash = provisionalSlashRef.current
      const unresolvedTerminal = slash !== null && slash !== undefined && isTerminalLiveEvent(raw)
      setLiveConnectionError(failure ? `Turn failed: ${failure}` : null)
      if (!unresolvedTerminal && isRecord(raw) && raw.type !== 'cotta_live_turn_failed') {
        const id = messageIdentity(raw)
        const uuid = sdkMessageUuid(raw)
        if (id) overlaySourcesRef.current.set(id, 'LIVE')
        if (uuid) overlaySourcesRef.current.set(`uuid:${uuid}`, 'LIVE')
      }
      if (isRecord(raw) && raw.type === 'user' && isPrimaryUserMessage(raw)) {
        const userMessageUuid = sdkMessageUuid(raw)
        if (userMessageUuid) visibleUserMessageUuidRef.current = userMessageUuid
        const runtimeUserMessageUuid = liveUserMessageUuidRef.current ?? userMessageUuid
        if (runtimeUserMessageUuid && runtimeUserMessageUuid !== liveUserMessageUuidRef.current) {
          completedLiveTurnIdRef.current = null
          liveUserMessageUuidRef.current = runtimeUserMessageUuid
          setLiveActive(true)
          onLiveTurnChangeRef.current?.(sessionId, runtimeUserMessageUuid)
        }
        if (userMessageUuid && provisionalSlashRef.current?.submissionUuid === userMessageUuid) onPendingTurnReconciledRef.current?.(sessionId, userMessageUuid)
      }
      const commandRoot = localCommandRoot(raw)
      const correlatedCommandRoot = slash ? localCommandRootForSubmission(raw, slash.submissionUuid) : null
      if (slash && isRecord(raw) && timelineLocalCommandFeedback(raw)) {
        const parentUuid = typeof raw.parentUuid === 'string' ? raw.parentUuid : null
        if (parentUuid && !turnsRef.current.some((turn) => turn.primaryUserUuid === parentUuid)) {
          provisionalFeedbackRef.current.set(parentUuid, [...(provisionalFeedbackRef.current.get(parentUuid) ?? []), raw])
          return
        }
      }
      if (commandRoot) {
        const feedback = provisionalFeedbackRef.current.get(commandRoot.uuid) ?? []
        provisionalFeedbackRef.current.delete(commandRoot.uuid)
        const next = feedback.reduce(
          (turns, message) => appendMessageToTurn(turns, commandRoot.uuid, message),
          applySdkMessage(turnsRef.current, commandRoot.message, historyIndexRef.current, visibleUserMessageUuidRef.current, Date.now()).turns,
        )
        visibleUserMessageUuidRef.current = commandRoot.uuid
        completedLiveTurnIdRef.current = null
        turnsRef.current = next
        setTurns(next)
        if (correlatedCommandRoot && slash) {
          pendingPrimaryTurnUuidRef.current = null
          onPendingTurnReconciledRef.current?.(sessionId, slash.submissionUuid)
        }
        shouldScrollToBottomRef.current ||= isTimelineAtBottomRef.current()
        return
      }
      const result = unresolvedTerminal
        ? { turns: turnsRef.current, currentUserMessageUuid: visibleUserMessageUuidRef.current, terminal: true }
        : applySdkMessage(
            turnsRef.current,
            raw,
            historyIndexRef.current,
            visibleUserMessageUuidRef.current ?? liveUserMessageUuidRef.current ?? pendingPrimaryTurnUuidRef.current ?? activeUserMessageUuidRef.current ?? null,
            Date.now(),
          )
      const terminal = result.terminal
      visibleUserMessageUuidRef.current = result.currentUserMessageUuid
      turnsRef.current = result.turns
      setTurns(result.turns)
      if (terminal) {
        const completedTurnId = liveUserMessageUuidRef.current
        const newlyCompleted = completedTurnId !== null && completedLiveTurnIdRef.current !== completedTurnId
        if (completedTurnId) {
          if (failure) reconcilingTurnIdsRef.current.delete(completedTurnId)
          else reconcilingTurnIdsRef.current.add(completedTurnId)
          completedLiveTurnIdRef.current = completedTurnId
        }
        waitContextForNextTimelineRef.current = true
        liveUserMessageUuidRef.current = null
        visibleUserMessageUuidRef.current = null
        activeUserMessageUuidRef.current = null
        setLiveActive(false)
        onLiveTurnChangeRef.current?.(sessionId, null)
        if (newlyCompleted) void timeline.refetch()
        onSessionListStaleRef.current?.()
      }
      shouldScrollToBottomRef.current ||= isTimelineAtBottomRef.current()
    }
    events.onopen = () => {
      if (!active) return
      setLiveConnectionError(null)
      const owner = liveUserMessageUuidRef.current ?? pendingPrimaryTurnUuidRef.current ?? activeUserMessageUuidRef.current
      if (owner) {
        setLiveActive(true)
        onLiveTurnChangeRef.current?.(sessionId, owner)
      }
    }
    events.onerror = () => {
      if (!active) return
      setLiveConnectionError('Live connection interrupted; waiting for history…')
      setLiveActive(false)
    }
    return () => {
      active = false
      events.close()
    }
  }, [searchAnchorTurnId, sessionId])

  const loadOlder = useCallback(async (): Promise<boolean> => {
    if (!historyEnabled || !sessionId || !nextCursor || loadingOlder) return false
    const requestId = loadOlderRequestRef.current + 1
    loadOlderRequestRef.current = requestId
    setLoadingOlder(true)
    setOlderError(null)
    try {
      const page = await fetchSessionTimeline(sessionId, { cursor: nextCursor })
      if (loadOlderRequestRef.current !== requestId) return false
      materialize(prependOlderTimelineTurns(transcriptTurnsRef.current, page.turns))
      setNextCursor(page.nextCursor)
      setHasMore(page.hasMore)
      return true
    } catch (error) {
      if (loadOlderRequestRef.current !== requestId) return false
      if (error instanceof TimelineSnapshotStaleError) {
        if (searchAnchorTurnId) {
          if (handledStaleAnchorScopeRef.current !== searchAnchorScope) {
            handledStaleAnchorScopeRef.current = searchAnchorScope
            onSearchAnchorStaleRef.current?.()
          }
        } else await timeline.refetch()
        return false
      }
      setOlderError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      if (loadOlderRequestRef.current === requestId) setLoadingOlder(false)
    }
  }, [historyEnabled, loadingOlder, materialize, nextCursor, searchAnchorTurnId, sessionId, timeline])

  return {
    turns,
    hasMore,
    hasNewer,
    olderError,
    loadingOlder,
    liveConnectionError,
    controlError,
    retryControl: () => {
      setControlError(null)
      setControlRetry((value) => value + 1)
    },
    historyReady,
    historyIndexRef,
    overlaySourcesRef,
    reconcilingTurnIdsRef,
    timelineControl,
    timeline,
    loadOlder,
    shouldScrollToBottomRef,
  }
}

export function AssistantResponseFrameSkeleton({ activeLabel, footerState }: { activeLabel?: string; footerState?: TurnFooterState }) {
  const state = footerState ?? { kind: 'cooking' as const, label: activeLabel }
  return (
    <div className="assistant-response group">
      <section className={timelineMessageClass.assistantFrame} aria-label="Turn response" aria-busy="true">
        <div className={timelineMessageClass.assistantFrameBody}>
          <div className="timeline-skeleton-line timeline-skeleton-line-mid" />
          <div className="timeline-skeleton-line" />
          <div className="timeline-skeleton-line timeline-skeleton-line-short" />
        </div>
      </section>
      <div className="mt-2 flex items-center px-1 text-[var(--tl-muted)]">
        <FooterStatus state={state} />
      </div>
    </div>
  )
}

function SessionTimelineSkeleton() {
  return (
    <section className="session-workspace-view" aria-label="Loading session timeline" aria-busy="true">
      <section className="timeline-panel timeline-skeleton-panel">
        {[0, 1, 2].map((item) => (
          <div className="timeline-skeleton-turn" key={item}>
            <div className="timeline-skeleton-line timeline-skeleton-line-short" />
            <div className="timeline-skeleton-line" />
            <div className="timeline-skeleton-line timeline-skeleton-line-mid" />
          </div>
        ))}
      </section>
    </section>
  )
}

export function SessionAwaySummary({ value }: { value: string }) {
  return (
    <aside className="session-away-summary" aria-label="Away recap">
      <div className="session-away-summary-label">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12.245 2.083c.917.065 1.802.247 2.64.533L13.26 4.24a8.513 8.513 0 0 0-1.156-.162C4.944 3.57.43 11.63 4.605 17.467l1.432 2.002L5.127 21h6.38c4.91 0 8.762-4.151 8.455-9h2.003c.307 5.94-4.432 11-10.459 11H3.7a1.187 1.187 0 0 1-1.021-1.794l.973-1.636-.672-.94c-5.16-7.213.42-17.174 9.266-16.547Z" />
          <path d="M20.724 5.383a1 1 0 0 1 0 1.414L12.3 14.854a1 1 0 0 1-1.414 0l-3.515-3.5A1 1 0 1 1 8.785 9.94l2.808 2.792 7.717-7.35a1 1 0 0 1 1.414 0Z" />
        </svg>
        <strong>Recap</strong>
      </div>
      <div className="session-away-summary-content">
        <ReactMarkdown>{value}</ReactMarkdown>
      </div>
    </aside>
  )
}

export function SessionTaskList({ tasks }: { tasks: RawSessionTask[] }) {
  const [expanded, setExpanded] = useState(false)
  const [showCompleted, setShowCompleted] = useState(true)
  if (tasks.length === 0) return null
  const statusLabel = { pending: 'OPEN', in_progress: 'IN PROGRESS', completed: 'DONE' }
  const taskRefs = (taskIds: string[]) => taskIds.map((taskId) => `#${taskId}`).join(', ')
  const counts = tasks.reduce((acc, task) => ({ ...acc, [task.status]: acc[task.status] + 1 }), { pending: 0, in_progress: 0, completed: 0 })
  const countSummary = `${tasks.length} total (${counts.completed} done, ${counts.in_progress} in progress, ${counts.pending} open)`
  const visibleTasks = showCompleted ? tasks : tasks.filter((task) => task.status !== 'completed')
  const renderTask = (task: RawSessionTask) => (
    <li className={`session-task-row session-task-row-${task.status}`} key={task.id}>
      <span className={`session-task-status session-task-status-${task.status}`} role="img" aria-label={statusLabel[task.status]}>
        {task.status === 'completed' ? (
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="m2.5 6.2 2.1 2.1 4.9-5" />
          </svg>
        ) : null}
      </span>
      <span className="session-task-state">{statusLabel[task.status]}</span>
      <span className="session-task-number">#{task.id}</span>
      <span className="session-task-main">
        <span className="session-task-subject">{task.subject}</span>
        {task.blockedBy.length > 0 ? <span className="session-task-blocked">› blocked by {taskRefs(task.blockedBy)}</span> : null}
      </span>
    </li>
  )
  return (
    <section className="session-task-list" aria-label="Session tasks" data-expanded={expanded}>
      <div className="session-task-summary">
        <button className="session-task-summary-toggle" type="button" onClick={() => setExpanded((value) => !value)}>
          <span className="session-task-summary-title">Tasks</span>
          <span className="session-task-summary-counts">{countSummary}</span>
        </button>
        {expanded && counts.completed > 0 ? (
          <button className="session-task-action" type="button" onClick={() => setShowCompleted((value) => !value)}>
            {showCompleted ? 'Hide done' : 'Show done'}
          </button>
        ) : null}
        <button className="session-task-action session-task-toggle" type="button" aria-label={expanded ? 'Collapse tasks' : 'Expand tasks'} onClick={() => setExpanded((value) => !value)}>
          <svg viewBox="0 0 12 12" className="session-task-toggle-icon" focusable="false" aria-hidden="true">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
        </button>
      </div>
      {expanded ? visibleTasks.length > 0 ? <ul className="session-task-items">{visibleTasks.map(renderTask)}</ul> : <p className="session-task-empty">All visible tasks are completed</p> : null}
    </section>
  )
}

export function SessionTimeline({
  projectId,
  projectName,
  projectPath,
  sessionId,
  sessionTitle,
  timeZone,
  historyEnabled = true,
  showDebugSource = true,
  transcriptSignal,
  timelineControlSignal,
  pendingTurn,
  provisionalSlash,
  pendingPhase,
  answeringQuestionId,
  onAnswerQuestion,
  onLiveTurnChange,
  onPendingTurnReconciled,
  onLatestTurnPhaseChange,
  onSessionListStale,
  onTurnOptionsChange,
  onContextUsageChange,
  onPendingPermissionChange,
  onActivityChange,
  onTasksChange,
  searchAnchorTurnId,
  searchTarget,
  onSearchTargetHandled,
  onJumpToLatest,
  onForkSession,
  onNotify,
  sharingEnabled = false,
}: {
  projectId: string
  projectName?: string | null
  projectPath?: string | null
  sessionId: string | null
  sessionTitle?: string | null
  timeZone: string
  historyEnabled?: boolean
  showDebugSource?: boolean
  transcriptSignal?: TranscriptSignal | null
  timelineControlSignal?: TimelineControlSignal | null
  pendingTurn?: TurnSummary | null
  provisionalSlash?: ProvisionalSlashSubmission | null
  pendingPhase?: TurnPhase
  answeringQuestionId?: string | null
  onAnswerQuestion?: (requestId: string, decision: AskUserQuestionDecisionRequest) => void
  onLiveTurnChange?: (sessionId: string, userMessageUuid: string | null) => void
  onPendingTurnReconciled?: (sessionId: string, userMessageUuid: string) => void
  onLatestTurnPhaseChange?: (phase: TurnPhase | null) => void
  onSessionListStale?: () => void
  onTurnOptionsChange?: (meta: SessionTimelineResponse['turnOptions']) => void
  onContextUsageChange?: (contextUsage: SessionTimelineResponse['contextUsage']) => void
  onPendingPermissionChange?: (pendingPermission: ToolApprovalRequest | null) => void
  onActivityChange?: (activity: SessionTimelineResponse['activity']) => void
  onTasksChange?: (tasks: SessionTimelineResponse['tasks']) => void
  searchAnchorTurnId?: string | null
  searchTarget?: { kind: 'message'; turnId: string; messageUuid: string; blockIndex?: number; queryNonce: number } | { kind: 'jump-latest'; queryNonce: number } | null
  onSearchTargetHandled?: () => void
  onJumpToLatest?: () => void
  onForkSession?: (upToMessageId: string) => Promise<unknown>
  onNotify?: (toast: ToastNotification) => void
  sharingEnabled?: boolean
}) {
  const timelinePanelRef = useRef<HTMLElement | null>(null)
  const programmaticScrollRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null)
  const olderScrollAnchorRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null)
  const loadingOlderFromScrollRef = useRef(false)
  const previousScopeRef = useRef<SessionTimelineScope | null>(null)
  const pendingPrimaryTurnUuid = pendingTurn?.primaryUserUuid ?? null
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const showScrollToBottomRef = useRef(false)
  const searchHighlightTimeoutRef = useRef<number | null>(null)
  const handledSearchTargetRef = useRef<number | null>(null)
  const [highlightedMessage, setHighlightedMessage] = useState<{ uuid: string; blockIndex: number } | null>(null)
  const [rawMessageSelection, setRawMessageSelection] = useState<{ turnId: string } | null>(null)
  const [subagentSelection, setSubagentSelection] = useState<{ turnId: string; selectedAgentId: string | null } | null>(null)
  const awaitingResponseTurnIdRef = useRef<string | null>(pendingPrimaryTurnUuid)
  const rawMessages = useQuery({
    queryKey: ['session-raw-messages', sessionId, rawMessageSelection?.turnId],
    queryFn: () => fetchSessionRawMessages(sessionId!, rawMessageSelection!.turnId),
    enabled: Boolean(sessionId && rawMessageSelection),
    retry: false,
  })
  const subagentTree = useQuery<TurnSubagentsTreeResponse>({
    queryKey: ['turn-subagents-tree', sessionId, subagentSelection?.turnId],
    queryFn: () => fetchTurnSubagentsTree(sessionId!, subagentSelection!.turnId),
    enabled: Boolean(sessionId && subagentSelection),
    retry: false,
    refetchOnWindowFocus: false,
  })
  const selectedSubagent = subagentTree.data?.tree.find(({ agentId }) => agentId === subagentSelection?.selectedAgentId)
  const subagentTranscript = useQuery<TurnSubagentTranscriptResponse>({
    queryKey: ['turn-subagent-transcript', sessionId, subagentSelection?.turnId, subagentSelection?.selectedAgentId, selectedSubagent?.transcriptVersion],
    queryFn: () => fetchTurnSubagentTranscript(sessionId!, subagentSelection!.turnId, subagentSelection!.selectedAgentId!),
    enabled: Boolean(sessionId && subagentSelection?.selectedAgentId && selectedSubagent),
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === sessionId && previousQuery.queryKey[2] === subagentSelection?.turnId && previousQuery.queryKey[3] === subagentSelection?.selectedAgentId
        ? previousData
        : undefined,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const matchingRawLines = rawMessages.data?.lines ?? []
  useEffect(() => {
    if (!subagentTree.isSuccess) return
    setSubagentSelection((current) =>
      current?.selectedAgentId && !subagentTree.data.tree.some(({ agentId }) => agentId === current.selectedAgentId) ? { ...current, selectedAgentId: null } : current,
    )
  }, [subagentTree.data?.tree, subagentTree.isSuccess])
  useEffect(() => setSubagentSelection(null), [sessionId])
  const isTimelineAtBottom = useCallback(() => {
    const panel = timelinePanelRef.current
    if (!panel) return true
    return panel.scrollHeight - panel.scrollTop - panel.clientHeight <= 24
  }, [])
  const {
    turns,
    hasMore,
    hasNewer,
    olderError,
    loadingOlder,
    liveConnectionError,
    controlError,
    retryControl,
    historyReady,
    historyIndexRef,
    overlaySourcesRef,
    reconcilingTurnIdsRef,
    timelineControl,
    timeline,
    loadOlder,
    shouldScrollToBottomRef,
  } = useSessionTimelineData(
    projectId,
    sessionId,
    historyEnabled,
    transcriptSignal,
    timelineControlSignal,
    searchAnchorTurnId,
    pendingTurn,
    provisionalSlash,
    onLiveTurnChange,
    onPendingTurnReconciled,
    onSessionListStale,
    onTurnOptionsChange,
    onContextUsageChange,
    onActivityChange,
    onTasksChange,
    searchAnchorTurnId
      ? () => {
          onNotify?.({ message: 'Original message can no longer be located. Showing latest messages.', tone: 'error' })
          onJumpToLatest?.()
        }
      : undefined,
    isTimelineAtBottom,
  )
  const visibleTurns = useMemo<ProjectedTimelineTurn[]>(() => turns.map((turn) => ({ ...turn, blocks: projectTimelineTurn(turn) })), [turns])
  const latestVisibleMessageUuid = useMemo(() => {
    for (let turnIndex = visibleTurns.length - 1; turnIndex >= 0; turnIndex -= 1) {
      const turn = visibleTurns[turnIndex]!
      for (let messageIndex = turn.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const message = turn.messages[messageIndex]
        if (typeof message === 'object' && message !== null && 'uuid' in message && typeof (message as { uuid?: unknown }).uuid === 'string') {
          return (message as { uuid: string }).uuid
        }
      }
    }
    return null
  }, [visibleTurns])
  if (pendingPrimaryTurnUuid && awaitingResponseTurnIdRef.current !== pendingPrimaryTurnUuid) awaitingResponseTurnIdRef.current = pendingPrimaryTurnUuid
  const openRawMessages = useCallback((turnId: string) => setRawMessageSelection({ turnId }), [])
  const openSubagents = useCallback((turnId: string) => setSubagentSelection({ turnId, selectedAgentId: null }), [])
  const loadOlderKeepingAnchor = useCallback(async () => {
    const panel = timelinePanelRef.current
    if (!panel || !hasMore || loadingOlder || loadingOlderFromScrollRef.current) return
    loadingOlderFromScrollRef.current = true
    olderScrollAnchorRef.current = { scrollTop: panel.scrollTop, scrollHeight: panel.scrollHeight }
    const loaded = await loadOlder()
    if (!loaded) olderScrollAnchorRef.current = null
    loadingOlderFromScrollRef.current = false
  }, [hasMore, loadOlder, loadingOlder])
  const setScrollButtonVisible = useCallback((value: boolean) => {
    if (showScrollToBottomRef.current === value) return
    showScrollToBottomRef.current = value
    setShowScrollToBottom(value)
  }, [])
  const handleTimelineScroll = useCallback(() => {
    const panel = timelinePanelRef.current
    if (!panel) return
    const atBottom = isTimelineAtBottom()
    // Our own scroll-to-bottom fires a scroll event with the exact geometry we just wrote;
    // a real user scroll changes scrollTop against that snapshot. Match both so growth-then-
    // programmatic-scroll isn't mistaken for user intent, and a user landing on the old value isn't either.
    const pin = programmaticScrollRef.current
    const programmatic = pin !== null && pin.scrollTop === panel.scrollTop && pin.scrollHeight === panel.scrollHeight
    if (atBottom) {
      shouldScrollToBottomRef.current = true
      programmaticScrollRef.current = null
    } else if (!programmatic) {
      shouldScrollToBottomRef.current = false
      programmaticScrollRef.current = null
    }
    setScrollButtonVisible(!shouldScrollToBottomRef.current)
    if (panel.scrollTop <= 24) void loadOlderKeepingAnchor()
  }, [isTimelineAtBottom, loadOlderKeepingAnchor, setScrollButtonVisible, shouldScrollToBottomRef])
  const scrollToTimelineBottom = useCallback(() => {
    shouldScrollToBottomRef.current = true
    const panel = timelinePanelRef.current
    if (!panel) return
    panel.scrollTop = panel.scrollHeight
    programmaticScrollRef.current = { scrollTop: panel.scrollTop, scrollHeight: panel.scrollHeight }
    setScrollButtonVisible(false)
  }, [setScrollButtonVisible, shouldScrollToBottomRef])

  const scrollTargetIntoView = useCallback(
    (panel: HTMLElement, target: HTMLElement, block: ScrollLogicalPosition) => {
      shouldScrollToBottomRef.current = false
      target.scrollIntoView({ block })
      programmaticScrollRef.current = { scrollTop: panel.scrollTop, scrollHeight: panel.scrollHeight }
      setScrollButtonVisible(true)
    },
    [setScrollButtonVisible, shouldScrollToBottomRef],
  )

  const scrollToMessageAnchor = useCallback(
    (messageUuid: string, requestedBlockIndex: number | undefined) => {
      const panel = timelinePanelRef.current
      if (!panel) return false
      const blockSelector = requestedBlockIndex === undefined ? '' : `[data-content-block-index="${requestedBlockIndex}"]`
      const target = panel.querySelector<HTMLElement>(`[data-message-uuid="${CSS.escape(messageUuid)}"]${blockSelector}`)
      if (!target) return false
      const blockIndex = requestedBlockIndex ?? Number(target.dataset.contentBlockIndex ?? 0)
      scrollTargetIntoView(panel, target, 'center')
      if (searchHighlightTimeoutRef.current !== null) window.clearTimeout(searchHighlightTimeoutRef.current)
      setHighlightedMessage({ uuid: messageUuid, blockIndex })
      searchHighlightTimeoutRef.current = window.setTimeout(() => {
        setHighlightedMessage((current) => (current?.uuid === messageUuid && current.blockIndex === blockIndex ? null : current))
        searchHighlightTimeoutRef.current = null
      }, 1600)
      return true
    },
    [scrollTargetIntoView],
  )

  const scrollToTurnCard = useCallback(
    (turnId: string) => {
      const panel = timelinePanelRef.current
      const target = panel?.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turnId)}"]`)
      if (!panel || !target) return false
      scrollTargetIntoView(panel, target, 'start')
      return true
    },
    [scrollTargetIntoView],
  )

  useLayoutEffect(() => {
    const nextScope = { sessionId, pendingPrimaryTurnUuid, anchorTurnId: searchAnchorTurnId }
    const reset = shouldResetSessionTimeline(previousScopeRef.current, nextScope)
    previousScopeRef.current = nextScope
    if (!reset) return
    olderScrollAnchorRef.current = null
    loadingOlderFromScrollRef.current = false
    awaitingResponseTurnIdRef.current = pendingPrimaryTurnUuid
    shouldScrollToBottomRef.current = true
    programmaticScrollRef.current = null
    handledSearchTargetRef.current = null
    if (searchHighlightTimeoutRef.current !== null) {
      window.clearTimeout(searchHighlightTimeoutRef.current)
      searchHighlightTimeoutRef.current = null
    }
    setHighlightedMessage(null)
    setScrollButtonVisible(false)
    setRawMessageSelection(null)
  }, [pendingPrimaryTurnUuid, searchAnchorTurnId, sessionId, setScrollButtonVisible, shouldScrollToBottomRef])

  const { pendingPermission, activity, liveBackgroundTasks, tasks } = timelineControl
  const latestTurn = visibleTurns.at(-1)
  const latestTurnCanShowWaiting = !hasNewer && latestTurn !== undefined
  const activeUserMessageUuid = effectiveActiveTurnId(activity, latestTurn)
  const pendingApprovalToolUseId = pendingPermission?.toolUseID ?? null
  const pendingQuestion = pendingPermission?.toolName === 'AskUserQuestion' ? pendingPermission : null
  const pendingQuestionTurnId = pendingQuestion
    ? ([...visibleTurns].reverse().find((turn) => turn.blocks.some((block) => block.kind === 'assistant.tool_use' && block.toolUseId === pendingQuestion.toolUseID))?.primaryUserUuid ?? null)
    : null
  const overlayActive = (turn: TurnSummary) =>
    turn.messages.some((message) => {
      const id = messageIdentity(message)
      return id !== null && overlaySourcesRef.current.has(id)
    })
  const activeTaskLabel = turnActiveTaskLabel(tasks)
  const activeTurnVisible = activeUserMessageUuid ? visibleTurns.some((turn) => turn.primaryUserUuid === activeUserMessageUuid) : false
  const latestPhase =
    activeUserMessageUuid && !activeTurnVisible
      ? 'submitted'
      : latestTurn
        ? turnPhase({
            turn: latestTurn,
            overlayActive: overlayActive(latestTurn),
            activeUserMessageUuid,
            pendingPhase: latestTurn.primaryUserUuid === pendingPrimaryTurnUuid ? pendingPhase : undefined,
            assumeActive: !timelineControl.known && !hasTerminalEvidence(latestTurn),
          })
        : null
  const responseSkeletonScrollKey = visibleTurns
    .flatMap((turn) =>
      turnPhase({ turn, overlayActive: overlayActive(turn), activeUserMessageUuid, pendingPhase: turn.primaryUserUuid === pendingPrimaryTurnUuid ? pendingPhase : undefined }) === 'submitted'
        ? [turn.primaryUserUuid]
        : [],
    )
    .join('|')

  useEffect(() => {
    onLatestTurnPhaseChange?.(latestPhase)
  }, [latestPhase, onLatestTurnPhaseChange])

  useEffect(() => {
    onPendingPermissionChange?.(pendingPermission)
  }, [onPendingPermissionChange, pendingPermission])

  useLayoutEffect(() => {
    const anchor = olderScrollAnchorRef.current
    if (!anchor) return
    olderScrollAnchorRef.current = null
    const panel = timelinePanelRef.current
    if (panel) panel.scrollTop = anchor.scrollTop + panel.scrollHeight - anchor.scrollHeight
  }, [visibleTurns])

  useEffect(() => {
    if (!historyReady || visibleTurns.length === 0 || !shouldScrollToBottomRef.current) return
    const targetSessionId = sessionId
    const frame = window.requestAnimationFrame(() => {
      if (sessionId !== targetSessionId || !shouldScrollToBottomRef.current) return
      scrollToTimelineBottom()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [historyReady, pendingApprovalToolUseId, scrollToTimelineBottom, sessionId, shouldScrollToBottomRef, visibleTurns])

  useLayoutEffect(() => {
    const panel = timelinePanelRef.current
    if (!panel || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (shouldScrollToBottomRef.current) scrollToTimelineBottom()
      else setScrollButtonVisible(!isTimelineAtBottom())
    })
    for (const child of panel.children) observer.observe(child)
    return () => observer.disconnect()
  })

  useLayoutEffect(() => {
    if (!searchTarget || handledSearchTargetRef.current === searchTarget.queryNonce) return
    if (searchTarget.kind === 'jump-latest') {
      handledSearchTargetRef.current = searchTarget.queryNonce
      scrollToTimelineBottom()
      onSearchTargetHandled?.()
      return
    }
    if (!historyReady || visibleTurns.length === 0) return
    if (!visibleTurns.some((turn) => turn.primaryUserUuid === searchTarget.turnId)) return
    // Turn-only targets (URL / share) fall back to the turn card when the primary message renders no anchor.
    if (!scrollToMessageAnchor(searchTarget.messageUuid, searchTarget.blockIndex) && (searchTarget.blockIndex !== undefined || !scrollToTurnCard(searchTarget.turnId))) return
    handledSearchTargetRef.current = searchTarget.queryNonce
    onSearchTargetHandled?.()
  }, [historyReady, onSearchTargetHandled, scrollToMessageAnchor, scrollToTimelineBottom, scrollToTurnCard, searchTarget, visibleTurns])

  useEffect(
    () => () => {
      if (searchHighlightTimeoutRef.current !== null) window.clearTimeout(searchHighlightTimeoutRef.current)
    },
    [],
  )

  useLayoutEffect(() => {
    setScrollButtonVisible(!shouldScrollToBottomRef.current && !isTimelineAtBottom())
  }, [isTimelineAtBottom, setScrollButtonVisible, shouldScrollToBottomRef, visibleTurns])

  useLayoutEffect(() => {
    if (!responseSkeletonScrollKey || !shouldScrollToBottomRef.current) return
    scrollToTimelineBottom()
  }, [responseSkeletonScrollKey, scrollToTimelineBottom, shouldScrollToBottomRef])

  if (timeline.isError && visibleTurns.length === 0 && !pendingQuestion && !provisionalSlash)
    return <div className="panel error">Failed to load timeline: {timeline.error instanceof Error ? timeline.error.message : 'unknown error'}</div>
  if (!historyReady && visibleTurns.length === 0 && !olderError && !pendingQuestion && !provisionalSlash) return <SessionTimelineSkeleton />

  return (
    <section className="session-workspace-view" aria-label="Session workspace">
      <section className="timeline-panel" aria-label="Session timeline" ref={timelinePanelRef} onScroll={handleTimelineScroll}>
        {searchAnchorTurnId && hasNewer ? (
          <div className="timeline-search-latest">
            <button type="button" onClick={onJumpToLatest}>
              Jump to latest
            </button>
          </div>
        ) : null}
        {hasMore ? (
          <div className="section-heading">
            <button className="load-older" type="button" onClick={loadOlderKeepingAnchor} disabled={loadingOlder} aria-label={loadingOlder ? 'Loading older turns' : undefined}>
              {loadingOlder ? (
                <span className="loading-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              ) : (
                'Load older'
              )}
            </button>
          </div>
        ) : null}
        {olderError ? <div className="panel error">Failed to load older turns: {olderError}</div> : null}
        {liveConnectionError ? <div className="panel muted">{liveConnectionError}</div> : null}
        {controlError ? (
          <div className="panel error">
            Failed to refresh session controls: {controlError}{' '}
            <button type="button" onClick={retryControl}>
              Try again
            </button>
          </div>
        ) : null}
        {visibleTurns.length === 0 && !olderError && !liveConnectionError && !pendingQuestion && !provisionalSlash ? (
          <div className="timeline-empty-state">{projectName ? `What should we work on in ${projectName}?` : 'What should we build?'}</div>
        ) : null}
        {pendingQuestion && !pendingQuestionTurnId ? (
          <AskUserQuestionToolContent
            input={pendingQuestion.input}
            results={[]}
            questionRequest={pendingQuestion}
            submitting={pendingQuestion.requestId === answeringQuestionId}
            onAnswerQuestion={onAnswerQuestion}
          />
        ) : null}
        {visibleTurns.map((turn) => {
          const phase = turn.primaryUserUuid === latestTurn?.primaryUserUuid && latestPhase ? latestPhase : turnPhase({ turn, overlayActive: overlayActive(turn), activeUserMessageUuid })
          const terminal = hasTerminalEvidence(turn)
          const activeToolCalls = !terminal && phase !== 'settled'
          const turnEndedAtMs = turn.durationTimestampMs ?? (turn.primaryUserTimestampMs !== undefined && turn.durationMs !== undefined ? turn.primaryUserTimestampMs + turn.durationMs : undefined)
          const displayItems = groupAssistantResponseFrames(groupTimelineBlocks(turn.blocks, activeToolCalls, turnEndedAtMs))
          const lastAssistantFrame = [...displayItems].reverse().find((item) => item.type === 'assistant-response-frame')
          const lastAssistantFrameId = lastAssistantFrame?.id
          const reconciling = reconcilingTurnIdsRef.current.has(turn.primaryUserUuid)
          const lastAssistantFrameSource = lastAssistantFrame
            ? assistantFrameSource(lastAssistantFrame.items.flatMap(timelineRenderItemBlocks), historyIndexRef.current, overlaySourcesRef.current, reconciling)
            : null
          const hasVisibleResponse = lastAssistantFrame ? assistantResponseFrameHasVisibleContent(lastAssistantFrame.items) : false
          if (hasVisibleResponse || terminal) {
            if (awaitingResponseTurnIdRef.current === turn.primaryUserUuid) awaitingResponseTurnIdRef.current = null
          }
          const cooking = phase === 'submitted' || phase === 'rendering'
          const activeLabel = cooking ? ((turn.primaryUserUuid === activeUserMessageUuid ? activeTaskLabel : undefined) ?? turnCookingLabel(turn.primaryUserUuid)) : undefined
          const primaryOnly = turn.blocks.every(isPrimaryInputBlock)
          const localCommandOnly = turn.blocks.length > 0 && turn.blocks.every((block) => block.kind === 'user.local_command')
          const footerTurn =
            latestTurnCanShowWaiting && turn.primaryUserUuid === latestTurn?.primaryUserUuid
              ? { ...turn, pendingBackgroundAgentCount: liveBackgroundTasks === null ? turn.pendingBackgroundAgentCount : liveBackgroundTasks.length }
              : { ...turn, pendingBackgroundAgentCount: undefined }
          const footerState = turnFooterState({ turn: footerTurn, phase, cooking, activeLabel, primaryOnly, reconciling })
          const showResponseSkeleton =
            !localCommandOnly &&
            (shouldShowResponseSkeleton({ phase, hasVisibleResponse }) ||
              shouldHoldResponseSkeleton({ awaitingTurnId: awaitingResponseTurnIdRef.current, turnId: turn.primaryUserUuid, hasVisibleResponse, terminal }))
          return (
            <article className="turn-card" key={turn.primaryUserUuid} data-turn-id={turn.primaryUserUuid}>
              <div className="timeline-blocks">
                {displayItems.map((item) =>
                  item.type === 'assistant-response-frame' ? (
                    <AssistantResponseFrameView
                      item={item}
                      turnBlocks={turn.blocks}
                      timestamp={item.id === lastAssistantFrameId && turn.durationMs !== undefined ? turn.durationTimestampMs : undefined}
                      timeZone={timeZone}
                      footerState={item.id === lastAssistantFrameId ? footerState : null}
                      phase={phase}
                      cwd={item.id === lastAssistantFrameId ? turn.responseCwd : undefined}
                      sessionId={item.id === lastAssistantFrameId ? (sessionId ?? undefined) : undefined}
                      entrypoint={item.id === lastAssistantFrameId ? turn.entrypoint : undefined}
                      source={
                        item.id === lastAssistantFrameId
                          ? lastAssistantFrameSource
                          : assistantFrameSource(item.items.flatMap(timelineRenderItemBlocks), historyIndexRef.current, overlaySourcesRef.current, reconciling)
                      }
                      showSource={showDebugSource}
                      localImageContext={sessionId && projectPath && (turn.responseCwd ?? turn.userCwd) ? { sessionId, projectPath, cwd: (turn.responseCwd ?? turn.userCwd) as string } : undefined}
                      pendingApprovalToolUseId={pendingApprovalToolUseId}
                      pendingQuestion={turn.primaryUserUuid === pendingQuestionTurnId ? pendingQuestion : null}
                      answeringQuestionId={answeringQuestionId}
                      onAnswerQuestion={onAnswerQuestion}
                      onViewRaw={() => openRawMessages(turn.primaryUserUuid)}
                      onViewSubagents={item.id === lastAssistantFrameId ? () => openSubagents(turn.primaryUserUuid) : undefined}
                      subagentCount={item.id === lastAssistantFrameId ? (turn.subagentCount ?? 0) : 0}
                      onForkSession={item.id === lastAssistantFrameId ? onForkSession : undefined}
                      onNotify={onNotify}
                      onShare={
                        item.id === lastAssistantFrameId && sharingEnabled && turn.shareEligible && projectId && sessionId
                          ? () => void openShareInNewTab(projectId, sessionId, turn.primaryUserUuid, onNotify)
                          : undefined
                      }
                      highlightedMessage={highlightedMessage}
                      key={item.id}
                    />
                  ) : item.type === 'primary-input' ? (
                    <PrimaryInputView
                      blocks={item.blocks}
                      timestamp={turn.primaryUserTimestampMs}
                      timeZone={timeZone}
                      cwd={turn.userCwd}
                      sessionId={sessionId ?? undefined}
                      entrypoint={turn.entrypoint}
                      source={primaryMessageSource(item.blocks[0]!, historyIndexRef.current, overlaySourcesRef.current) ?? undefined}
                      showSource={showDebugSource}
                      onViewRaw={() => openRawMessages(turn.primaryUserUuid)}
                      onViewSubagents={() => openSubagents(turn.primaryUserUuid)}
                      subagentCount={turn.subagentCount ?? 0}
                      highlightedMessage={highlightedMessage}
                      key={item.id}
                    />
                  ) : (
                    <TimelineRenderItemView
                      item={item.item}
                      timestamp={item.item.type === 'block' && item.item.block.kind === 'user.message' ? turn.primaryUserTimestampMs : undefined}
                      timeZone={timeZone}
                      cwd={item.item.type === 'block' && item.item.block.kind === 'user.message' ? turn.userCwd : undefined}
                      sessionId={item.item.type === 'block' && item.item.block.kind === 'user.message' ? (sessionId ?? undefined) : undefined}
                      entrypoint={item.item.type === 'block' && item.item.block.kind === 'user.message' ? turn.entrypoint : undefined}
                      source={showDebugSource && item.item.type === 'block' ? (primaryMessageSource(item.item.block, historyIndexRef.current, overlaySourcesRef.current) ?? undefined) : undefined}
                      showSource={showDebugSource}
                      pendingApprovalToolUseId={pendingApprovalToolUseId}
                      pendingQuestion={turn.primaryUserUuid === pendingQuestionTurnId ? pendingQuestion : null}
                      answeringQuestionId={answeringQuestionId}
                      onAnswerQuestion={onAnswerQuestion}
                      onViewRaw={() => openRawMessages(turn.primaryUserUuid)}
                      onViewSubagents={item.item.type === 'block' && item.item.block.kind === 'user.message' ? () => openSubagents(turn.primaryUserUuid) : undefined}
                      subagentCount={item.item.type === 'block' && item.item.block.kind === 'user.message' ? (turn.subagentCount ?? 0) : 0}
                      highlightedMessage={highlightedMessage}
                      key={timelineRenderItemKey(item.item)}
                    />
                  ),
                )}
              </div>
              {showResponseSkeleton ? <AssistantResponseFrameSkeleton activeLabel={activeLabel} footerState={footerState} /> : null}
              {turn.awaySummary?.trim() ? <SessionAwaySummary value={turn.awaySummary} /> : null}
            </article>
          )
        })}
        {provisionalSlash ? (
          <article className="turn-card" key={provisionalSlash.localKey} data-provisional-command="true">
            <div className="timeline-blocks">
              <LocalCommandRow text={provisionalSlash.text} />
            </div>
          </article>
        ) : null}
      </section>
      {showScrollToBottom ? (
        <button className="timeline-scroll-bottom" type="button" onClick={scrollToTimelineBottom} aria-label="Scroll to latest message">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 3.5v12m0 0 5-5m-5 5-5-5" />
          </svg>
        </button>
      ) : null}
      {subagentSelection ? (
        <SubagentsDialog
          sessionTitle={sessionTitle}
          sessionId={sessionId ?? undefined}
          projectPath={projectPath ?? undefined}
          timeZone={timeZone}
          tree={subagentTree.data?.tree ?? []}
          treeLoading={subagentTree.isLoading}
          treeError={subagentTree.error}
          selectedAgentId={subagentSelection.selectedAgentId}
          transcript={subagentTranscript.data?.transcript}
          transcriptLoading={subagentTranscript.isLoading}
          transcriptError={subagentTranscript.error}
          onSelect={(selectedAgentId) => setSubagentSelection((current) => (current ? { ...current, selectedAgentId } : current))}
          onClose={() => setSubagentSelection(null)}
        />
      ) : null}
      {rawMessageSelection ? (
        <RawMessagesDialog lines={matchingRawLines} timeZone={timeZone} loading={rawMessages.isLoading} error={rawMessages.error} onClose={() => setRawMessageSelection(null)} />
      ) : null}
    </section>
  )
}
