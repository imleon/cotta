import type { ConfigRegistry } from '../config/registry.js'
import type { RunRegistry } from './run-registry.js'
import type { SessionRegistry } from './session-registry.js'
import type { WorkerStartMode } from '../execution/worker-manager.js'
import type { WorkerSupervisor } from './worker-supervisor.js'

export interface SessionLifecycleResult {
  sessionId: string
  workerRef?: string
  stopped: boolean
  rebuilt?: boolean
  hadActiveRun: boolean
}

export type SessionRecoverResult = SessionLifecycleResult & {
  interruptRequested: boolean
  interruptRequestId?: string
  idleObserved: boolean
  interruptWaitMs?: number
}

export class SessionLifecycleService {
  constructor(
    private readonly deps: {
      configRegistry: ConfigRegistry
      sessionRegistry: SessionRegistry
      runRegistry: RunRegistry
      workerSupervisor: WorkerSupervisor
      ensureWorkerForSession: (sessionId: string, agentId: string, mode: WorkerStartMode) => Promise<{ workerRef: string }>
      requestInterrupt: (sessionId: string) => Promise<{ requestId: string }>
      waitForIdle: (sessionId: string, timeoutMs: number) => Promise<boolean>
    },
  ) {}

  async stopSession(sessionId: string): Promise<SessionLifecycleResult> {
    const session = this.deps.sessionRegistry.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const activeRunId = session.activeRunId
    const stopped = await this.deps.workerSupervisor.stopWorker(sessionId)

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
    const worker = await this.deps.ensureWorkerForSession(sessionId, session.agentId, 'resume')

    return {
      ...stopResult,
      workerRef: worker.workerRef,
      rebuilt: true,
    }
  }

  // Standard recovery workflow:
  // 1) best-effort interrupt (run/control-level)
  // 2) wait for idle (or timeout)
  // 3) stop worker (worker-level)
  // 4) rebuild worker (worker-level)
  async recoverSession(sessionId: string, input?: { interruptTimeoutMs?: number }): Promise<SessionRecoverResult> {
    const session = this.deps.sessionRegistry.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const interruptTimeoutMs = input?.interruptTimeoutMs ?? 2_000
    let interruptRequested = false
    let interruptRequestId: string | undefined
    let idleObserved = false
    const waitStartedAt = Date.now()

    // Only attempt interrupt if there is an active run in-flight.
    if (session.activeRunId && session.sessionStatus !== 'idle') {
      try {
        const accepted = await this.deps.requestInterrupt(sessionId)
        interruptRequested = true
        interruptRequestId = accepted.requestId
      } catch {
        // Best-effort: proceed to stop/rebuild even if interrupt fails.
      }

      idleObserved = await this.deps.waitForIdle(sessionId, interruptTimeoutMs)
    }

    const stopResult = await this.stopSession(sessionId)
    const worker = await this.deps.ensureWorkerForSession(sessionId, session.agentId, 'resume')

    return {
      ...stopResult,
      workerRef: worker.workerRef,
      rebuilt: true,
      interruptRequested,
      ...(interruptRequestId ? { interruptRequestId } : {}),
      idleObserved,
      interruptWaitMs: Date.now() - waitStartedAt,
    }
  }
}
