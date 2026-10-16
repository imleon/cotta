import type { ProjectSessionsResponse, SessionSummary, SessionTimelineControlResponse, SessionTimelineResponse } from '@cotta/shared'
import { computeShareEligible } from '@cotta/shared'
import { toSessionSummary } from './claude-code-api.js'
import type { ProjectRoutesInput, ProjectRoutesLiveTurnManager, SessionMetadata, TimelineMetadata, TurnMetadataValue } from './routes/project-routes-shared.js'
import { locateSession, resolveSessionProject, resolveSessionTimelineState, sessionActivity } from './routes/project-routes-shared.js'
import { TimelineAnchorStaleError, TranscriptUnavailableError } from './session-raw-transcript-cache.js'
import { projectSessionTimeline } from './timeline-projection.js'

export class ProjectReadModelError extends Error {
  constructor(
    readonly code: 'project_not_found' | 'session_not_found' | 'session_raw_transcript_unavailable' | 'timeline_metadata_unavailable',
    options?: ErrorOptions,
  ) {
    super(code, options)
  }
}

export function overlayLiveSessionRunState<T extends { sessions: SessionSummary[] }>(
  liveTurnManager: ProjectRoutesLiveTurnManager,
  response: T,
  sessionMetadataReader?: (sessionId: string) => SessionMetadata | null,
): T {
  return {
    ...response,
    sessions: response.sessions.map((session) => {
      const runState = liveTurnManager.sessionRunState(session.id)
      const liveBackgroundTasks = liveTurnManager.liveBackgroundTasks?.(session.id) ?? null
      const metadata = sessionMetadataReader?.(session.id) ?? null
      const activity = sessionActivity(runState, metadata, liveBackgroundTasks)
      const externalMetadata = activity.owner === 'cotta' ? null : metadata
      const hasRuntime = liveTurnManager.hasRuntime?.(session.id) ?? false
      return {
        ...session,
        occupiedBy: activity.owner,
        occupiedStatus: activity.phase,
        ...(hasRuntime ? { hasRuntime: true } : {}),
        ...(activity.owner === 'cotta' && activity.phase === 'idle' && runState?.lastTurn ? { lastTurnOutcome: runState.lastTurn.outcome } : {}),
        hasRunningShell: externalMetadata?.hasRunningShell ?? false,
        kind: externalMetadata?.kind ?? session.kind,
      }
    }),
  }
}

export async function readProjectSessions(input: ProjectRoutesInput, options: { projectId: string; limit: number; cursor: string | null }): Promise<ProjectSessionsResponse> {
  const result = await input.claudeCodeApi.listProjectSessions(options.projectId, { limit: options.limit, cursor: options.cursor })
  if (!result) throw new ProjectReadModelError('project_not_found')
  return overlayLiveSessionRunState(input.liveTurnManager, result, input.sessionMetadataReader)
}

export function readProjectSession(input: ProjectRoutesInput, projectId: string, sessionId: string): SessionSummary | null {
  const session = locateSession(input, sessionId)
  if (!session || session.currentProjectId !== projectId) return null
  return overlayLiveSessionRunState(input.liveTurnManager, { sessions: [toSessionSummary(session)] }, input.sessionMetadataReader).sessions[0] ?? null
}

type TimelineReadOptions = {
  projectId: string
  sessionId: string
  scope?: 'control'
  limitTurns: number
  cursor: string | null
  fromTurnId: string | null
  anchorTurnId: string | null
  pendingSubmissionUuid: string | null
  waitContext: boolean
  acknowledgeCompletedTurn?: boolean
  excludeLocalCommandTurns?: boolean
}

function applyTurnMetadata<T extends { turns: Array<{ primaryUserUuid: string }> }>(timeline: T, metadata: ReadonlyMap<string, TurnMetadataValue>): T {
  if (metadata.size === 0) return timeline
  return {
    ...timeline,
    turns: timeline.turns.map((turn) => {
      const value = metadata.get(turn.primaryUserUuid)
      return value ? { ...turn, ...value } : turn
    }),
  }
}

export async function readProjectTimeline(input: ProjectRoutesInput, options: TimelineReadOptions): Promise<SessionTimelineControlResponse | SessionTimelineResponse> {
  const located = locateSession(input, options.sessionId)
  if (!located || located.currentProjectId !== options.projectId) throw new ProjectReadModelError('session_not_found')
  if (options.scope !== 'control') {
    if (!input.transcriptSyncer) throw new ProjectReadModelError('session_raw_transcript_unavailable')
    await input.transcriptSyncer(options.projectId, located.sessionId, located.fileSize ?? undefined)
  }
  const session = options.scope === 'control' ? locateSession(input, options.sessionId) : resolveSessionProject(input, options.sessionId)
  if (!session || session.currentProjectId !== options.projectId || !resolveSessionTimelineState(input, session)) throw new ProjectReadModelError('session_not_found')

  const runState = input.liveTurnManager.sessionRunState(session.sessionId)
  const liveBackgroundTasks = input.liveTurnManager.liveBackgroundTasks?.(session.sessionId) ?? null
  const activity = sessionActivity(runState, input.sessionMetadataReader?.(session.sessionId) ?? null, liveBackgroundTasks)
  const pendingPermission = runState?.phase === 'requires_action' ? (runState.pendingPermission ?? null) : null
  const contextUsage = options.waitContext
    ? ((await input.liveTurnManager.contextUsage?.(session.sessionId, true)) ?? input.sessionContextUsageStore?.getContextUsage(session.sessionId) ?? null)
    : (input.sessionContextUsageStore?.getContextUsage(session.sessionId) ?? null)
  let timelineMetadata: TimelineMetadata
  try {
    timelineMetadata = (await input.timelineMetadataReader?.(options.projectId, session.sessionId)) ?? {
      turnMetadata: new Map(),
      turnOptions: { permissionMode: null, model: null, effort: null },
    }
  } catch (error) {
    throw new ProjectReadModelError('timeline_metadata_unavailable', { cause: error })
  }
  const control: SessionTimelineControlResponse = {
    sessionId: session.sessionId,
    turnOptions: timelineMetadata.turnOptions,
    contextUsage,
    liveBackgroundTasks: liveBackgroundTasks ? [...liveBackgroundTasks] : null,
    runState,
    activity,
    pendingPermission,
    state: {
      sessionId: session.sessionId,
      version: input.timelineVersionReader(options.projectId, session.sessionId),
      fileSize: session.fileSize ?? undefined,
    },
    tasks: session.taskSnapshot,
  }
  if (options.scope === 'control') return control
  if (!input.rawTranscriptCache) throw new ProjectReadModelError('session_raw_transcript_unavailable')

  const window = input.rawTranscriptCache.loadTimelineWindow(session.sessionId, {
    limitTurns: options.limitTurns,
    cursor: options.cursor,
    fromTurnId: options.fromTurnId,
    anchorTurnId: options.anchorTurnId,
    excludeLocalCommandTurns: options.excludeLocalCommandTurns,
  })
  const timeline = projectSessionTimeline(session.sessionId, window.primaryTurns, window.ownedMessages)
  const subagentCounts = input.subagentStore?.countsByTurn(session.sessionId) ?? new Map<string, number>()
  const projectionSubmissionUuid = options.pendingSubmissionUuid ?? runState?.lastTurn?.id
  const runtimeTurnProjection = projectionSubmissionUuid ? input.liveTurnManager.runtimeTurnProjection(session.sessionId, projectionSubmissionUuid) : null
  const response: SessionTimelineResponse = {
    ...applyTurnMetadata(
      {
        ...timeline,
        turns: timeline.turns.map((turn) => ({ ...turn, subagentCount: subagentCounts.get(turn.primaryUserUuid) ?? 0 })),
        hasMore: window.hasMore,
        hasNewer: window.hasNewer,
        nextCursor: window.nextCursor,
      },
      timelineMetadata.turnMetadata,
    ),
    ...control,
    state: { sessionId: session.sessionId, version: input.timelineVersionReader(options.projectId, session.sessionId), fileSize: window.fileSize },
    runtimeTurnProjection,
    snapshotFromTurnId: window.snapshotFromTurnId,
    anchorTurnId: window.anchorTurnId,
  }
  // Any settled turn is shareable; only the session's true latest turn (window tail with no newer turn)
  // carries the live-activity guard. Historical turns are frozen, so session-level live state is irrelevant.
  const latestIndex = window.hasNewer ? -1 : response.turns.length - 1
  response.turns.forEach((turn, index) => {
    turn.shareEligible = computeShareEligible({ turn, activity, pendingPermission, liveBackgroundTasks, isSessionLatest: index === latestIndex })
  })
  const completedTurn = runState?.phase === 'idle' ? runState.lastTurn : undefined
  const completedTurnVisible = completedTurn && response.turns.some((turn) => turn.primaryUserUuid === completedTurn.id)
  const projectionVisible = runtimeTurnProjection?.kind === 'visible' && response.turns.some((turn) => turn.primaryUserUuid === runtimeTurnProjection.visibleTurnUuid)
  const terminalOnlyCompleteTail = runtimeTurnProjection?.kind === 'terminal-only' && !options.cursor && !options.fromTurnId && !options.anchorTurnId
  if (
    options.acknowledgeCompletedTurn !== false &&
    completedTurn &&
    (runtimeTurnProjection?.submissionUuid === completedTurn.id ? completedTurnVisible || projectionVisible || terminalOnlyCompleteTail : completedTurnVisible)
  )
    input.liveTurnManager.acknowledgeCompletedTurn({ projectId: options.projectId, sessionId: session.sessionId, turnId: completedTurn.id })
  return response
}

export { TimelineAnchorStaleError, TranscriptUnavailableError }
