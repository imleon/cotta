import { randomUUID } from 'node:crypto'
import type { ConfigRegistry } from '../config/registry.js'
import type {
  AgentTemplate,
  PendingActionRecord,
  RunTerminalStatus,
  SessionRecord,
  RunRecord,
} from './types.js'
import type { SessionRegistry } from './session-registry.js'
import type { RunRegistry } from './run-registry.js'
import type { WorkerHandle, WorkerOutputEvent } from '../execution/types.js'
import type { WorkerManager, WorkerStartMode } from '../execution/worker-manager.js'

export interface DispatchRunInput {
  sessionId: string
  agentId: string
  text: string
  mode?: WorkerStartMode
}

export type V2HostControlSubtype = 'interrupt' | 'get_context_usage' | 'mcp_status'

export type OrchestratorSubscriber = (event: WorkerOutputEvent) => void

export class SessionBusyError extends Error {
  constructor(
    readonly sessionId: string,
    readonly activeRunId: string,
    readonly sessionStatus: SessionRecord['sessionStatus'],
  ) {
    super(`Session already has an active run: ${sessionId}`)
    this.name = 'SessionBusyError'
  }
}

export interface SessionLifecycleResult {
  sessionId: string
  workerRef?: string
  stopped: boolean
  rebuilt?: boolean
  hadActiveRun: boolean
}

export class Orchestrator {
  private readonly subscribers = new Map<string, OrchestratorSubscriber>()
  private readonly attachedWorkers = new Set<string>()

  constructor(
    private readonly deps: {
      configRegistry: ConfigRegistry
      sessionRegistry: SessionRegistry
      runRegistry: RunRegistry
      workerManager: WorkerManager
    },
  ) {}

  subscribe(key: string, subscriber: OrchestratorSubscriber): void {
    this.subscribers.set(key, subscriber)
  }

  unsubscribe(key: string): void {
    this.subscribers.delete(key)
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
  ): Promise<WorkerHandle> {
    const agent = this.mustGetAgent(agentId)
    this.deps.sessionRegistry.ensure(sessionId, agentId)
    return await this.ensureWorker(sessionId, agent, mode)
  }

  async dispatchRun(input: DispatchRunInput): Promise<{ sessionId: string; runId: string }> {
    const agent = this.mustGetAgent(input.agentId)

    const existingSession = this.deps.sessionRegistry.get(input.sessionId)
    if (existingSession && existingSession.agentId !== input.agentId) {
      throw new Error(`Session agent mismatch: ${input.sessionId}`)
    }

    const session = this.deps.sessionRegistry.ensure(input.sessionId, input.agentId)
    if (
      session.activeRunId
      && (session.sessionStatus === 'running' || session.sessionStatus === 'requires_action')
    ) {
      throw new SessionBusyError(session.sessionId, session.activeRunId, session.sessionStatus)
    }

    const worker = await this.ensureWorker(
      input.sessionId,
      agent,
      input.mode ?? 'resume',
    )

    const runId = randomUUID()
    this.deps.runRegistry.create(input.sessionId, runId)
    this.deps.sessionRegistry.setActiveRun(input.sessionId, runId)

    await worker.input.write({
      type: 'query',
      runId,
      text: input.text,
    })

    return { sessionId: input.sessionId, runId }
  }

  async interruptSession(sessionId: string): Promise<{ sessionId: string; runId: string }> {
    const accepted = await this.requestControlSession(sessionId, 'interrupt')
    return { sessionId: accepted.sessionId, runId: '' }
  }

  async requestControlSession(
    sessionId: string,
    subtype: V2HostControlSubtype,
  ): Promise<{ sessionId: string; requestId: string }> {
    const session = this.deps.sessionRegistry.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const agent = this.mustGetAgent(session.agentId)
    const worker = await this.ensureWorker(sessionId, agent, 'resume')

    const requestId = `${subtype}:${randomUUID()}`
    await worker.input.write({
      type: 'control',
      subtype,
      requestId,
    })

    return {
      sessionId,
      requestId,
    }
  }

  async respondToInteraction(input: {
    sessionId: string
    requestId: string
    kind: 'permission' | 'elicitation'
    response: unknown
  }): Promise<{ sessionId: string; requestId: string }> {
    const session = this.deps.sessionRegistry.get(input.sessionId)
    if (!session) {
      throw new Error(`Session not found: ${input.sessionId}`)
    }

    const agent = this.mustGetAgent(session.agentId)
    const worker = await this.ensureWorker(input.sessionId, agent, 'resume')
    await worker.input.write({
      type: 'control.respond',
      requestId: input.requestId,
      kind: input.kind,
      response: input.response,
    })

    return { sessionId: input.sessionId, requestId: input.requestId }
  }

  async cancelControl(input: {
    sessionId: string
    requestId: string
  }): Promise<{ sessionId: string; requestId: string }> {
    const session = this.deps.sessionRegistry.get(input.sessionId)
    if (!session) {
      throw new Error(`Session not found: ${input.sessionId}`)
    }

    const agent = this.mustGetAgent(session.agentId)
    const worker = await this.ensureWorker(input.sessionId, agent, 'resume')
    await worker.input.write({
      type: 'control.cancel',
      requestId: input.requestId,
    })

    return { sessionId: input.sessionId, requestId: input.requestId }
  }

  async stopSession(sessionId: string): Promise<SessionLifecycleResult> {
    const session = this.deps.sessionRegistry.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const activeRunId = session.activeRunId
    const stopped = await this.deps.workerManager.stop(sessionId)
    this.deps.sessionRegistry.detachWorker(sessionId)

    if (activeRunId) {
      this.deps.runRegistry.fail(activeRunId, 'error_during_execution', {
        kind: 'error_during_execution',
        title: 'Session Stopped',
        brief: 'Session was stopped manually',
        message: 'Session worker was stopped manually before the active run completed.',
      })
    }

    return {
      sessionId,
      stopped,
      hadActiveRun: Boolean(activeRunId),
    }
  }

  async rebuildSession(sessionId: string): Promise<SessionLifecycleResult> {
    const session = this.deps.sessionRegistry.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const stopResult = await this.stopSession(sessionId)
    const agent = this.mustGetAgent(session.agentId)
    const worker = await this.ensureWorker(sessionId, agent, 'resume')

    return {
      ...stopResult,
      workerRef: worker.workerRef,
      rebuilt: true,
    }
  }

  private mustGetAgent(agentId: string): AgentTemplate {
    const agent = this.deps.configRegistry.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }
    return agent
  }

  private async ensureWorker(
    sessionId: string,
    agent: AgentTemplate,
    mode: WorkerStartMode,
  ): Promise<WorkerHandle> {
    const existing = this.deps.workerManager.get(sessionId)
    if (existing) {
      this.attachWorkerOutputIfNeeded(existing)
      return existing
    }

    const handle = await this.deps.workerManager.start(sessionId, agent, mode)
    this.deps.sessionRegistry.attachWorker(sessionId, handle.workerRef)
    this.attachWorkerOutputIfNeeded(handle)
    return handle
  }

  private attachWorkerOutputIfNeeded(handle: WorkerHandle): void {
    if (this.attachedWorkers.has(handle.workerRef)) return
    this.attachedWorkers.add(handle.workerRef)

    void (async () => {
      try {
        for await (const event of handle.output) {
          this.handleWorkerOutput(event)
        }
      } finally {
        this.attachedWorkers.delete(handle.workerRef)
        this.deps.workerManager.remove(handle.sessionId)
        this.deps.sessionRegistry.detachWorker(handle.sessionId)
      }
    })()
  }

  private handleWorkerOutput(event: WorkerOutputEvent): void {
    switch (event.kind) {
      case 'control_transaction':
        this.handleControlTransaction(event)
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
        this.deps.workerManager.remove(event.sessionId)
        this.deps.sessionRegistry.detachWorker(event.sessionId)
        break

      case 'worker_error':
        this.deps.workerManager.remove(event.sessionId)
        this.deps.sessionRegistry.detachWorker(event.sessionId)
        break

      case 'sdk_message':
      case 'sdk_stream_event':
        break
    }

    this.broadcast(event)
  }

  private handleControlTransaction(event: Extract<WorkerOutputEvent, { kind: 'control_transaction' }>): void {
    const runId = event.transaction.runId
    if (!runId) return

    if (event.phase === 'awaiting_user') {
      this.deps.runRegistry.setStatus(runId, 'requires_action')
      this.deps.runRegistry.setPendingAction(runId, this.toPendingAction(event.transaction.interaction))
      this.deps.sessionRegistry.setStatus(event.sessionId, 'requires_action')
      return
    }

    if (
      event.phase === 'responded'
      || event.phase === 'completed'
      || event.phase === 'cancel_requested'
      || event.phase === 'cancelled'
      || event.phase === 'failed'
    ) {
      this.deps.runRegistry.setPendingAction(runId, undefined)
    }
  }

  private toPendingAction(interaction: Extract<WorkerOutputEvent, { kind: 'control_transaction' }>['transaction']['interaction']): PendingActionRecord | undefined {
    if (!interaction) return undefined
    if (interaction.kind === 'permission') {
      return {
        kind: 'can_use_tool',
        tool: interaction.toolName,
        reason: interaction.decisionReason,
        requestId: interaction.id,
      }
    }
    return {
      kind: 'elicitation',
      server: interaction.serverName,
      question: interaction.message,
      requestId: interaction.id,
    }
  }

  private broadcast(event: WorkerOutputEvent): void {
    for (const subscriber of this.subscribers.values()) {
      subscriber(event)
    }
  }
}
