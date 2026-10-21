import { stat } from 'node:fs/promises'
import { type PermissionResult, type PermissionUpdate, type Query, query, type SDKControlGetContextUsageResponse, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  type AskUserQuestionDecisionRequest,
  buildComposerMessageContent,
  type ComposerImage,
  type DefaultTurnOption,
  type EffortLevel,
  isSlashLookingInput,
  type LiveBackgroundTask,
  type ModelSelection,
  type PermissionMode,
  permissionModeSchema,
  type RuntimeTurnProjection,
  type SessionContextUsage,
  type SessionRunState,
  type ToolApprovalDecisionRequest,
  type ToolApprovalRequest,
  timelineLocalCommand,
} from '@cotta/shared'
import { projectPathFromId } from './claude-code-api.js'
import type { SessionContextUsageStore } from './session-context-usage-store.js'
import type { SettingsStore } from './settings-store.js'
import { readSettings } from './turn-options.js'

const IDLE_RUNTIME_TTL_MS = 10 * 60 * 1000

export class ProjectDirectoryUnavailableError extends Error {}
export class SessionExternallyOwnedError extends Error {}
export class SessionTurnInProgressError extends Error {}
export class SessionProjectMismatchError extends Error {}

type SessionActivityObserver = {
  signalSessionActivity?(input: { sessionId: string; projectId?: string }): unknown
  notifySessionRunStateActive?(input: { sessionId: string; projectId: string; version: number }): unknown
  onPermissionModeChanged?(input: { sessionId: string; projectId: string; mode: PermissionMode; previousMode: PermissionMode; observedAtMs: number }): unknown | Promise<unknown>
}

type LiveTurnMetadataRecorder = {
  recordLiveResult(projectId: string, sessionId: string, userMessageUuid: string, message: SDKMessage): void
}

function sdkUserMessage(input: {
  uuid: SDKUserMessage['uuid']
  text?: string
  images?: ComposerImage[]
  sessionId: string
  startedAt: number
}): SDKUserMessage & { entrypoint: 'sdk-ts'; parent_agent_id: null } {
  return {
    type: 'user',
    message: { role: 'user', content: buildComposerMessageContent(input.text ?? '', input.images ?? []) },
    parent_tool_use_id: null,
    parent_agent_id: null,
    entrypoint: 'sdk-ts',
    uuid: input.uuid,
    session_id: input.sessionId,
    timestamp: new Date(input.startedAt).toISOString(),
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function isMainSessionMessage(value: Record<string, unknown>): boolean {
  return value.parent_tool_use_id === null && value.parent_agent_id == null && value.isSidechain !== true
}

type CottaLiveTurnFailedEvent = {
  type: 'cotta_live_turn_failed'
  error: string
  session_id: string
}

function cottaLiveTurnFailed(input: { error: string; sessionId: string }): CottaLiveTurnFailedEvent {
  return { type: 'cotta_live_turn_failed', error: input.error, session_id: input.sessionId }
}

type CottaRunStateChangedEvent = {
  type: 'cotta_run_state_changed'
  session_id: string
}

// Permission updates retain their SDK destination; Cotta mirrors only the mode later confirmed by SDK status.
function sdkPermissionMode(message: SDKMessage): PermissionMode | null {
  if (message.type !== 'system' || !('subtype' in message) || (message.subtype !== 'init' && message.subtype !== 'status')) return null
  return permissionModeSchema.safeParse(message.permissionMode).data ?? null
}

function permissionDenyMessage(toolName: string, message: string | undefined): string {
  const feedback = message?.trim()
  if (toolName !== 'ExitPlanMode' || !feedback) return message ?? 'Denied by user.'
  return `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n${feedback}`
}

function questionDecisionMatchesInput(input: unknown, decision: Extract<AskUserQuestionDecisionRequest, { behavior: 'completed' }>): boolean {
  const questions = record(input)?.questions
  if (!Array.isArray(questions)) return false
  const declared = questions.map(record)
  const keys = declared.map((question) => question?.question)
  if (keys.some((key) => typeof key !== 'string' || !key) || new Set(keys).size !== keys.length) return false
  // Partial answers are allowed (the Lark card can submit a subset); every provided key must still be a declared question with a non-empty answer.
  const stringKeys = keys as string[]
  if (Object.keys(decision.answers).some((key) => !stringKeys.includes(key)) || Object.keys(decision.annotations ?? {}).some((key) => !stringKeys.includes(key))) return false

  return declared.every((question, index) => {
    const key = keys[index] as string
    if (!Object.hasOwn(decision.answers, key)) return true
    if (!decision.answers[key]!.trim()) return false
    const annotation = decision.annotations?.[key]
    if (annotation?.notes !== undefined && !annotation.notes.trim()) return false
    if (annotation?.preview === undefined || question?.multiSelect === true) return true

    const options = Array.isArray(question?.options) ? question.options.map(record) : []
    const selected = options.filter((option) => option?.label === decision.answers[key])
    return selected.length !== 1 || selected[0]?.preview === annotation.preview
  })
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []

  push(value: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.values.push(value)
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length > 0) return Promise.resolve({ value: this.values.shift() as T, done: false })
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

type LiveSessionState = 'idle' | 'running' | 'requires_action'

type PendingToolApproval = {
  request: ToolApprovalRequest
  resolve: (result: PermissionResult) => void
}

type SessionRuntime = {
  projectId: string
  sessionId: string
  query: Query
  input: AsyncQueue<SDKUserMessage>
  permissionMode: PermissionMode
  model?: ModelSelection | DefaultTurnOption
  effort?: EffortLevel | null
  currentUserMessageUuid: string | null
  slashSubmissionUuid: string | null
  liveBackgroundTasks: LiveBackgroundTask[]
  pendingToolApprovals: Map<string, PendingToolApproval>
  startingTurnToken: symbol | null
  stale: boolean
  rebuildingAfterCliIdle: boolean
  ready: Promise<void>
  initializationResult: unknown | null
  contextUsage: SessionContextUsage | null
  contextUsageRefresh: Promise<void> | null
  closed: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
}

type RuntimeOptions = { projectId?: string; sessionId: string; permissionMode: PermissionMode; model?: ModelSelection | DefaultTurnOption; effort?: EffortLevel | null }

function liveSessionStateFromSdkMessage(message: SDKMessage): LiveSessionState | null {
  if (message.type !== 'system' || !('subtype' in message) || message.subtype !== 'session_state_changed') return null
  if (!('state' in message) || typeof message.state !== 'string') return null
  return message.state === 'idle' || message.state === 'running' || message.state === 'requires_action' ? message.state : null
}

export type LiveTurnEvent = SDKMessage | CottaLiveTurnFailedEvent | CottaRunStateChangedEvent
export type LiveTurnSubscriber = (event: LiveTurnEvent) => void

export class LiveTurnManager {
  private readonly subscribers = new Map<string, Set<LiveTurnSubscriber>>()
  private readonly runtimes = new Map<string, SessionRuntime>()
  private readonly runStateBySession = new Map<string, SessionRunState>()
  private readonly runtimeTurnProjectionBySession = new Map<string, Map<string, RuntimeTurnProjection>>()
  private readonly runStateVersions = new Map<string, number>()
  private readonly externalOwnerCloses = new Map<string, Promise<boolean>>()
  private readonly externalOwnerGenerations = new Map<string, number>()
  private readonly rebuildAfterExternalOwnerGenerations = new Map<string, number>()
  private readonly lifecycleTails = new Map<string, Promise<unknown>>()

  constructor(
    private readonly sessionActivityObserver?: SessionActivityObserver,
    private readonly liveMetadataRecorder?: LiveTurnMetadataRecorder,
    private readonly contextUsageStore?: SessionContextUsageStore,
    private readonly settingsStore?: SettingsStore,
    private readonly externalOwnershipReader?: (sessionId: string) => unknown | null,
    private readonly prePlanPermissionModeReader?: (sessionId: string) => PermissionMode | null,
    private readonly providerEnv?: (sessionId: string) => Promise<Record<string, string>>,
  ) {}

  private async resolveProviderEnv(sessionId: string): Promise<Record<string, string>> {
    return this.providerEnv ? await this.providerEnv(sessionId) : {}
  }

  sessionRunState(sessionId: string): SessionRunState | null {
    return this.runStateBySession.get(sessionId) ?? null
  }

  sessionRunStateVersion(sessionId: string): number {
    return this.runStateVersions.get(sessionId) ?? 0
  }

  hasRuntime(sessionId: string): boolean {
    const runtime = this.runtimes.get(sessionId)
    return !!runtime && !runtime.closed && !runtime.stale
  }

  async restartRuntime(input: {
    projectId: string
    sessionId: string
    permissionMode: PermissionMode
    model?: ModelSelection | DefaultTurnOption
    effort?: EffortLevel | null
    rebuild: boolean
  }): Promise<boolean> {
    return this.serializeLifecycle(input.sessionId, async () => {
      if (!this.hasRuntime(input.sessionId)) return false
      await this.closeForExternalOwnerInternal(input.sessionId, 'Session was interrupted because its runtime was restarted.', { rebuildAfterCliIdle: false })
      if (!input.rebuild) return false
      return (await this.ensureRuntimeInternalPublic(input)) !== null
    })
  }

  liveBackgroundTasks(sessionId: string): readonly LiveBackgroundTask[] | null {
    const runtime = this.runtimes.get(sessionId)
    return runtime && !runtime.closed && !runtime.stale ? runtime.liveBackgroundTasks.filter((task) => task.ambient !== true) : null
  }

  runtimeTurnProjection(sessionId: string, submissionUuid?: string): RuntimeTurnProjection | null {
    const targetUuid = submissionUuid ?? this.runStateBySession.get(sessionId)?.lastTurn?.id
    return targetUuid ? (this.runtimeTurnProjectionBySession.get(sessionId)?.get(targetUuid) ?? null) : null
  }

  clearRuntimeTurnProjection(sessionId: string): void {
    this.runtimeTurnProjectionBySession.delete(sessionId)
  }

  acknowledgeCompletedTurn(input: { projectId: string; sessionId: string; turnId: string }): boolean {
    const state = this.runStateBySession.get(input.sessionId)
    if (state?.phase !== 'idle' || state.lastTurn?.id !== input.turnId) return false
    this.setRunState(input, { phase: 'idle', activeUserMessageUuid: null })
    return true
  }

  async contextUsage(sessionId: string, refresh = false): Promise<SessionContextUsage | null> {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime || runtime.closed || runtime.stale) return null
    await runtime.ready
    if (refresh) this.refreshContextUsage(runtime)
    while (runtime.contextUsageRefresh) await runtime.contextUsageRefresh
    return this.runtimes.get(sessionId) === runtime && !runtime.closed && !runtime.stale ? runtime.contextUsage : null
  }

  respondToPermission(sessionId: string, requestId: string, decision: ToolApprovalDecisionRequest): { status: 'answered' } | { status: 'invalid_update' } | null {
    const runtime = this.runtimes.get(sessionId)
    const pending = runtime?.pendingToolApprovals.get(requestId)
    if (!runtime || runtime.stale || !pending || pending.request.toolName === 'AskUserQuestion') return null
    const updatedPermissions =
      decision.decision === 'allow_suggestion'
        ? pending.request.toolName === 'ExitPlanMode'
          ? [{ type: 'setMode', mode: 'default', destination: 'session' } as PermissionUpdate]
          : (pending.request.suggestions?.slice(0, 1) as PermissionUpdate[] | undefined)
        : undefined
    if (decision.decision === 'allow_suggestion' && !updatedPermissions?.length) return { status: 'invalid_update' }
    runtime.pendingToolApprovals.delete(requestId)
    const toolUseID = pending.request.toolUseID
    pending.resolve(
      decision.decision !== 'deny'
        ? { behavior: 'allow', toolUseID, ...(updatedPermissions ? { updatedPermissions } : {}) }
        : { behavior: 'deny', message: permissionDenyMessage(pending.request.toolName, decision.message), toolUseID },
    )
    if (runtime.currentUserMessageUuid && !runtime.closed && !runtime.stale) this.setPendingOrRunningState(runtime)
    return { status: 'answered' }
  }

  respondToQuestion(sessionId: string, requestId: string, decision: AskUserQuestionDecisionRequest): { status: 'answered' } | null {
    const runtime = this.runtimes.get(sessionId)
    const pending = runtime?.pendingToolApprovals.get(requestId)
    if (!runtime || runtime.stale || !pending || pending.request.toolName !== 'AskUserQuestion' || decision.toolUseID !== pending.request.toolUseID) return null
    if (decision.behavior === 'completed' && !questionDecisionMatchesInput(pending.request.input, decision)) return null
    runtime.pendingToolApprovals.delete(requestId)
    const toolUseID = pending.request.toolUseID
    pending.resolve(
      decision.behavior === 'completed'
        ? { behavior: 'allow', toolUseID, updatedInput: { ...pending.request.input, answers: decision.answers, ...(decision.annotations ? { annotations: decision.annotations } : {}) } }
        : { behavior: 'deny', message: 'User declined to answer questions.', toolUseID },
    )
    if (runtime.currentUserMessageUuid && !runtime.closed && !runtime.stale) this.setPendingOrRunningState(runtime)
    return { status: 'answered' }
  }

  close(sessionId: string): boolean {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return false
    this.closeRuntime(runtime)
    return true
  }

  closeForExternalOwner(
    sessionId: string,
    errorMessage = 'Session was interrupted because it was taken over by Claude Code CLI/background agent.',
    options: { rebuildAfterCliIdle?: boolean } = {},
  ): Promise<boolean> {
    return this.closeForExternalOwnerInternal(sessionId, errorMessage, options)
  }

  private closeForExternalOwnerInternal(
    sessionId: string,
    errorMessage = 'Session was interrupted because it was taken over by Claude Code CLI/background agent.',
    options: { rebuildAfterCliIdle?: boolean } = {},
  ): Promise<boolean> {
    const pending = this.externalOwnerCloses.get(sessionId)
    const runtime = this.runtimes.get(sessionId)
    const previousGeneration = this.externalOwnerGenerations.get(sessionId)
    if (pending) {
      if (options.rebuildAfterCliIdle !== false) return pending
      this.rebuildAfterExternalOwnerGenerations.delete(sessionId)
      return previousGeneration === undefined ? pending : pending.finally(() => this.clearExternalOwnerGeneration(sessionId, previousGeneration))
    }
    if (!runtime) {
      if (options.rebuildAfterCliIdle === false && previousGeneration !== undefined) this.clearExternalOwnerGeneration(sessionId, previousGeneration)
      return Promise.resolve(false)
    }
    const generation = (previousGeneration ?? 0) + 1
    this.externalOwnerGenerations.set(sessionId, generation)
    if (options.rebuildAfterCliIdle === false) this.rebuildAfterExternalOwnerGenerations.delete(sessionId)
    else this.rebuildAfterExternalOwnerGenerations.set(sessionId, generation)
    runtime.stale = true
    const closing = (async () => {
      if (runtime.currentUserMessageUuid !== null) {
        const userMessageUuid = runtime.currentUserMessageUuid
        try {
          await runtime.query.interrupt()
        } catch (error) {
          console.error('live-runtime:external-owner interrupt failed', error)
        }
        if (runtime.currentUserMessageUuid === userMessageUuid) {
          this.finishTurn(runtime, userMessageUuid, 'error')
          this.publish(
            runtime,
            cottaLiveTurnFailed({
              error: errorMessage,
              sessionId: runtime.sessionId,
            }),
          )
          runtime.currentUserMessageUuid = null
        }
      }
      runtime.startingTurnToken = null
      runtime.stale = true
      this.closeRuntime(runtime)
      return true
    })()
    this.externalOwnerCloses.set(sessionId, closing)
    const clearClosing = () => {
      if (this.externalOwnerCloses.get(sessionId) === closing) this.externalOwnerCloses.delete(sessionId)
    }
    void closing.then(clearClosing, clearClosing)
    return options.rebuildAfterCliIdle === false ? closing.finally(() => this.clearExternalOwnerGeneration(sessionId, generation)) : closing
  }

  closeAll(): void {
    this.externalOwnerCloses.clear()
    this.externalOwnerGenerations.clear()
    this.rebuildAfterExternalOwnerGenerations.clear()
    for (const runtime of Array.from(this.runtimes.values())) this.closeRuntime(runtime)
  }

  subscribe(sessionId: string, subscriber: LiveTurnSubscriber): () => void {
    const set = this.subscribers.get(sessionId) ?? new Set<LiveTurnSubscriber>()
    set.add(subscriber)
    this.subscribers.set(sessionId, set)
    return () => {
      set.delete(subscriber)
      if (set.size === 0) this.subscribers.delete(sessionId)
    }
  }

  private serializeLifecycle<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTails.get(sessionId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.lifecycleTails.set(sessionId, current)
    void current
      .finally(() => {
        if (this.lifecycleTails.get(sessionId) === current) this.lifecycleTails.delete(sessionId)
      })
      .catch(() => undefined)
    return current
  }

  private signalRuntimeChange(runtime: Pick<SessionRuntime, 'sessionId' | 'projectId'>): void {
    const version = (this.runStateVersions.get(runtime.sessionId) ?? 0) + 1
    this.runStateVersions.set(runtime.sessionId, version)
    Promise.resolve()
      .then(() => this.sessionActivityObserver?.notifySessionRunStateActive?.({ sessionId: runtime.sessionId, projectId: runtime.projectId, version }))
      .catch((error) => {
        console.error('session-activity:run-state change failed', error)
      })
  }

  private setRunState(runtime: Pick<SessionRuntime, 'sessionId' | 'projectId'>, state: SessionRunState): void {
    const previous = this.runStateBySession.get(runtime.sessionId)
    this.runStateBySession.set(runtime.sessionId, state)
    this.signalRuntimeChange(runtime)
    // Entering/leaving requires_action, or swapping to the next pending approval while still in requires_action
    // (parallel tool calls surface one at a time), has no accompanying SDK message, so notify subscribers
    // explicitly; they re-read the authoritative run state rather than trusting an event body.
    const previousPending = previous?.phase === 'requires_action' ? previous.pendingPermission?.requestId : undefined
    const nextPending = state.phase === 'requires_action' ? state.pendingPermission?.requestId : undefined
    if (previousPending !== nextPending) this.notifySubscribers(runtime.sessionId, { type: 'cotta_run_state_changed', session_id: runtime.sessionId })
  }

  private notifySubscribers(sessionId: string, event: LiveTurnEvent): void {
    for (const subscriber of this.subscribers.get(sessionId) ?? []) {
      try {
        subscriber(event)
      } catch (error) {
        console.error('live-runtime:subscriber failed', error)
      }
    }
  }

  private denyPendingToolApprovals(runtime: SessionRuntime, message: string): void {
    for (const [requestId, pending] of runtime.pendingToolApprovals) {
      runtime.pendingToolApprovals.delete(requestId)
      pending.resolve({ behavior: 'deny', message, toolUseID: pending.request.toolUseID })
    }
  }

  private setPendingOrRunningState(runtime: SessionRuntime): void {
    const pendingPermission = runtime.pendingToolApprovals.values().next().value?.request
    if (pendingPermission && runtime.currentUserMessageUuid)
      this.setRunState(runtime, { phase: 'requires_action', activeUserMessageUuid: runtime.currentUserMessageUuid, lastTurn: null, pendingPermission })
    else if (runtime.currentUserMessageUuid) this.setRunState(runtime, { phase: 'running', activeUserMessageUuid: runtime.currentUserMessageUuid, lastTurn: null })
  }

  private requestPermission(runtime: SessionRuntime, request: ToolApprovalRequest, signal: AbortSignal): Promise<PermissionResult> {
    return new Promise((resolve) => {
      const pending: PendingToolApproval = { request, resolve }
      const cleanup = () => {
        if (runtime.pendingToolApprovals.get(request.requestId) !== pending) return
        runtime.pendingToolApprovals.delete(request.requestId)
        resolve({ behavior: 'deny', message: 'Permission request was cancelled.', toolUseID: request.toolUseID })
        if (this.runtimes.get(runtime.sessionId) === runtime && runtime.currentUserMessageUuid && !runtime.closed && !runtime.stale) this.setPendingOrRunningState(runtime)
      }
      runtime.pendingToolApprovals.set(request.requestId, pending)
      if (signal.aborted) cleanup()
      else signal.addEventListener('abort', cleanup, { once: true })
      this.setPendingOrRunningState(runtime)
    })
  }

  private clearIdleTimer(runtime: SessionRuntime): void {
    if (!runtime.idleTimer) return
    clearTimeout(runtime.idleTimer)
    runtime.idleTimer = null
  }

  private scheduleIdleClose(runtime: SessionRuntime): void {
    this.clearIdleTimer(runtime)
    if (runtime.closed || runtime.currentUserMessageUuid || runtime.liveBackgroundTasks.length > 0) return
    runtime.idleTimer = setTimeout(() => {
      if (this.runtimes.get(runtime.sessionId) === runtime && !runtime.currentUserMessageUuid && runtime.liveBackgroundTasks.length === 0 && !runtime.closed) this.closeRuntime(runtime)
    }, IDLE_RUNTIME_TTL_MS)
    runtime.idleTimer.unref?.()
  }

  private clearExternalOwnerGeneration(sessionId: string, generation: number): void {
    if (this.externalOwnerGenerations.get(sessionId) === generation) this.externalOwnerGenerations.delete(sessionId)
    if (this.rebuildAfterExternalOwnerGenerations.get(sessionId) === generation) this.rebuildAfterExternalOwnerGenerations.delete(sessionId)
  }

  private closeRuntime(runtime: SessionRuntime): void {
    if (runtime.closed) return
    runtime.closed = true
    const hadPendingApprovals = runtime.pendingToolApprovals.size > 0
    const hadBackgroundTasks = runtime.liveBackgroundTasks.length > 0
    this.denyPendingToolApprovals(runtime, 'Session closed before permission was answered.')
    if (hadPendingApprovals) this.setRunState(runtime, { phase: 'idle', activeUserMessageUuid: null })
    this.clearIdleTimer(runtime)
    const removedCurrentRuntime = this.runtimes.get(runtime.sessionId) === runtime
    if (removedCurrentRuntime) this.runtimes.delete(runtime.sessionId)
    // A stale runtime is mid external-owner handoff / CLI-idle rebuild, which still reads these counters;
    // a normal close (idle timeout, explicit close, drained stream) is done, so drop its per-session entries.
    if (!runtime.stale) {
      this.externalOwnerGenerations.delete(runtime.sessionId)
      this.rebuildAfterExternalOwnerGenerations.delete(runtime.sessionId)
    }
    if (removedCurrentRuntime || hadBackgroundTasks) this.signalRuntimeChange(runtime)
    try {
      runtime.query.close()
    } catch (error) {
      console.error('live-runtime:close failed', error)
    }
  }

  private finishTurn(runtime: SessionRuntime, userMessageUuid: string, outcome: 'success' | 'error'): void {
    if (runtime.slashSubmissionUuid === userMessageUuid) {
      const projections = this.runtimeTurnProjectionBySession.get(runtime.sessionId) ?? new Map<string, RuntimeTurnProjection>()
      if (!projections.has(userMessageUuid)) projections.set(userMessageUuid, { submissionUuid: userMessageUuid, kind: 'terminal-only' })
      this.runtimeTurnProjectionBySession.set(runtime.sessionId, projections)
    }
    this.setRunState(runtime, {
      phase: 'idle',
      activeUserMessageUuid: null,
      lastTurn: { id: userMessageUuid, outcome },
    })
  }

  private captureRuntimeTurnProjection(runtime: SessionRuntime, message: SDKMessage, submissionUuid: string): void {
    if (runtime.slashSubmissionUuid !== submissionUuid) return
    const value = record(message)
    if (!value || !isMainSessionMessage(value)) return
    let projection: Extract<RuntimeTurnProjection, { kind: 'visible' }>
    if (value.type === 'user' && value.uuid === submissionUuid) projection = { submissionUuid, kind: 'visible', visibleTurnUuid: submissionUuid }
    else {
      if (value.type !== 'assistant' || typeof value.uuid !== 'string' || !timelineLocalCommand(value)) return
      const boundUuids = [value.user_message_uuid, ...(Array.isArray(value.user_message_uuids) ? value.user_message_uuids : [])].filter((uuid): uuid is string => typeof uuid === 'string')
      if (boundUuids.length > 0 && !boundUuids.includes(submissionUuid)) return
      projection = { submissionUuid, kind: 'visible', visibleTurnUuid: value.uuid }
    }
    const projections = this.runtimeTurnProjectionBySession.get(runtime.sessionId) ?? new Map<string, RuntimeTurnProjection>()
    const existing = projections.get(submissionUuid)
    if (existing) {
      if (existing.kind === 'visible' && existing.visibleTurnUuid !== projection.visibleTurnUuid)
        console.warn('live-runtime:conflicting turn projection', {
          sessionId: runtime.sessionId,
          submissionUuid,
          existingVisibleTurnUuid: existing.visibleTurnUuid,
          visibleTurnUuid: projection.visibleTurnUuid,
        })
      return
    }
    projections.set(submissionUuid, projection)
    this.runtimeTurnProjectionBySession.set(runtime.sessionId, projections)
  }

  private async finalizeContextUsage(runtime: SessionRuntime): Promise<void> {
    while (runtime.contextUsageRefresh) await runtime.contextUsageRefresh
    if (!this.isCurrentRuntime(runtime)) return
    this.refreshContextUsage(runtime)
    await runtime.contextUsageRefresh
  }

  private refreshContextUsage(runtime: SessionRuntime): void {
    if (runtime.contextUsageRefresh) return
    const refresh = runtime.query
      .getContextUsage({ detail: 'summary' })
      .then((usage: SDKControlGetContextUsageResponse) => {
        if (this.runtimes.get(runtime.sessionId) !== runtime || runtime.closed || runtime.stale) return
        const updatedAtMs = Date.now()
        runtime.contextUsage = {
          model: usage.model ?? null,
          categories: usage.categories.map(({ name, tokens, kind, isDeferred }) => ({ name, tokens, kind, ...(isDeferred !== undefined ? { isDeferred } : {}) })),
          totalTokens: usage.totalTokens,
          autoCompactThreshold: usage.autoCompactThreshold ?? null,
          maxTokens: usage.maxTokens,
          percentage: usage.percentage,
          updatedAtMs,
        }
        try {
          this.contextUsageStore?.setContextUsage(runtime.sessionId, runtime.contextUsage, updatedAtMs)
        } catch (error) {
          console.error('live-runtime:context usage persist failed', error)
        }
      })
      .catch((error) => {
        if (!runtime.closed && !runtime.stale && this.runtimes.get(runtime.sessionId) === runtime) {
          console.error('live-runtime:context usage refresh failed', error)
        }
      })
      .finally(() => {
        if (runtime.contextUsageRefresh === refresh) runtime.contextUsageRefresh = null
      })
    runtime.contextUsageRefresh = refresh
  }

  async ensureRuntime(input: {
    projectId: string
    sessionId: string
    permissionMode?: PermissionMode
    model?: ModelSelection | DefaultTurnOption
    effort?: EffortLevel | null
  }): Promise<unknown | null> {
    return this.serializeLifecycle(input.sessionId, () => this.ensureRuntimeInternalPublic(input))
  }

  private async ensureRuntimeInternalPublic(input: {
    projectId: string
    sessionId: string
    permissionMode?: PermissionMode
    model?: ModelSelection | DefaultTurnOption
    effort?: EffortLevel | null
  }): Promise<unknown | null> {
    const options = { ...input, permissionMode: input.permissionMode ?? 'default' }
    const runtime = await this.ensureRuntimeInternal({ ...options, resume: true, recreateClosed: false })
    if (runtime.closed || runtime.stale || this.runtimes.get(input.sessionId) !== runtime) return null
    await this.alignRuntimeOptions(runtime, options)
    return runtime.closed || runtime.stale || this.runtimes.get(input.sessionId) !== runtime ? null : runtime.initializationResult
  }

  async syncExistingRuntimeOptions(input: RuntimeOptions): Promise<boolean> {
    const runtime = this.runtimes.get(input.sessionId)
    if (!runtime || (input.projectId && runtime.projectId !== input.projectId) || runtime.closed || runtime.stale) return false
    await runtime.ready
    if (this.runtimes.get(input.sessionId) !== runtime || runtime.closed || runtime.stale) return false
    await this.alignRuntimeOptions(runtime, input)
    return this.runtimes.get(input.sessionId) === runtime && !runtime.closed && !runtime.stale
  }

  async rebuildRuntimeAfterCliIdle(input: {
    projectId: string
    sessionId: string
    permissionMode: PermissionMode
    model: ModelSelection | DefaultTurnOption
    effort: EffortLevel | null
    hasCliOwnership: () => boolean
  }): Promise<boolean> {
    return this.serializeLifecycle(input.sessionId, () => this.rebuildRuntimeAfterCliIdleInternal(input))
  }

  private async rebuildRuntimeAfterCliIdleInternal(input: {
    projectId: string
    sessionId: string
    permissionMode: PermissionMode
    model: ModelSelection | DefaultTurnOption
    effort: EffortLevel | null
    hasCliOwnership: () => boolean
  }): Promise<boolean> {
    const externalOwnerGeneration = this.externalOwnerGenerations.get(input.sessionId) ?? 0
    if (this.rebuildAfterExternalOwnerGenerations.get(input.sessionId) !== externalOwnerGeneration || input.hasCliOwnership()) return false
    const externalOwnerGenerationCurrent = () => (this.externalOwnerGenerations.get(input.sessionId) ?? 0) === externalOwnerGeneration && !input.hasCliOwnership()
    try {
      await this.requireProjectDirectory(input.projectId)
      await this.externalOwnerCloses.get(input.sessionId)
      if (!externalOwnerGenerationCurrent()) return false
      const current = this.runtimes.get(input.sessionId)
      if (current && current.projectId !== input.projectId) {
        if (current.currentUserMessageUuid || current.startingTurnToken) throw new SessionProjectMismatchError('Session runtime project mismatch')
        current.stale = true
        this.closeRuntime(current)
      } else if (current?.rebuildingAfterCliIdle) {
        await current.ready
        if (!externalOwnerGenerationCurrent()) {
          current.stale = true
          this.closeRuntime(current)
          return false
        }
        return this.isCurrentRuntime(current)
      } else if (current?.currentUserMessageUuid || current?.startingTurnToken) return false
      else if (current) {
        current.stale = true
        this.closeRuntime(current)
      }
      const replacement = this.createRuntime({ ...input, resume: true }, await this.resolveProviderEnv(input.sessionId))
      replacement.rebuildingAfterCliIdle = true
      try {
        await replacement.ready
        if (!externalOwnerGenerationCurrent()) {
          replacement.stale = true
          this.closeRuntime(replacement)
          return false
        }
        return this.isCurrentRuntime(replacement)
      } catch (error) {
        if (!externalOwnerGenerationCurrent()) return false
        throw error
      } finally {
        replacement.rebuildingAfterCliIdle = false
      }
    } finally {
      if (!input.hasCliOwnership()) this.clearExternalOwnerGeneration(input.sessionId, externalOwnerGeneration)
    }
  }

  async startTurn(input: {
    projectId: string
    sessionId: string
    resume: boolean
    text?: string
    images?: ComposerImage[]
    userMessageUuid: string
    permissionMode: PermissionMode
    model?: ModelSelection | DefaultTurnOption
    effort?: EffortLevel | null
  }): Promise<{ sessionId: string; userMessageUuid: string }> {
    return this.serializeLifecycle(input.sessionId, () => this.startTurnInternal(input))
  }

  private async startTurnInternal(input: {
    projectId: string
    sessionId: string
    resume: boolean
    text?: string
    images?: ComposerImage[]
    userMessageUuid: string
    permissionMode: PermissionMode
    model?: ModelSelection | DefaultTurnOption
    effort?: EffortLevel | null
  }): Promise<{ sessionId: string; userMessageUuid: string }> {
    const sessionId = input.sessionId
    if (this.externalOwnershipReader?.(sessionId) != null) throw new SessionExternallyOwnedError('Session is externally owned')
    const runtime = await this.ensureRuntimeInternal({ projectId: input.projectId, sessionId, resume: input.resume, permissionMode: input.permissionMode, model: input.model, effort: input.effort })
    if (runtime.currentUserMessageUuid || runtime.startingTurnToken) throw new SessionTurnInProgressError('Session already has a running generation')
    const startingTurnToken = Symbol('starting-turn')
    runtime.startingTurnToken = startingTurnToken
    this.clearIdleTimer(runtime)
    try {
      await this.alignRuntimeOptions(runtime, input)
      if (this.externalOwnershipReader?.(sessionId) != null) throw new SessionExternallyOwnedError('Session is externally owned')

      const userMessageUuid = input.userMessageUuid as NonNullable<SDKUserMessage['uuid']>
      const userMessage = sdkUserMessage({ uuid: userMessageUuid, text: input.text, images: input.images, sessionId, startedAt: Date.now() })
      runtime.slashSubmissionUuid = input.text && isSlashLookingInput(input.text) ? userMessageUuid : null
      runtime.currentUserMessageUuid = userMessageUuid
      runtime.startingTurnToken = null
      this.setRunState(runtime, { phase: 'running', activeUserMessageUuid: userMessageUuid, lastTurn: null })
      this.signalSessionActivity(runtime)
      runtime.input.push(userMessage)

      return { sessionId, userMessageUuid }
    } finally {
      if (runtime.startingTurnToken === startingTurnToken) {
        runtime.startingTurnToken = null
        this.scheduleIdleClose(runtime)
      }
    }
  }

  async interrupt(sessionId: string): Promise<boolean> {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime?.currentUserMessageUuid || runtime.closed || runtime.stale) return false
    await runtime.query.interrupt()
    return true
  }

  private async requireProjectDirectory(projectId: string): Promise<void> {
    const projectPath = projectPathFromId(projectId)
    if (
      !projectPath ||
      !(await stat(projectPath).then(
        (info) => info.isDirectory(),
        () => false,
      ))
    )
      throw new ProjectDirectoryUnavailableError('Project directory is unavailable')
  }

  private transitionPermissionMode(runtime: SessionRuntime, permissionMode: PermissionMode): PermissionMode | null {
    if (runtime.permissionMode === permissionMode) return null
    const previousMode = runtime.permissionMode
    runtime.permissionMode = permissionMode
    return previousMode
  }

  private async recordPermissionMode(runtime: SessionRuntime, permissionMode: PermissionMode, observedAtMs = Date.now()): Promise<void> {
    const previousMode = this.transitionPermissionMode(runtime, permissionMode)
    if (!previousMode) return
    await this.sessionActivityObserver?.onPermissionModeChanged?.({ sessionId: runtime.sessionId, projectId: runtime.projectId, mode: permissionMode, previousMode, observedAtMs })
  }

  private async alignRuntimeOptions(runtime: SessionRuntime, input: RuntimeOptions): Promise<void> {
    if (runtime.permissionMode !== input.permissionMode) {
      await runtime.query.setPermissionMode(input.permissionMode)
      this.transitionPermissionMode(runtime, input.permissionMode)
    }
    const flagSettings: { model?: ModelSelection | DefaultTurnOption; effortLevel?: EffortLevel | null } = {}
    if (input.model !== undefined && runtime.model !== input.model) flagSettings.model = input.model
    if (input.effort !== undefined && runtime.effort !== input.effort) flagSettings.effortLevel = input.effort
    if (Object.keys(flagSettings).length === 0) return
    await runtime.query.applyFlagSettings(flagSettings)
    if ('model' in flagSettings) runtime.model = input.model
    if ('effortLevel' in flagSettings) runtime.effort = input.effort
  }

  private async ensureRuntimeInternal(input: {
    projectId: string
    sessionId: string
    resume: boolean
    permissionMode: PermissionMode
    model?: ModelSelection | DefaultTurnOption
    effort?: EffortLevel | null
    recreateClosed?: boolean
  }): Promise<SessionRuntime> {
    await this.requireProjectDirectory(input.projectId)
    for (;;) {
      let runtime = this.runtimes.get(input.sessionId)
      if (runtime && runtime.projectId !== input.projectId) {
        if (runtime.currentUserMessageUuid || runtime.startingTurnToken) throw new SessionProjectMismatchError('Session runtime project mismatch')
        runtime.stale = true
        this.closeRuntime(runtime)
        runtime = undefined
      }
      runtime ??= this.createRuntime(input, await this.resolveProviderEnv(input.sessionId))
      await runtime.ready
      const current = this.runtimes.get(input.sessionId)
      if (current === runtime && !runtime.stale && !runtime.closed) return runtime
      if (current && current.projectId !== input.projectId) throw new SessionProjectMismatchError('Session runtime project mismatch')
      if (input.recreateClosed === false) return runtime
    }
  }

  private createRuntime(
    input: {
      projectId: string
      sessionId: string
      resume: boolean
      permissionMode: PermissionMode
      model?: ModelSelection | DefaultTurnOption
      effort?: EffortLevel | null
    },
    providerEnv: Record<string, string>,
  ): SessionRuntime {
    const projectPath = projectPathFromId(input.projectId)
    if (!projectPath) throw new Error('Invalid project id')
    const autoCompactPercent = readSettings(this.settingsStore).autoCompactPercent
    // Claude Code only records the mode to restore on ExitPlanMode when it transitions into plan, so a plan
    // runtime is launched in the recorded pre-plan mode and switched to plan before it accepts any input.
    const launchPermissionMode = (input.permissionMode === 'plan' ? this.prePlanPermissionModeReader?.(input.sessionId) : null) ?? input.permissionMode
    const runtimeInput = new AsyncQueue<SDKUserMessage>()
    let runtime!: SessionRuntime
    const sdkQuery = query({
      prompt: runtimeInput,
      options: {
        cwd: projectPath,
        ...(input.resume ? { resume: input.sessionId } : { sessionId: input.sessionId }),
        includePartialMessages: true,
        permissionMode: launchPermissionMode,
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        env: {
          ...process.env,
          CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
          ...(autoCompactPercent === undefined ? {} : { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(autoCompactPercent) }),
          // Provider env last so it can point the CLI at a gateway (ANTHROPIC_BASE_URL/AUTH_TOKEN). Empty when no provider.
          ...providerEnv,
        },
        allowDangerouslySkipPermissions: true,
        canUseTool: (toolName, toolInput, options) => {
          const suggestions = toolName === 'ExitPlanMode' ? [] : (options.suggestions?.slice(0, 1) ?? [])
          return this.requestPermission(
            runtime,
            {
              requestId: options.requestId,
              toolUseID: options.toolUseID,
              toolName,
              input: toolInput,
              ...(options.title ? { title: options.title } : {}),
              ...(options.displayName ? { displayName: options.displayName } : {}),
              ...(options.description ? { description: options.description } : {}),
              ...(suggestions.length > 0 ? { suggestions } : {}),
            },
            options.signal,
          )
        },
      },
    })
    runtime = {
      projectId: input.projectId,
      sessionId: input.sessionId,
      input: runtimeInput,
      query: sdkQuery,
      permissionMode: launchPermissionMode,
      model: input.model,
      effort: input.effort,
      currentUserMessageUuid: null,
      slashSubmissionUuid: null,
      liveBackgroundTasks: [],
      pendingToolApprovals: new Map(),
      startingTurnToken: null,
      stale: false,
      rebuildingAfterCliIdle: false,
      ready: Promise.resolve(),
      initializationResult: null,
      contextUsage: this.contextUsageStore?.getContextUsage(input.sessionId) ?? null,
      contextUsageRefresh: null,
      closed: false,
      idleTimer: null,
    }
    runtime.ready = sdkQuery
      .initializationResult()
      .then(async (result) => {
        runtime.initializationResult = result
        if (runtime.permissionMode !== input.permissionMode) {
          await sdkQuery.setPermissionMode(input.permissionMode)
          await this.recordPermissionMode(runtime, input.permissionMode)
        }
        if (input.resume) this.refreshContextUsage(runtime)
      })
      .catch((error: unknown) => {
        if (runtime.closed || runtime.stale) return
        runtime.stale = true
        this.closeRuntime(runtime)
        throw error
      })
    this.runtimes.set(input.sessionId, runtime)
    this.signalRuntimeChange(runtime)
    this.scheduleIdleClose(runtime)
    void this.drainRuntime(runtime)
    return runtime
  }

  private isCurrentRuntime(runtime: SessionRuntime): boolean {
    return this.runtimes.get(runtime.sessionId) === runtime && !runtime.closed && !runtime.stale
  }

  private async drainRuntime(runtime: SessionRuntime): Promise<void> {
    try {
      for await (const message of runtime.query) {
        if (!this.isCurrentRuntime(runtime)) break
        // applyFlagSettings echoes "Set model to …" as an isReplay user message that never reaches the transcript.
        if (message.type === 'user' && 'isReplay' in message && message.isReplay) continue
        const liveState = liveSessionStateFromSdkMessage(message)
        if (liveState && liveState !== 'idle' && runtime.currentUserMessageUuid) this.setPendingOrRunningState(runtime)

        const userMessageUuid = runtime.currentUserMessageUuid
        const messageValue = record(message)
        const publishedMessage =
          userMessageUuid &&
          message.type === 'assistant' &&
          messageValue &&
          isMainSessionMessage(messageValue) &&
          timelineLocalCommand(message) &&
          !('user_message_uuid' in message) &&
          !('user_message_uuids' in message)
            ? ({ ...message, user_message_uuid: userMessageUuid } as SDKMessage)
            : message
        if (userMessageUuid) this.captureRuntimeTurnProjection(runtime, publishedMessage, userMessageUuid)
        if (publishedMessage.type === 'result' && userMessageUuid) {
          try {
            this.liveMetadataRecorder?.recordLiveResult(runtime.projectId, runtime.sessionId, userMessageUuid, publishedMessage)
          } catch (error) {
            console.error('live-result:record failed', error)
          }
        }

        const permissionMode = sdkPermissionMode(publishedMessage)
        if (permissionMode) {
          await this.recordPermissionMode(runtime, permissionMode)
          if (!this.isCurrentRuntime(runtime)) break
        }

        if (publishedMessage.type === 'result' && userMessageUuid) {
          await this.finalizeContextUsage(runtime)
          if (!this.isCurrentRuntime(runtime)) break
          this.finishTurn(runtime, userMessageUuid, publishedMessage.subtype === 'success' ? 'success' : 'error')
          runtime.currentUserMessageUuid = null
          this.scheduleIdleClose(runtime)
        }
        this.publish(runtime, publishedMessage)
        if (publishedMessage.type === 'assistant' && userMessageUuid) this.refreshContextUsage(runtime)
        if (!userMessageUuid) continue
      }
      if (this.isCurrentRuntime(runtime) && runtime.currentUserMessageUuid) {
        const userMessageUuid = runtime.currentUserMessageUuid
        this.finishTurn(runtime, userMessageUuid, 'error')
        this.publish(
          runtime,
          cottaLiveTurnFailed({
            error: 'SDK stream ended before the turn completed.',
            sessionId: runtime.sessionId,
          }),
        )
      }
    } catch (error) {
      console.error('live-runtime:drain failed', error)
      if (this.isCurrentRuntime(runtime) && runtime.currentUserMessageUuid) {
        const userMessageUuid = runtime.currentUserMessageUuid
        this.finishTurn(runtime, userMessageUuid, 'error')
        this.publish(
          runtime,
          cottaLiveTurnFailed({
            error: error instanceof Error ? error.message : String(error),
            sessionId: runtime.sessionId,
          }),
        )
      }
    } finally {
      runtime.currentUserMessageUuid = null
      if (runtime.liveBackgroundTasks.length === 0) this.closeRuntime(runtime)
      else this.scheduleIdleClose(runtime)
    }
  }

  private signalSessionActivity(runtime: SessionRuntime): void {
    Promise.resolve()
      .then(() => this.sessionActivityObserver?.signalSessionActivity?.({ sessionId: runtime.sessionId, projectId: runtime.projectId }))
      .catch((error) => {
        console.error('session-activity:signal failed', error)
      })
  }

  private publish(runtime: SessionRuntime, event: LiveTurnEvent): void {
    this.signalSessionActivity(runtime)
    if (event.type === 'system' && 'subtype' in event && event.subtype === 'background_tasks_changed') {
      runtime.liveBackgroundTasks = event.tasks.map(({ task_id, task_type, ambient }) => ({ taskId: task_id, taskType: task_type, ...(ambient === undefined ? {} : { ambient }) }))
      this.scheduleIdleClose(runtime)
      this.signalRuntimeChange(runtime)
    }
    this.notifySubscribers(runtime.sessionId, event)
  }
}
