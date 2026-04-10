import { randomUUID } from 'node:crypto'
import { createAgentRun, type AgentRunHandle, type ServerEvent } from './agent-runner.js'
import { CONFIG } from './config.js'
import { createLogger, shortId } from './logger.js'
import { TaskQueue } from './queue.js'
import { KeyedTaskQueue } from './keyed-task-queue.js'
import { SessionBindingStore } from './session-bindings.js'
import type {
  ChannelInboundMessage,
  ControlTransactionSummary,
  PendingInteraction,
  PermissionSuggestion,
  SessionEvent,
  SessionRunState,
} from '../shared/message-types.js'
import {
  isControlTransactionBlocking,
} from '../shared/message-types.js'

export type PermissionDecision = 'approve' | 'deny'
export type ElicitationAction = 'accept' | 'decline' | 'cancel'
export type HostControlRequest =
  | { subtype: 'interrupt' }
  | { subtype: 'get_context_usage' }
  | { subtype: 'mcp_status' }

export type RunRecord = {
  runId: string
  channel: ChannelInboundMessage['channel']
  conversationKey: string
  userKey?: string
  inboundPlatformMessageId?: string
  typingReaction?: { sourceMessageId: string; reactionId?: string | null; started?: boolean; cleared?: boolean } | null
  handle: AgentRunHandle | null
  abortController: AbortController
  canceled: boolean
  sessionId?: string
  state: SessionRunState
  currentInteraction?: PendingInteraction | null
  activeControlTransactions: Map<string, ControlTransactionSummary>
  blockingControlRequestId?: string
}

export type CoordinatorSubscriber = (event: SessionEvent, record: RunRecord) => void

const logger = createLogger('run-coordinator')

export class RunCoordinator {
  private readonly queue = new TaskQueue(CONFIG.maxConcurrentAgents)
  private readonly keyedQueue = new KeyedTaskQueue(CONFIG.maxConcurrentAgents)
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

  getLatestRunByConversation(channel: ChannelInboundMessage['channel'], conversationKey: string): RunRecord | null {
    let latest: RunRecord | null = null
    for (const record of this.runs.values()) {
      if (record.channel !== channel || record.conversationKey !== conversationKey) continue
      latest = record
    }
    return latest
  }

  getLatestInterruptibleRunByConversation(channel: ChannelInboundMessage['channel'], conversationKey: string): RunRecord | null {
    let latest: RunRecord | null = null
    for (const record of this.runs.values()) {
      if (record.channel !== channel || record.conversationKey !== conversationKey) continue
      if (record.state === 'completed' || record.state === 'failed' || record.state === 'cancelled') continue
      latest = record
    }
    return latest
  }

  getCurrentInteraction(runId: string): PendingInteraction | null {
    return this.runs.get(runId)?.currentInteraction ?? null
  }

  async startRun(message: ChannelInboundMessage): Promise<RunRecord> {
    const existingBinding = await this.bindings.get(message)
    const sessionId = message.sessionId ?? existingBinding?.sessionId
    logger.info('run:start:session-resolved', {
      channel: message.channel,
      conversationKey: message.conversationKey,
      explicitSessionId: shortId(message.sessionId),
      bindingSessionId: shortId(existingBinding?.sessionId),
      finalSessionId: shortId(sessionId),
    })
    const runId = randomUUID()
    const abortController = new AbortController()
    const record: RunRecord = {
      runId,
      channel: message.channel,
      conversationKey: message.conversationKey,
      ...(message.userKey ? { userKey: message.userKey } : {}),
      ...(message.platformMessageId ? { inboundPlatformMessageId: message.platformMessageId } : {}),
      typingReaction: message.platformMessageId ? { sourceMessageId: message.platformMessageId, started: false, cleared: false } : null,
      handle: null,
      abortController,
      canceled: false,
      ...(sessionId ? { sessionId } : {}),
      state: 'queued',
      currentInteraction: null,
      activeControlTransactions: new Map(),
    }
    this.runs.set(runId, record)

    await this.bindings.touchByInbound(message, {
      lastRunId: runId,
      ...(message.platformMessageId ? { lastInboundPlatformMessageId: message.platformMessageId } : {}),
    })
    this.dispatch({ type: 'session.run.queued', runId, ...(sessionId ? { sessionId } : {}) }, record)
    this.dispatch({ type: 'session.run.state_changed', runId, state: 'queued', ...(sessionId ? { sessionId } : {}) }, record)

    const queueKey = `${message.channel}:${message.conversationKey}`
    void this.keyedQueue.enqueue(queueKey, async () => {
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

  respondToInteractive(runId: string, requestId: string, response: { kind: 'permission'; decision: PermissionDecision; selectedSuggestion?: PermissionSuggestion | null; content?: Record<string, string | number | boolean | string[]> } | { kind: 'elicitation'; action: ElicitationAction; content?: Record<string, unknown> }): boolean {
    const record = this.runs.get(runId)
    if (!record?.handle) return false
    record.handle.respondToInteractive(requestId, response)
    return true
  }

  requestControl(runId: string, requestId: string, request: HostControlRequest): boolean {
    const record = this.runs.get(runId)
    if (!record?.handle) return false
    record.handle.requestControl(requestId, request)
    return true
  }

  cancelControl(runId: string, requestId: string): boolean {
    const record = this.runs.get(runId)
    if (!record?.handle) return false
    record.handle.cancelControl(requestId)
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
          record.blockingControlRequestId = undefined
        }
        break
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
        record.activeControlTransactions.set(event.transaction.requestId, event.transaction)
        const blocking = Array.from(record.activeControlTransactions.values()).find((transaction) => isControlTransactionBlocking(transaction))
        record.blockingControlRequestId = blocking?.requestId
        if (event.transaction.interaction) {
          if (event.type === 'session.interactive.awaiting_user' || event.type === 'session.control.awaiting_user') {
            record.currentInteraction = event.transaction.interaction
            record.state = 'requires_action'
          } else if (
            event.type === 'session.interactive.completed'
            || event.type === 'session.interactive.cancelled'
            || event.type === 'session.interactive.failed'
            || event.type === 'session.control.completed'
            || event.type === 'session.control.cancelled'
            || event.type === 'session.control.failed'
          ) {
            if (record.currentInteraction?.id === event.transaction.interaction.id) {
              record.currentInteraction = null
            }
          }
        }
        if (!blocking && record.state === 'requires_action') {
          record.state = 'running'
        }
        break
      }
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
