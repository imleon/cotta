import { randomUUID } from 'node:crypto'
import type { ConfigRegistry } from '../config/registry.js'
import type { RunRegistry } from './run-registry.js'
import type { SessionRegistry } from './session-registry.js'
import type { SessionRecord } from './types.js'
import type { WorkerStartMode } from '../execution/worker-manager.js'
import type { AgentTemplate } from './types.js'
import type { WorkerSupervisor } from './worker-supervisor.js'

export interface DispatchRunInput {
  sessionId: string
  agentId: string
  text: string
  mode?: WorkerStartMode
}

export type V2HostControlSubtype = 'interrupt' | 'get_context_usage' | 'mcp_status'

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

export class RunDispatcher {
  constructor(
    private readonly deps: {
      configRegistry: ConfigRegistry
      sessionRegistry: SessionRegistry
      runRegistry: RunRegistry
      workerSupervisor: WorkerSupervisor
      persistSyntheticUserMessage: (input: { sessionId: string; runId: string; text: string }) => Promise<void>
    },
  ) {}

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

    const worker = await this.deps.workerSupervisor.ensureWorker(
      input.sessionId,
      agent,
      input.mode ?? 'resume',
    )

    const runId = randomUUID()
    this.deps.runRegistry.create(input.sessionId, runId)
    this.deps.sessionRegistry.setActiveRun(input.sessionId, runId)

    await this.deps.persistSyntheticUserMessage({
      sessionId: input.sessionId,
      runId,
      text: input.text,
    })

    await worker.input.write({
      type: 'query',
      runId,
      text: input.text,
    })

    return { sessionId: input.sessionId, runId }
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
    const worker = await this.deps.workerSupervisor.ensureWorker(sessionId, agent, 'resume')

    const requestId = `${subtype}:${randomUUID()}`
    await worker.input.write({
      type: 'control',
      subtype,
      requestId,
    })

    return { sessionId, requestId }
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
    const worker = await this.deps.workerSupervisor.ensureWorker(input.sessionId, agent, 'resume')
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
    const worker = await this.deps.workerSupervisor.ensureWorker(input.sessionId, agent, 'resume')
    await worker.input.write({
      type: 'control.cancel',
      requestId: input.requestId,
    })

    return { sessionId: input.sessionId, requestId: input.requestId }
  }

  private mustGetAgent(agentId: string): AgentTemplate {
    const agent = this.deps.configRegistry.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }
    return agent
  }
}
