import { randomUUID } from 'node:crypto'
import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { projectPathFromId } from './claude-code-api.js'
import type { LiveEventStore } from './live-event-store.js'

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
type VisibleLiveSessionState = Exclude<LiveSessionState, 'idle'>

type SessionRuntime = {
  projectId: string
  sessionId: string
  query: Query
  input: AsyncQueue<SDKUserMessage>
  currentUserMessageUuid: string | null
}

function liveSessionStateFromSdkMessage(message: SDKMessage): LiveSessionState | null {
  if (message.type !== 'system' || !('subtype' in message) || message.subtype !== 'session_state_changed') return null
  if (!('state' in message) || typeof message.state !== 'string') return null
  return message.state === 'idle' || message.state === 'running' || message.state === 'requires_action' ? message.state : null
}

export type LiveTurnSubscriber = (message: SDKMessage) => void

export class LiveTurnManager {
  private readonly subscribers = new Map<string, Set<LiveTurnSubscriber>>()
  private readonly runtimes = new Map<string, SessionRuntime>()
  private readonly liveStateBySession = new Map<string, VisibleLiveSessionState>()

  constructor(private readonly liveEventStore?: LiveEventStore) {}

  sessionState(sessionId: string): VisibleLiveSessionState | null {
    return this.liveStateBySession.get(sessionId) ?? null
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

  ensureRuntime(input: { projectId: string; sessionId: string }): void {
    this.ensureRuntimeInternal({ ...input, resume: true })
  }

  async startTurn(input: { projectId: string; sessionId?: string; text: string; userMessageUuid: string }): Promise<{ sessionId: string; userMessageUuid: string }> {
    const sessionId = input.sessionId ?? randomUUID()
    const runtime = this.ensureRuntimeInternal({ projectId: input.projectId, sessionId, resume: Boolean(input.sessionId) })
    if (runtime.currentUserMessageUuid) throw new Error('Session already has a running generation')

    const userMessageUuid = input.userMessageUuid as ReturnType<typeof randomUUID>
    runtime.currentUserMessageUuid = userMessageUuid
    this.liveStateBySession.set(sessionId, 'running')
    runtime.input.push(sdkUserMessage({ uuid: userMessageUuid, text: input.text, sessionId, startedAt: Date.now() }))

    return { sessionId, userMessageUuid }
  }

  async interrupt(sessionId: string): Promise<boolean> {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime?.currentUserMessageUuid) return false
    await runtime.query.interrupt()
    return true
  }

  private ensureRuntimeInternal(input: { projectId: string; sessionId: string; resume: boolean }): SessionRuntime {
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
        },
      }),
      currentUserMessageUuid: null,
    }
    this.runtimes.set(input.sessionId, runtime)
    void this.drainRuntime(runtime)
    return runtime
  }

  private async drainRuntime(runtime: SessionRuntime): Promise<void> {
    try {
      for await (const message of runtime.query) {
        const liveState = liveSessionStateFromSdkMessage(message)
        if (liveState === 'idle') this.liveStateBySession.delete(runtime.sessionId)
        else if (liveState) this.liveStateBySession.set(runtime.sessionId, liveState)

        if (!runtime.currentUserMessageUuid) continue
        this.publish(runtime, message)

        if (message.type === 'result') {
          this.liveStateBySession.delete(runtime.sessionId)
          runtime.currentUserMessageUuid = null
        }
      }
    } catch (error) {
      console.error('live-runtime:drain failed', error)
    } finally {
      runtime.currentUserMessageUuid = null
      this.liveStateBySession.delete(runtime.sessionId)
      this.runtimes.delete(runtime.sessionId)
    }
  }

  private publish(runtime: SessionRuntime, message: SDKMessage): void {
    if (this.liveEventStore) {
      try {
        this.liveEventStore.append(runtime.projectId, runtime.sessionId, message)
      } catch (error) {
        console.error('live-events:append failed', error)
      }
    }
    for (const subscriber of this.subscribers.get(runtime.sessionId) ?? []) subscriber(message)
  }
}
