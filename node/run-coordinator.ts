import { randomUUID } from 'node:crypto'
import { createAgentRun, type AgentRunHandle, type ServerEvent } from './agent-runner.js'
import { CONFIG } from './config.js'
import { TaskQueue } from './queue.js'
import { SessionBindingStore } from './session-bindings.js'
import type {
  ChannelInboundMessage,
  PendingInteraction,
  PermissionSuggestion,
  SessionEvent,
  SessionRunState,
} from '../shared/message-types.js'

export type PermissionDecision = 'approve' | 'deny'
export type ElicitationAction = 'accept' | 'decline' | 'cancel'

export type RunRecord = {
  runId: string
  channel: ChannelInboundMessage['channel']
  conversationKey: string
  userKey?: string
  handle: AgentRunHandle | null
  abortController: AbortController
  canceled: boolean
  sessionId?: string
  state: SessionRunState
  currentInteraction?: PendingInteraction | null
}

export type CoordinatorSubscriber = (event: SessionEvent, record: RunRecord) => void

export class RunCoordinator {
  private readonly queue = new TaskQueue(CONFIG.maxConcurrentAgents)
  private readonly bindings = new SessionBindingStore()
  private readonly runs = new Map<string, RunRecord>()
  private readonly subscribers = new Map<string, CoordinatorSubscriber>()

  subscribe(key: string, subscriber: CoordinatorSubscriber): void {
    this.subscribers.set(key, subscriber)
  }

  unsubscribe(key: string): void {
    this.subscribers.delete(key)
  }

  getRun(runId: string): RunRecord | null {
    return this.runs.get(runId) ?? null
  }

  async startRun(message: ChannelInboundMessage): Promise<RunRecord> {
    const existingBinding = await this.bindings.get(message)
    const sessionId = message.sessionId ?? existingBinding?.sessionId
    const runId = randomUUID()
    const abortController = new AbortController()
    const record: RunRecord = {
      runId,
      channel: message.channel,
      conversationKey: message.conversationKey,
      ...(message.userKey ? { userKey: message.userKey } : {}),
      handle: null,
      abortController,
      canceled: false,
      ...(sessionId ? { sessionId } : {}),
      state: 'queued',
      currentInteraction: null,
    }
    this.runs.set(runId, record)

    await this.bindings.touchByInbound(message, {
      lastRunId: runId,
      ...(message.platformMessageId ? { lastInboundPlatformMessageId: message.platformMessageId } : {}),
    })
    this.dispatch({ type: 'session.run.queued', runId, ...(sessionId ? { sessionId } : {}) }, record)
    this.dispatch({ type: 'session.run.state_changed', runId, state: 'queued', ...(sessionId ? { sessionId } : {}) }, record)

    void this.queue.enqueue(async () => {
      if (record.canceled) throw new Error('Run canceled before start')

      record.handle = createAgentRun({
        prompt: message.text,
        workspacePath: CONFIG.workspacePath,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        ...(CONFIG.defaultModel ? { model: CONFIG.defaultModel } : {}),
      }, (event: ServerEvent) => {
        this.handleRunnerEvent(record, event)
      }, abortController.signal, runId)

      record.state = 'running'
      this.dispatch({ type: 'session.run.started', runId, ...(record.sessionId ? { sessionId: record.sessionId } : {}) }, record)
      this.dispatch({ type: 'session.run.state_changed', runId, state: 'running', ...(record.sessionId ? { sessionId: record.sessionId } : {}) }, record)
      return record.handle.done
    }).then((result) => {
      if (result.sessionId && !record.sessionId) {
        record.sessionId = result.sessionId
        void this.bindings.bindSession(record, result.sessionId, { lastRunId: runId })
      }
      record.state = 'completed'
      this.dispatch({
        type: 'session.run.completed',
        runId,
        ...((result.sessionId || record.sessionId) ? { sessionId: result.sessionId || record.sessionId } : {}),
        exitCode: result.exitCode,
        ...(result.error ? { error: result.error } : {}),
      }, record)
    }).catch((error) => {
      if (record.canceled) return
      record.state = 'failed'
      this.dispatch({
        type: 'session.run.failed',
        runId,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        error: error instanceof Error ? error.message : String(error),
      }, record)
      this.dispatch({
        type: 'session.run.state_changed',
        runId,
        state: 'failed',
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      }, record)
    }).finally(() => {
      this.runs.delete(runId)
    })

    return record
  }

  cancelRun(runId: string): boolean {
    const record = this.runs.get(runId)
    if (!record) return false
    record.canceled = true
    record.state = 'cancelled'
    record.abortController.abort()
    if (record.handle) {
      record.handle.cancel()
    } else {
      this.dispatch({ type: 'session.run.cancelled', runId, ...(record.sessionId ? { sessionId: record.sessionId } : {}) }, record)
      this.dispatch({ type: 'session.run.state_changed', runId, state: 'cancelled', ...(record.sessionId ? { sessionId: record.sessionId } : {}) }, record)
      this.runs.delete(runId)
    }
    return true
  }

  respondToPermission(runId: string, permissionId: string, decision: PermissionDecision, selectedSuggestion?: PermissionSuggestion | null, content?: Record<string, string | number | boolean | string[]>): boolean {
    const record = this.runs.get(runId)
    if (!record?.handle) return false
    record.handle.respondToPermission(permissionId, decision, selectedSuggestion, content)
    return true
  }

  respondToElicitation(runId: string, requestId: string, action: ElicitationAction, content?: Record<string, unknown>): boolean {
    const record = this.runs.get(runId)
    if (!record?.handle) return false
    record.handle.respondToElicitation(requestId, {
      action,
      ...(content ? { content } : {}),
    })
    return true
  }

  private handleRunnerEvent(record: RunRecord, event: ServerEvent): void {
    if ('sessionId' in event && event.sessionId && !record.sessionId) {
      record.sessionId = event.sessionId
      void this.bindings.bindSession(record, event.sessionId, { lastRunId: record.runId })
    }

    switch (event.type) {
      case 'session.run.state_changed':
        record.state = event.state
        if (event.state !== 'requires_action') {
          record.currentInteraction = null
        }
        break
      case 'session.sdk.control.requested':
        record.state = 'requires_action'
        record.currentInteraction = event.interaction
        if (record.sessionId) {
          void this.bindings.bindSession(record, record.sessionId, {
            lastRunId: record.runId,
            activeInteractionId: event.interaction.id,
          })
        }
        break
      case 'session.sdk.control.resolved':
        if (record.currentInteraction?.id === event.interaction.id) {
          record.currentInteraction = null
        }
        if (record.sessionId) {
          void this.bindings.bindSession(record, record.sessionId, {
            lastRunId: record.runId,
          })
        }
        break
      default:
        break
    }

    this.dispatch(event, record)
  }

  private dispatch(event: SessionEvent, record: RunRecord): void {
    for (const subscriber of this.subscribers.values()) {
      subscriber(event, record)
    }
  }
}
