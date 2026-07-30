import { randomUUID } from 'node:crypto'
import { query, type Query, type SDKMessage, type SDKResultError, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { EffortLevel, ModelSelection, PermissionMode, SessionRunState } from '@cotta/shared'
import { projectPathFromId } from './claude-code-api.js'
import type { LiveEventStore } from './live-event-store.js'
import type { SessionSummaryCache } from './session-summary-cache.js'

const IDLE_RUNTIME_TTL_MS = 10 * 60 * 1000

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

function sdkFailureResult(input: { error: string; sessionId: string }): SDKResultError {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: true,
    num_turns: 0,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      inference_geo: '',
      input_tokens: 0,
      iterations: [],
      output_tokens: 0,
      output_tokens_details: { thinking_tokens: 0 },
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
      service_tier: 'standard',
      speed: 'standard',
    },
    modelUsage: {},
    permission_denials: [],
    errors: [input.error],
    uuid: randomUUID(),
    session_id: input.sessionId,
  }
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
  model?: ModelSelection
  effort?: EffortLevel
  currentUserMessageUuid: string | null
  closed: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
}

function liveSessionStateFromSdkMessage(message: SDKMessage): LiveSessionState | null {
  if (message.type !== 'system' || !('subtype' in message) || message.subtype !== 'session_state_changed') return null
  if (!('state' in message) || typeof message.state !== 'string') return null
  return message.state === 'idle' || message.state === 'running' || message.state === 'requires_action' ? message.state : null
}

export type LiveTurnEvent = SDKMessage
export type LiveTurnSubscriber = (event: LiveTurnEvent) => void

export class LiveTurnManager {
  private readonly subscribers = new Map<string, Set<LiveTurnSubscriber>>()
  private readonly runtimes = new Map<string, SessionRuntime>()
  private readonly runStateBySession = new Map<string, SessionRunState>()

  constructor(
    private readonly liveEventStore?: LiveEventStore,
    private readonly sessionSummaryCache?: SessionSummaryCache,
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

  closeAll(): void {
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

  private scheduleSummaryRefresh(reason: 'session-created' | 'session-stale'): void {
    void this.sessionSummaryCache?.scheduleRefresh({ reason }).catch((error) => console.error('session-summary-cache:live-refresh failed', error))
  }

  private setRunState(sessionId: string, state: SessionRunState, reason: 'session-created' | 'session-stale'): void {
    this.runStateBySession.set(sessionId, state)
    this.scheduleSummaryRefresh(reason)
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

  private finishTurn(sessionId: string, userMessageUuid: string, outcome: 'success' | 'error'): void {
    this.setRunState(sessionId, {
      phase: 'idle',
      activeTurnId: null,
      lastTurn: { id: userMessageUuid, outcome },
    }, 'session-stale')
  }

  ensureRuntime(input: { projectId: string; sessionId: string; permissionMode?: PermissionMode; model?: ModelSelection; effort?: EffortLevel }): void {
    this.ensureRuntimeInternal({ ...input, resume: true, permissionMode: input.permissionMode ?? 'default' })
  }

  async startTurn(input: { projectId: string; sessionId?: string; text: string; userMessageUuid: string; permissionMode: PermissionMode; model?: ModelSelection; effort?: EffortLevel }): Promise<{ sessionId: string; userMessageUuid: string }> {
    const sessionId = input.sessionId ?? randomUUID()
    let runtime = this.ensureRuntimeInternal({ projectId: input.projectId, sessionId, resume: Boolean(input.sessionId), permissionMode: input.permissionMode, model: input.model, effort: input.effort })
    if (runtime.currentUserMessageUuid) throw new Error('Session already has a running generation')
    this.clearIdleTimer(runtime)
    if (input.effort === 'max' && runtime.effort !== 'max') {
      this.closeRuntime(runtime)
      runtime = this.ensureRuntimeInternal({ projectId: input.projectId, sessionId, resume: true, permissionMode: input.permissionMode, model: input.model, effort: input.effort })
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

    const userMessageUuid = input.userMessageUuid as ReturnType<typeof randomUUID>
    const userMessage = sdkUserMessage({ uuid: userMessageUuid, text: input.text, sessionId, startedAt: Date.now() })
    runtime.currentUserMessageUuid = userMessageUuid
    this.setRunState(sessionId, { phase: 'running', activeTurnId: userMessageUuid, lastTurn: null }, 'session-created')
    this.persist(runtime, userMessage)
    runtime.input.push(userMessage)

    return { sessionId, userMessageUuid }
  }

  async interrupt(sessionId: string): Promise<boolean> {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime?.currentUserMessageUuid) return false
    await runtime.query.interrupt()
    return true
  }

  private ensureRuntimeInternal(input: { projectId: string; sessionId: string; resume: boolean; permissionMode: PermissionMode; model?: ModelSelection; effort?: EffortLevel }): SessionRuntime {
    const existing = this.runtimes.get(input.sessionId)
    if (existing) {
      if (existing.projectId !== input.projectId) throw new Error('Session runtime project mismatch')
      return existing
    }

    const projectPath = projectPathFromId(input.projectId)
    if (!projectPath) throw new Error('Invalid project id')
    const runtimeInput = new AsyncQueue<SDKUserMessage>()
    const runtime: SessionRuntime = {
      projectId: input.projectId,
      sessionId: input.sessionId,
      input: runtimeInput,
      query: query({
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
      }),
      permissionMode: input.permissionMode,
      model: input.model,
      effort: input.effort,
      currentUserMessageUuid: null,
      closed: false,
      idleTimer: null,
    }
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
          this.setRunState(runtime.sessionId, { phase: liveState, activeTurnId: runtime.currentUserMessageUuid, lastTurn: null }, 'session-stale')
        }

        if (!runtime.currentUserMessageUuid) continue
        this.publish(runtime, message)

        if (message.type === 'result') {
          this.finishTurn(runtime.sessionId, runtime.currentUserMessageUuid, message.subtype === 'success' ? 'success' : 'error')
          runtime.currentUserMessageUuid = null
          this.scheduleIdleClose(runtime)
        }
      }
    } catch (error) {
      console.error('live-runtime:drain failed', error)
      if (runtime.currentUserMessageUuid) {
        const userMessageUuid = runtime.currentUserMessageUuid
        this.publish(runtime, sdkFailureResult({
          error: error instanceof Error ? error.message : String(error),
          sessionId: runtime.sessionId,
        }))
        this.finishTurn(runtime.sessionId, userMessageUuid, 'error')
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
