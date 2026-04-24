import type { RunRegistry } from './run-registry.js'
import type { SessionRegistry } from './session-registry.js'
import type { WorkerSupervisor } from './worker-supervisor.js'

export interface SessionLifecycleResult {
  sessionId: string
  stopped: boolean
  rebuilt?: boolean
  hadActiveRun: boolean
}

export type SessionRecoverResult = SessionLifecycleResult & {
  interruptRequested: boolean
  interruptRequestId?: string
  interruptError?: string
  idleObserved: boolean
  interruptWaitMs?: number
  aborted?: boolean
  abortReason?: 'interrupt_failed' | 'stop_failed'
}

export class SessionLifecycleService {
  constructor(
    private readonly deps: {
      sessionRegistry: SessionRegistry
      runRegistry: RunRegistry
      workerSupervisor: WorkerSupervisor
      requestInterrupt: (sessionId: string) => Promise<{ requestId: string }>
      waitForIdle: (sessionId: string, timeoutMs: number) => Promise<boolean>
    },
  ) {}

  private buildStopFailureError(sessionId: string, action: 'rebuild' | 'recover'): Error {
    return new Error(`Failed to stop session before ${action}: ${sessionId}`)
  }

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
    if (!stopResult.stopped) {
      throw this.buildStopFailureError(sessionId, 'rebuild')
    }
    return {
      ...stopResult,
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
    let interruptError: string | undefined
    let idleObserved = false
    const waitStartedAt = Date.now()

    // Only attempt interrupt if there is an active run in-flight.
    if (session.activeRunId && session.sessionStatus !== 'idle') {
      try {
        const accepted = await this.deps.requestInterrupt(sessionId)
        interruptRequested = true
        interruptRequestId = accepted.requestId
      } catch (error) {
        interruptError = error instanceof Error ? error.message : String(error)
        return {
          sessionId,
          stopped: false,
          rebuilt: false,
          hadActiveRun: true,
          interruptRequested: false,
          interruptError,
          idleObserved: false,
          interruptWaitMs: Date.now() - waitStartedAt,
          aborted: true,
          abortReason: 'interrupt_failed',
        }
      }

      idleObserved = await this.deps.waitForIdle(sessionId, interruptTimeoutMs)
    }

    const stopResult = await this.stopSession(sessionId)
    if (!stopResult.stopped) {
      return {
        ...stopResult,
        rebuilt: false,
        interruptRequested,
        ...(interruptRequestId ? { interruptRequestId } : {}),
        ...(interruptError ? { interruptError } : {}),
        idleObserved,
        interruptWaitMs: Date.now() - waitStartedAt,
        aborted: true,
        abortReason: 'stop_failed',
      }
    }
    return {
      ...stopResult,
      rebuilt: true,
      interruptRequested,
      ...(interruptRequestId ? { interruptRequestId } : {}),
      ...(interruptError ? { interruptError } : {}),
      idleObserved,
      interruptWaitMs: Date.now() - waitStartedAt,
    }
  }
}
