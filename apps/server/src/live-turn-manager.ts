import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { DefaultTurnOption, EffortLevel, ModelSelection, PermissionMode, SessionRunState } from '@cotta/shared'
import { projectPathFromId } from './claude-code-api.js'
import type { LiveEventStore } from './live-event-store.js'

const IDLE_RUNTIME_TTL_MS = 10 * 60 * 1000

type SessionSummaryObserver = {
  observeSession(input: { sessionId: string; projectId?: string }): unknown
  notifySessionRunStateActive?(sessionId: string): unknown
}

type LiveResultRecorder = {
  recordLiveResult(projectId: string, sessionId: string, userMessageUuid: string, message: SDKMessage): void
}

function sdkUserMessage(input: { uuid: SDKUserMessage['uuid']; text: string; sessionId: string; startedAt: number }): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: input.text },
    parent_tool_use_id: null,
    uuid: input.uuid,
    session_id: input.sessionId,
    timestamp: new Date(input.startedAt).toISOString(),
  }
}

type CottaLiveTurnFailedEvent = {
  type: 'cotta_live_turn_failed'
  error: string
  session_id: string
}

function cottaLiveTurnFailed(input: { error: string; sessionId: string }): CottaLiveTurnFailedEvent {
  return { type: 'cotta_live_turn_failed', error: input.error, session_id: input.sessionId }
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

type SessionRuntime = {
  projectId: string
  sessionId: string
  query: Query
  input: AsyncQueue<SDKUserMessage>
  permissionMode: PermissionMode
  model?: ModelSelection | DefaultTurnOption
  effort?: EffortLevel | null
  currentUserMessageUuid: string | null
  startingTurnToken: symbol | null
  stale: boolean
  rebuildingAfterCliIdle: boolean
  ready: Promise<void>
  closed: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
}

function liveSessionStateFromSdkMessage(message: SDKMessage): LiveSessionState | null {
  if (message.type !== 'system' || !('subtype' in message) || message.subtype !== 'session_state_changed') return null
  if (!('state' in message) || typeof message.state !== 'string') return null
  return message.state === 'idle' || message.state === 'running' || message.state === 'requires_action' ? message.state : null
}

export type LiveTurnEvent = SDKMessage | CottaLiveTurnFailedEvent
export type LiveTurnSubscriber = (event: LiveTurnEvent) => void

export class LiveTurnManager {
  private readonly subscribers = new Map<string, Set<LiveTurnSubscriber>>()
  private readonly runtimes = new Map<string, SessionRuntime>()
  private readonly runStateBySession = new Map<string, SessionRunState>()
  private readonly externalOwnerCloses = new Map<string, Promise<boolean>>()
  private readonly externalOwnerGenerations = new Map<string, number>()

  constructor(
    private readonly liveEventStore?: LiveEventStore,
    private readonly sessionSummaryCache?: SessionSummaryObserver,
    private readonly liveResultRecorder?: LiveResultRecorder,
  ) {}

  sessionRunState(sessionId: string): SessionRunState | null {
    return this.runStateBySession.get(sessionId) ?? null
  }

  close(sessionId: string): boolean {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return false
    this.closeRuntime(runtime)
    return true
  }

  closeForExternalOwner(sessionId: string): Promise<boolean> {
    this.externalOwnerGenerations.set(sessionId, (this.externalOwnerGenerations.get(sessionId) ?? 0) + 1)
    const pending = this.externalOwnerCloses.get(sessionId)
    if (pending) return pending
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return Promise.resolve(false)
    const closing = (async () => {
      if (runtime.currentUserMessageUuid !== null) {
        const userMessageUuid = runtime.currentUserMessageUuid
        try {
          await runtime.query.interrupt()
        } catch (error) {
          console.error('live-runtime:external-owner interrupt failed', error)
        }
        if (runtime.currentUserMessageUuid === userMessageUuid) {
          this.publish(runtime, cottaLiveTurnFailed({
            error: 'Session was interrupted because it was taken over by Claude Code CLI/background agent.',
            sessionId: runtime.sessionId,
          }))
          this.finishTurn(runtime, userMessageUuid, 'error')
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
    return closing
  }

  closeAll(): void {
    this.externalOwnerCloses.clear()
    this.externalOwnerGenerations.clear()
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

  private setRunState(runtime: SessionRuntime, state: SessionRunState): void {
    this.runStateBySession.set(runtime.sessionId, state)
    if (state.phase !== 'idle') {
      Promise.resolve(this.sessionSummaryCache?.notifySessionRunStateActive?.(runtime.sessionId)).catch((error) => {
        console.error('session-summary-cache:run-state-active failed', error)
      })
    }
    this.sessionSummaryCache?.observeSession({ sessionId: runtime.sessionId, projectId: runtime.projectId })
  }

  private clearIdleTimer(runtime: SessionRuntime): void {
    if (!runtime.idleTimer) return
    clearTimeout(runtime.idleTimer)
    runtime.idleTimer = null
  }

  private scheduleIdleClose(runtime: SessionRuntime): void {
    this.clearIdleTimer(runtime)
    if (runtime.closed || runtime.currentUserMessageUuid) return
    runtime.idleTimer = setTimeout(() => {
      if (this.runtimes.get(runtime.sessionId) === runtime && !runtime.currentUserMessageUuid && !runtime.closed) this.closeRuntime(runtime)
    }, IDLE_RUNTIME_TTL_MS)
    runtime.idleTimer.unref?.()
  }

  private closeRuntime(runtime: SessionRuntime): void {
    if (runtime.closed) return
    runtime.closed = true
    this.clearIdleTimer(runtime)
    if (this.runtimes.get(runtime.sessionId) === runtime) this.runtimes.delete(runtime.sessionId)
    try {
      runtime.query.close()
    } catch (error) {
      console.error('live-runtime:close failed', error)
    }
  }

  private finishTurn(runtime: SessionRuntime, userMessageUuid: string, outcome: 'success' | 'error'): void {
    this.setRunState(runtime, {
      phase: 'idle',
      activeUserMessageUuid: null,
      lastTurn: { id: userMessageUuid, outcome },
    })
  }

  async ensureRuntime(input: { projectId: string; sessionId: string; permissionMode?: PermissionMode; model?: ModelSelection | DefaultTurnOption; effort?: EffortLevel | null }): Promise<void> {
    await this.ensureRuntimeInternal({ ...input, resume: true, permissionMode: input.permissionMode ?? 'default' })
  }

  async rebuildRuntimeAfterCliIdle(input: { projectId: string; sessionId: string; permissionMode: PermissionMode; model: ModelSelection | DefaultTurnOption; effort: EffortLevel | null }): Promise<boolean> {
    const externalOwnerGeneration = this.externalOwnerGenerations.get(input.sessionId) ?? 0
    await this.externalOwnerCloses.get(input.sessionId)
    if ((this.externalOwnerGenerations.get(input.sessionId) ?? 0) !== externalOwnerGeneration) return false
    const current = this.runtimes.get(input.sessionId)
    if (current?.rebuildingAfterCliIdle) {
      await current.ready
      return true
    }
    if (current?.currentUserMessageUuid || current?.startingTurnToken) return false
    if (current && current.projectId !== input.projectId) throw new Error('Session runtime project mismatch')

    if (current) {
      current.stale = true
      this.closeRuntime(current)
    }
    const replacement = this.createRuntime({ ...input, resume: true })
    replacement.rebuildingAfterCliIdle = true
    try {
      await replacement.ready
      return this.runtimes.get(input.sessionId) === replacement && !replacement.closed && !replacement.stale
    } finally {
      replacement.rebuildingAfterCliIdle = false
    }
  }

  async startTurn(input: { projectId: string; sessionId: string; resume: boolean; text: string; userMessageUuid: string; permissionMode: PermissionMode; model?: ModelSelection | DefaultTurnOption; effort?: EffortLevel | null }): Promise<{ sessionId: string; userMessageUuid: string }> {
    const sessionId = input.sessionId
    let runtime = await this.ensureRuntimeInternal({ projectId: input.projectId, sessionId, resume: input.resume, permissionMode: input.permissionMode, model: input.model, effort: input.effort })
    if (runtime.currentUserMessageUuid || runtime.startingTurnToken) throw new Error('Session already has a running generation')
    const startingTurnToken = Symbol('starting-turn')
    runtime.startingTurnToken = startingTurnToken
    this.clearIdleTimer(runtime)
    try {
      if (input.effort === 'max' && runtime.effort !== 'max') {
        runtime.startingTurnToken = null
        runtime.stale = true
        this.closeRuntime(runtime)
        runtime = this.createRuntime({ projectId: input.projectId, sessionId, resume: true, permissionMode: input.permissionMode, model: input.model, effort: input.effort })
        runtime.startingTurnToken = startingTurnToken
        await runtime.ready
        this.clearIdleTimer(runtime)
      }
      if (runtime.permissionMode !== input.permissionMode) {
        await runtime.query.setPermissionMode(input.permissionMode)
        runtime.permissionMode = input.permissionMode
      }
      if (input.model !== undefined && runtime.model !== input.model) {
        await runtime.query.setModel(input.model)
        runtime.model = input.model
      }
      if (input.effort !== undefined && input.effort !== 'max' && runtime.effort !== input.effort) {
        await runtime.query.applyFlagSettings({ effortLevel: input.effort })
        runtime.effort = input.effort
      }

      const userMessageUuid = input.userMessageUuid as NonNullable<SDKUserMessage['uuid']>
      const userMessage = sdkUserMessage({ uuid: userMessageUuid, text: input.text, sessionId, startedAt: Date.now() })
      runtime.currentUserMessageUuid = userMessageUuid
      runtime.startingTurnToken = null
      this.setRunState(runtime, { phase: 'running', activeUserMessageUuid: userMessageUuid, lastTurn: null })
      this.persist(runtime, userMessage)
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
    if (!runtime?.currentUserMessageUuid) return false
    await runtime.query.interrupt()
    return true
  }

  private async ensureRuntimeInternal(input: { projectId: string; sessionId: string; resume: boolean; permissionMode: PermissionMode; model?: ModelSelection | DefaultTurnOption; effort?: EffortLevel | null }): Promise<SessionRuntime> {
    for (;;) {
      const runtime = this.runtimes.get(input.sessionId) ?? this.createRuntime(input)
      if (runtime.projectId !== input.projectId) throw new Error('Session runtime project mismatch')
      await runtime.ready
      if (this.runtimes.get(input.sessionId) === runtime && !runtime.stale && !runtime.closed) return runtime
    }
  }

  private createRuntime(input: { projectId: string; sessionId: string; resume: boolean; permissionMode: PermissionMode; model?: ModelSelection | DefaultTurnOption; effort?: EffortLevel | null }): SessionRuntime {
    const projectPath = projectPathFromId(input.projectId)
    if (!projectPath) throw new Error('Invalid project id')
    const runtimeInput = new AsyncQueue<SDKUserMessage>()
    const sdkQuery = query({
      prompt: runtimeInput,
      options: {
        cwd: projectPath,
        ...(input.resume ? { resume: input.sessionId } : { sessionId: input.sessionId }),
        includePartialMessages: true,
        permissionMode: input.permissionMode,
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        allowDangerouslySkipPermissions: true,
      },
    })
    const runtime: SessionRuntime = {
      projectId: input.projectId,
      sessionId: input.sessionId,
      input: runtimeInput,
      query: sdkQuery,
      permissionMode: input.permissionMode,
      model: input.model,
      effort: input.effort,
      currentUserMessageUuid: null,
      startingTurnToken: null,
      stale: false,
      rebuildingAfterCliIdle: false,
      ready: Promise.resolve(),
      closed: false,
      idleTimer: null,
    }
    runtime.ready = sdkQuery.initializationResult().then(
      () => undefined,
      (error) => {
        runtime.stale = true
        this.closeRuntime(runtime)
        throw error
      },
    )
    this.runtimes.set(input.sessionId, runtime)
    this.scheduleIdleClose(runtime)
    void this.drainRuntime(runtime)
    return runtime
  }

  private async drainRuntime(runtime: SessionRuntime): Promise<void> {
    try {
      for await (const message of runtime.query) {
        const liveState = liveSessionStateFromSdkMessage(message)
        if (liveState && liveState !== 'idle' && runtime.currentUserMessageUuid) {
          this.setRunState(runtime, { phase: liveState, activeUserMessageUuid: runtime.currentUserMessageUuid, lastTurn: null })
        }

        if (!runtime.currentUserMessageUuid) continue
        this.publish(runtime, message)

        if (message.type === 'result') {
          const userMessageUuid = runtime.currentUserMessageUuid
          try {
            this.liveResultRecorder?.recordLiveResult(runtime.projectId, runtime.sessionId, userMessageUuid, message)
          } catch (error) {
            console.error('live-result:record failed', error)
          }
          this.finishTurn(runtime, userMessageUuid, message.subtype === 'success' ? 'success' : 'error')
          runtime.currentUserMessageUuid = null
          this.scheduleIdleClose(runtime)
        }
      }
      if (runtime.currentUserMessageUuid) {
        const userMessageUuid = runtime.currentUserMessageUuid
        this.publish(runtime, cottaLiveTurnFailed({
          error: 'SDK stream ended before the turn completed.',
          sessionId: runtime.sessionId,
        }))
        this.finishTurn(runtime, userMessageUuid, 'error')
      }
    } catch (error) {
      console.error('live-runtime:drain failed', error)
      if (runtime.currentUserMessageUuid) {
        const userMessageUuid = runtime.currentUserMessageUuid
        this.publish(runtime, cottaLiveTurnFailed({
          error: error instanceof Error ? error.message : String(error),
          sessionId: runtime.sessionId,
        }))
        this.finishTurn(runtime, userMessageUuid, 'error')
      }
    } finally {
      runtime.currentUserMessageUuid = null
      this.closeRuntime(runtime)
    }
  }

  private persist(runtime: SessionRuntime, event: LiveTurnEvent): void {
    if (!this.liveEventStore) return
    try {
      this.liveEventStore.append(runtime.projectId, runtime.sessionId, event)
    } catch (error) {
      console.error('live-events:append failed', error)
    }
  }

  private publish(runtime: SessionRuntime, event: LiveTurnEvent): void {
    this.persist(runtime, event)
    for (const subscriber of this.subscribers.get(runtime.sessionId) ?? []) subscriber(event)
  }
}
