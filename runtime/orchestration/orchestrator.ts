import type { ConfigRegistry } from '../config/registry.js'
import type { SdkRawLogEvent, SessionEvent } from '../protocol/message-types.js'
import { SessionEventMapper } from '../protocol/session-event-mapper.js'
import { isRunTerminalStatus, type RunTerminalStatus, type SessionRecord, type RunRecord } from './types.js'
import type { SessionRegistry } from './session-registry.js'
import type { RunRegistry } from './run-registry.js'
import type { WorkerOutputEvent } from '../execution/types.js'
import type { WorkerManager } from '../execution/worker-manager.js'
import type { Logger } from '../core/logger.js'
import { EgressRouter } from './egress-router.js'
import { WorkerSupervisor } from './worker-supervisor.js'
import { computeWorkerConfigSignature } from './worker-config-signature.js'
import { RunDispatcher, type DispatchRunInput, type V2HostControlSubtype, SessionBusyError } from './run-dispatcher.js'
import { SessionLifecycleService, type SessionLifecycleResult, type SessionRecoverResult } from './session-lifecycle-service.js'
import { InteractionCoordinator } from './interaction-coordinator.js'

export type OrchestratorSubscriber = (event: WorkerOutputEvent) => void
export type SessionEventSubscriber = (event: SessionEvent) => void

export { SessionBusyError }

export type { SessionLifecycleResult }

export class Orchestrator {
  private readonly egress: EgressRouter<WorkerOutputEvent>
  private readonly sessionEgress: EgressRouter<SessionEvent>
  private readonly sessionEventMapper = new SessionEventMapper()
  private readonly workerSupervisor: WorkerSupervisor
  private readonly runDispatcher: RunDispatcher
  private readonly sessionLifecycle: SessionLifecycleService
  private readonly interactionCoordinator: InteractionCoordinator
  private sdkRawSequence = 0
  private readonly sdkRawLogFailureNoticeByRunId = new Set<string>()

  constructor(
    private readonly deps: {
      configRegistry: ConfigRegistry
      sessionRegistry: SessionRegistry
      runRegistry: RunRegistry
      workerManager: WorkerManager
      logger: Logger
      sdkRawLogWriter?: (runId: string, event: SdkRawLogEvent) => Promise<void>
    },
  ) {
    this.egress = new EgressRouter<WorkerOutputEvent>(deps.logger)
    this.sessionEgress = new EgressRouter<SessionEvent>(deps.logger)
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
      sessionRegistry: deps.sessionRegistry,
      runRegistry: deps.runRegistry,
      workerSupervisor: this.workerSupervisor,
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
    const current = this.deps.sessionRegistry.get(sessionId)
    if (current?.sessionStatus === 'idle' && !current.activeRunId) {
      return Promise.resolve(true)
    }

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

      const latest = this.deps.sessionRegistry.get(sessionId)
      if (latest?.sessionStatus === 'idle' && !latest.activeRunId) {
        clearTimeout(timeout)
        this.unsubscribe(key)
        resolve(true)
      }
    })
  }

  subscribe(key: string, subscriber: OrchestratorSubscriber): void {
    this.egress.subscribe(key, subscriber)
  }

  unsubscribe(key: string): void {
    this.egress.unsubscribe(key)
  }

  subscribeSessionEvents(key: string, subscriber: SessionEventSubscriber): void {
    this.sessionEgress.subscribe(key, subscriber)
  }

  unsubscribeSessionEvents(key: string): void {
    this.sessionEgress.unsubscribe(key)
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
    const result = await this.sessionLifecycle.rebuildSession(sessionId)
    await this.startWorkerForSession(sessionId, 'resume')
    return result
  }

  // Called after a config update is persisted and applied to the in-memory registry.
  // This proactively rebuilds idle workers whose execution-relevant config changed,
  // while keeping the "idle-gated rebuild" safety invariant.
  async refreshConfigDependentSessions(): Promise<{ checked: number; rebuilt: number }> {
    let checked = 0
    let rebuilt = 0
    for (const session of this.deps.sessionRegistry.list()) {
      const worker = this.workerSupervisor.getWorker(session.sessionId)
      if (!worker) continue
      if (session.activeRunId || (session.sessionStatus && session.sessionStatus !== 'idle')) continue

      const agent = this.deps.configRegistry.getAgent(session.agentId)
      if (!agent) continue
      checked += 1

      const currentSig = session.workerConfigSig
      // ensureWorker() will stop + restart if the signature changed and session is idle.
      await this.workerSupervisor.ensureWorker(session.sessionId, agent, 'resume')
      const next = this.deps.sessionRegistry.get(session.sessionId)
      if (currentSig && next?.workerConfigSig && currentSig !== next.workerConfigSig) {
        rebuilt += 1
      }
    }
    return { checked, rebuilt }
  }

  async recoverSession(sessionId: string, input?: { interruptTimeoutMs?: number }): Promise<SessionRecoverResult> {
    const result = await this.sessionLifecycle.recoverSession(sessionId, input)
    if (!result.aborted) {
      await this.startWorkerForSession(sessionId, 'resume')
    }
    return result
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
        // If a config change was deferred while a run was active, apply it once the session becomes idle.
        if (event.state === 'idle') {
          await this.maybeRebuildWorkerAfterIdle(event.sessionId)
        }
        break

      case 'result':
        if (event.runId) {
          this.sdkRawLogFailureNoticeByRunId.delete(event.runId)
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
        // Some SDKs may emit terminal result separately; ensure deferred rebuild still happens
        // once the run is done and the session is idle.
        await this.maybeRebuildWorkerAfterIdle(event.sessionId)
        break

      case 'worker_closed':
        if (event.runId) this.sdkRawLogFailureNoticeByRunId.delete(event.runId)
        this.handleUnexpectedWorkerTermination(event)
        break

      case 'worker_error':
        if (event.runId) this.sdkRawLogFailureNoticeByRunId.delete(event.runId)
        this.handleUnexpectedWorkerTermination(event)
        break

      case 'control_message':
      case 'sdk_message':
      case 'sdk_stream_event':
        break
    }

    await this.persistSdkRawEvent(event)
    this.broadcast(event)
  }

  private async startWorkerForSession(sessionId: string, mode: 'new' | 'resume'): Promise<void> {
    const session = this.deps.sessionRegistry.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    const agent = this.deps.configRegistry.getAgent(session.agentId)
    if (!agent) throw new Error(`Agent not found for session ${sessionId}: ${session.agentId}`)
    await this.workerSupervisor.ensureWorker(sessionId, agent, mode)
  }

  private handleUnexpectedWorkerTermination(
    event: Extract<WorkerOutputEvent, { kind: 'worker_closed' | 'worker_error' }>,
  ): void {
    const session = this.deps.sessionRegistry.get(event.sessionId)
    const runId = event.runId ?? session?.activeRunId
    if (!runId) return

    const run = this.deps.runRegistry.get(runId)
    if (!run || isRunTerminalStatus(run.runStatus)) return

    const message = event.kind === 'worker_error'
      ? (event.error || 'Worker crashed unexpectedly.')
      : 'Worker closed unexpectedly before the active run completed.'

    this.deps.runRegistry.fail(runId, 'error_during_execution', {
      kind: 'error_during_execution',
      title: 'Worker Crashed',
      brief: 'Worker terminated during an active run',
      message,
    })
    this.deps.sessionRegistry.setActiveRun(event.sessionId, undefined)
    this.deps.sessionRegistry.setStatus(event.sessionId, 'idle')
    this.sessionEgress.publish({
      type: 'session.run.failed',
      runId,
      sessionId: event.sessionId,
      error: 'error_during_execution',
    })
  }

  private async maybeRebuildWorkerAfterIdle(sessionId: string): Promise<void> {
    const session = this.deps.sessionRegistry.get(sessionId)
    if (!session) return
    if (session.sessionStatus !== 'idle') return
    if (session.activeRunId) return

    // If there is no worker attached, there is nothing to rebuild.
    if (!this.workerSupervisor.getWorker(sessionId)) return

    const agent = this.deps.configRegistry.getAgent(session.agentId)
    if (!agent) return

    const desiredSig = computeWorkerConfigSignature(agent)
    if (!session.workerConfigSig || session.workerConfigSig === desiredSig) return
    // Lazy cold start: only stop the stale worker here; the next dispatch will
    // rebuild it on demand. This avoids eager resource consumption during idle.
    await this.workerSupervisor.stopWorker(sessionId)
  }

  private async persistSdkRawEvent(event: WorkerOutputEvent): Promise<void> {
    const runId = typeof event.runId === 'string' ? event.runId : ''
    if (!runId || !this.deps.sdkRawLogWriter) return

    const sdkRawEvent = this.toSdkRawLogEvent(event)
    if (!sdkRawEvent) return

    try {
      await this.deps.sdkRawLogWriter(runId, sdkRawEvent)
    } catch (error) {
      this.deps.logger.error('orchestrator:sdk-raw-log:append-failed', {
        sessionId: event.sessionId,
        runId,
        kind: event.kind,
        error: error instanceof Error ? error.message : String(error),
      })
      this.publishSdkRawLogFailureNotice(event.sessionId, runId)
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
      this.deps.logger.error('orchestrator:synthetic-user-log:append-failed', {
        sessionId: input.sessionId,
        runId: input.runId,
        error: error instanceof Error ? error.message : String(error),
      })
      this.publishSdkRawLogFailureNotice(input.sessionId, input.runId)
    }
  }

  private publishSdkRawLogFailureNotice(sessionId: string, runId: string): void {
    if (!sessionId || !runId) return
    if (this.sdkRawLogFailureNoticeByRunId.has(runId)) return
    this.sdkRawLogFailureNoticeByRunId.add(runId)
    this.sessionEgress.publish({
      type: 'session.error',
      sessionId,
      runId,
      error: 'SDK raw log persistence failed; audit trail may be incomplete.',
    })
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
    const sessionEvent = this.sessionEventMapper.mapWorkerOutputEvent(event)
    if (sessionEvent) {
      this.sessionEgress.publish(sessionEvent)
    }
  }
}
