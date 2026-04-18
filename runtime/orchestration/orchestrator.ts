import type { ConfigRegistry } from '../config/registry.js'
import type { SdkRawLogEvent } from '../protocol/message-types.js'
import type { RunTerminalStatus, SessionRecord, RunRecord } from './types.js'
import type { SessionRegistry } from './session-registry.js'
import type { RunRegistry } from './run-registry.js'
import type { WorkerOutputEvent } from '../execution/types.js'
import type { WorkerManager, WorkerStartMode } from '../execution/worker-manager.js'
import { EgressRouter } from './egress-router.js'
import { WorkerSupervisor } from './worker-supervisor.js'
import { RunDispatcher, type DispatchRunInput, type V2HostControlSubtype, SessionBusyError } from './run-dispatcher.js'
import { SessionLifecycleService, type SessionLifecycleResult, type SessionRecoverResult } from './session-lifecycle-service.js'
import { InteractionCoordinator } from './interaction-coordinator.js'

export type OrchestratorSubscriber = (event: WorkerOutputEvent) => void

export { SessionBusyError }

export type { SessionLifecycleResult }

export class Orchestrator {
  private readonly egress = new EgressRouter<WorkerOutputEvent>()
  private readonly workerSupervisor: WorkerSupervisor
  private readonly runDispatcher: RunDispatcher
  private readonly sessionLifecycle: SessionLifecycleService
  private readonly interactionCoordinator: InteractionCoordinator
  private sdkRawSequence = 0

  constructor(
    private readonly deps: {
      configRegistry: ConfigRegistry
      sessionRegistry: SessionRegistry
      runRegistry: RunRegistry
      workerManager: WorkerManager
      sdkRawLogWriter?: (runId: string, event: SdkRawLogEvent) => Promise<void>
    },
  ) {
    this.workerSupervisor = new WorkerSupervisor(
      {
        workerManager: deps.workerManager,
        sessionRegistry: deps.sessionRegistry,
      },
      {
        onWorkerEvent: async (event) => await this.handleWorkerOutput(event),
      },
    )
    this.runDispatcher = new RunDispatcher({
      configRegistry: deps.configRegistry,
      sessionRegistry: deps.sessionRegistry,
      runRegistry: deps.runRegistry,
      workerSupervisor: this.workerSupervisor,
      persistSyntheticUserMessage: async (input) => await this.persistSyntheticUserMessage(input),
    })
    this.sessionLifecycle = new SessionLifecycleService({
      configRegistry: deps.configRegistry,
      sessionRegistry: deps.sessionRegistry,
      runRegistry: deps.runRegistry,
      workerSupervisor: this.workerSupervisor,
      ensureWorkerForSession: async (sessionId, agentId, mode) => {
        const worker = await this.runDispatcher.ensureWorkerForSession(sessionId, agentId, mode)
        return { workerRef: worker.workerRef }
      },
      requestInterrupt: async (sessionId) => {
        const accepted = await this.runDispatcher.requestControlSession(sessionId, 'interrupt')
        return { requestId: accepted.requestId }
      },
      waitForIdle: async (sessionId, timeoutMs) => await this.waitForSessionIdle(sessionId, timeoutMs),
    })
    this.interactionCoordinator = new InteractionCoordinator({
      runRegistry: deps.runRegistry,
      sessionRegistry: deps.sessionRegistry,
    })
  }

  private waitForSessionIdle(sessionId: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const key = `session-idle:${sessionId}:${Date.now()}`
      const timeout = setTimeout(() => {
        this.unsubscribe(key)
        resolve(false)
      }, Math.max(50, timeoutMs))

      this.subscribe(key, (event) => {
        if (event.sessionId !== sessionId) return

        if (event.kind === 'session_state_changed' && event.state === 'idle') {
          clearTimeout(timeout)
          this.unsubscribe(key)
          resolve(true)
          return
        }

        // If the worker ends/errors, stop waiting and allow caller to proceed with stop/rebuild.
        if (event.kind === 'worker_error' || event.kind === 'worker_closed') {
          clearTimeout(timeout)
          this.unsubscribe(key)
          resolve(false)
        }
      })
    })
  }

  subscribe(key: string, subscriber: OrchestratorSubscriber): void {
    this.egress.subscribe(key, subscriber)
  }

  unsubscribe(key: string): void {
    this.egress.unsubscribe(key)
  }

  getSession(sessionId: string): SessionRecord | null {
    return this.deps.sessionRegistry.get(sessionId)
  }

  getRun(runId: string): RunRecord | null {
    return this.deps.runRegistry.get(runId)
  }

  ensureSession(sessionId: string, agentId: string): SessionRecord {
    return this.deps.sessionRegistry.ensure(sessionId, agentId)
  }

  async ensureWorkerForSession(
    sessionId: string,
    agentId: string,
    mode: WorkerStartMode,
  ): Promise<import('../execution/types.js').WorkerHandle> {
    return await this.runDispatcher.ensureWorkerForSession(sessionId, agentId, mode)
  }

  async dispatchRun(input: DispatchRunInput): Promise<{ sessionId: string; runId: string }> {
    return await this.runDispatcher.dispatchRun(input)
  }

  async interruptSession(sessionId: string): Promise<{ sessionId: string; runId: string }> {
    const accepted = await this.requestControlSession(sessionId, 'interrupt')
    return { sessionId: accepted.sessionId, runId: '' }
  }

  async requestControlSession(
    sessionId: string,
    subtype: V2HostControlSubtype,
  ): Promise<{ sessionId: string; requestId: string }> {
    return await this.runDispatcher.requestControlSession(sessionId, subtype)
  }

  async respondToInteraction(input: {
    sessionId: string
    requestId: string
    kind: 'permission' | 'elicitation'
    response: unknown
  }): Promise<{ sessionId: string; requestId: string }> {
    return await this.runDispatcher.respondToInteraction(input)
  }

  async cancelControl(input: {
    sessionId: string
    requestId: string
  }): Promise<{ sessionId: string; requestId: string }> {
    return await this.runDispatcher.cancelControl(input)
  }

  async stopSession(sessionId: string): Promise<SessionLifecycleResult> {
    return await this.sessionLifecycle.stopSession(sessionId)
  }

  async rebuildSession(sessionId: string): Promise<SessionLifecycleResult> {
    return await this.sessionLifecycle.rebuildSession(sessionId)
  }

  async recoverSession(sessionId: string, input?: { interruptTimeoutMs?: number }): Promise<SessionRecoverResult> {
    return await this.sessionLifecycle.recoverSession(sessionId, input)
  }

  private async handleWorkerOutput(event: WorkerOutputEvent): Promise<void> {
    switch (event.kind) {
      case 'control_transaction':
        this.interactionCoordinator.onControlTransaction(event)
        break

      case 'session_state_changed':
        this.deps.sessionRegistry.setStatus(event.sessionId, event.state)
        if (event.state === 'idle') {
          this.deps.sessionRegistry.setActiveRun(event.sessionId, undefined)
        }
        if (event.runId) {
          if (event.state === 'requires_action') {
            this.deps.runRegistry.setStatus(event.runId, 'requires_action')
          }
          if (event.state === 'running') {
            this.deps.runRegistry.setStatus(event.runId, 'running')
          }
        }
        break

      case 'result':
        if (event.runId) {
          if (event.subtype === 'success') {
            this.deps.runRegistry.complete(event.runId, { kind: 'success' })
          } else {
            this.deps.runRegistry.fail(
              event.runId,
              event.subtype as RunTerminalStatus,
              { kind: event.subtype as RunTerminalStatus },
            )
          }
          this.deps.sessionRegistry.setActiveRun(event.sessionId, undefined)
        }
        break

      case 'worker_closed':
        break

      case 'worker_error':
        break

      case 'control_message':
      case 'sdk_message':
      case 'sdk_stream_event':
        break
    }

    await this.persistSdkRawEvent(event)
    this.broadcast(event)
  }

  private async persistSdkRawEvent(event: WorkerOutputEvent): Promise<void> {
    const runId = typeof event.runId === 'string' ? event.runId : ''
    if (!runId || !this.deps.sdkRawLogWriter) return

    const sdkRawEvent = this.toSdkRawLogEvent(event)
    if (!sdkRawEvent) return

    try {
      await this.deps.sdkRawLogWriter(runId, sdkRawEvent)
    } catch (error) {
      console.warn('[orchestrator] failed to append sdk raw log', {
        sessionId: event.sessionId,
        runId,
        kind: event.kind,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async persistSyntheticUserMessage(input: {
    sessionId: string
    runId: string
    text: string
  }): Promise<void> {
    if (!this.deps.sdkRawLogWriter) return
    try {
      await this.deps.sdkRawLogWriter(input.runId, {
        source: 'sdk-raw',
        kind: 'sdk_message',
        direction: 'host_to_sdk',
        sessionId: input.sessionId,
        receivedAt: Date.now(),
        sequence: this.nextSdkRawSequence(),
        message: {
          type: 'synthetic_user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: input.text }],
          },
        },
      })
    } catch (error) {
      console.warn('[orchestrator] failed to append synthetic user sdk raw log', {
        sessionId: input.sessionId,
        runId: input.runId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private toSdkRawLogEvent(event: WorkerOutputEvent): SdkRawLogEvent | null {
    if (event.kind === 'sdk_message') {
      return {
        source: 'sdk-raw',
        kind: 'sdk_message',
        direction: 'sdk_to_host',
        sessionId: event.sessionId,
        receivedAt: event.receivedAt,
        sequence: this.nextSdkRawSequence(),
        message: event.payload,
      }
    }

    if (event.kind === 'control_message') {
      const kind = this.toSdkRawControlKind(event.message)
      if (!kind) return null
      return {
        source: 'sdk-raw',
        kind,
        direction: event.direction,
        sessionId: event.sessionId,
        receivedAt: event.receivedAt,
        sequence: this.nextSdkRawSequence(),
        requestId: event.transaction.requestId,
        subtype: event.transaction.subtype,
        message: event.message,
      }
    }

    return null
  }

  private toSdkRawControlKind(message: unknown): SdkRawLogEvent['kind'] | null {
    if (!message || typeof message !== 'object') return null
    const type = typeof (message as { type?: unknown }).type === 'string'
      ? (message as { type: string }).type
      : ''
    if (type === 'control_request') return 'control_request'
    if (type === 'control_response') return 'control_response'
    if (type === 'control_cancel_request') return 'control_cancel_request'
    return null
  }

  private nextSdkRawSequence(): number {
    this.sdkRawSequence += 1
    return this.sdkRawSequence
  }

  private broadcast(event: WorkerOutputEvent): void {
    this.egress.publish(event)
  }
}
