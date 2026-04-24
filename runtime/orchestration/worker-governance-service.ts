import type { SessionRegistry } from './session-registry.js'
import type { WorkerManager } from '../execution/worker-manager.js'
import type { WorkerOutputEvent } from '../execution/types.js'

type Logger = {
  info: (event: string, fields?: Record<string, unknown>) => void
  warn: (event: string, fields?: Record<string, unknown>) => void
}

export type WorkerHealthStatus = 'healthy' | 'unhealthy' | 'unknown'

export type WorkerHealthSnapshot = {
  status: WorkerHealthStatus
  checkedAt: number
  okAt?: number
  durationMs?: number
  error?: string
}

type OrchestratorProbe = {
  requestControlSession: (
    sessionId: string,
    subtype: 'mcp_status',
  ) => Promise<{ sessionId: string; requestId: string }>
  rebuildSession: (sessionId: string) => Promise<unknown>
  subscribe: (key: string, subscriber: (event: WorkerOutputEvent) => void) => void
  unsubscribe: (key: string) => void
}

type ControlTransactionEvent = Extract<WorkerOutputEvent, { kind: 'control_transaction' }>

export class WorkerGovernanceService {
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  private readonly inflightHealthChecks = new Set<string>()
  private readonly healthBySessionId = new Map<string, WorkerHealthSnapshot>()
  private readonly lastAutoRebuildAtBySessionId = new Map<string, number>()
  private readonly crashRetryAttemptBySessionId = new Map<string, number>()
  private readonly crashRetryTimerBySessionId = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly crashRetryLastAtBySessionId = new Map<string, number>()
  private readonly orchestratorWatchKey = 'worker-governance:watch'
  private readonly deferredRebuildReasonBySessionId = new Map<string, string>()

  constructor(
    private readonly deps: {
      workerManager: WorkerManager
      sessionRegistry: SessionRegistry
      orchestrator: OrchestratorProbe
      logger: Logger
      idleTimeoutMs: number
      sweepIntervalMs: number
      healthCheckIntervalMs: number
      healthCheckTimeoutMs: number
      autoRebuildCooldownMs: number
    },
  ) {}

  start(): void {
    if (this.running) return
    this.running = true

    const sweepIntervalMs = Math.max(1_000, this.deps.sweepIntervalMs)
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((error) => {
        this.deps.logger.warn('worker-governance:sweep:error', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }, sweepIntervalMs)

    // Watch for worker crash/close events and attempt best-effort rebuild.
    this.deps.orchestrator.subscribe(this.orchestratorWatchKey, (event) => {
      if (event.kind !== 'worker_error' && event.kind !== 'worker_closed') return
      const sessionId = event.sessionId
      if (!sessionId) return
      const session = this.deps.sessionRegistry.get(sessionId)
      // Explicit/manual stop detaches the worker before worker_closed is broadcast.
      if (event.kind === 'worker_closed' && !session?.workerRef && !session?.activeRunId) return
      this.scheduleCrashRetry(sessionId, event.kind)
    })

    this.deps.logger.info('worker-governance:started', {
      idleTimeoutMs: this.deps.idleTimeoutMs,
      sweepIntervalMs,
      healthCheckIntervalMs: this.deps.healthCheckIntervalMs,
      healthCheckTimeoutMs: this.deps.healthCheckTimeoutMs,
      autoRebuildCooldownMs: this.deps.autoRebuildCooldownMs,
    })
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    this.deps.orchestrator.unsubscribe(this.orchestratorWatchKey)
    for (const sessionId of this.deferredRebuildReasonBySessionId.keys()) {
      this.deps.orchestrator.unsubscribe(this.deferredKey(sessionId))
    }
    this.deferredRebuildReasonBySessionId.clear()
    for (const timer of this.crashRetryTimerBySessionId.values()) {
      clearTimeout(timer)
    }
    this.crashRetryTimerBySessionId.clear()
  }

  getHealth(sessionId: string): WorkerHealthSnapshot | null {
    return this.healthBySessionId.get(sessionId) ?? null
  }

  getHealthBySessionId(): Record<string, WorkerHealthSnapshot> {
    return Object.fromEntries(this.healthBySessionId.entries())
  }

  private async sweep(): Promise<void> {
    const now = Date.now()
    const handles = this.deps.workerManager.list()

    // 1) Idle reaping
    for (const handle of handles) {
      if (this.deps.idleTimeoutMs <= 0) break
      const session = this.deps.sessionRegistry.get(handle.sessionId)
      if (!session) continue

      // Only reap when we are confident the session is idle and not actively running.
      if (session.sessionStatus !== 'idle') continue
      if (session.activeRunId) continue

      const lastUpdatedAt = session.updatedAt || session.createdAt || 0
      if (!lastUpdatedAt) continue
      const idleForMs = Math.max(0, now - lastUpdatedAt)
      if (idleForMs < this.deps.idleTimeoutMs) continue

      const stopped = await this.deps.workerManager.stop(handle.sessionId)
      // Keep runtime projection consistent even if the worker output loop doesn't flush.
      this.deps.sessionRegistry.detachWorker(handle.sessionId)

      this.deps.logger.info('worker-governance:idle-reaped', {
        sessionId: handle.sessionId,
        workerRef: handle.workerRef,
        idleForMs,
        stopped,
      })
    }

    // 2) Periodic health check (best-effort): only probe idle sessions to avoid
    // interfering with active runs.
    if (this.deps.healthCheckIntervalMs <= 0) return

    for (const handle of handles) {
      const session = this.deps.sessionRegistry.get(handle.sessionId)
      if (!session) continue
      if (session.sessionStatus !== 'idle') continue
      if (session.activeRunId) continue

      const last = this.healthBySessionId.get(handle.sessionId)
      if (last && now - last.checkedAt < this.deps.healthCheckIntervalMs) continue

      if (this.inflightHealthChecks.has(handle.sessionId)) continue
      this.inflightHealthChecks.add(handle.sessionId)
      try {
        await this.probeWorkerHealth(handle.sessionId)
      } finally {
        this.inflightHealthChecks.delete(handle.sessionId)
      }
    }
  }

  private async probeWorkerHealth(sessionId: string): Promise<void> {
    const startedAt = Date.now()
    try {
      const { requestId } = await this.deps.orchestrator.requestControlSession(sessionId, 'mcp_status')
      const ok = await this.waitForControlCompletion(sessionId, requestId, this.deps.healthCheckTimeoutMs)
      const checkedAt = Date.now()
      if (ok) {
        const snapshot: WorkerHealthSnapshot = {
          status: 'healthy',
          checkedAt,
          okAt: checkedAt,
          durationMs: checkedAt - startedAt,
        }
        this.healthBySessionId.set(sessionId, snapshot)
        return
      }

      const snapshot: WorkerHealthSnapshot = {
        status: 'unhealthy',
        checkedAt,
        durationMs: checkedAt - startedAt,
        error: 'health_check_timeout_or_failed',
      }
      this.healthBySessionId.set(sessionId, snapshot)
      await this.maybeAutoRebuild(sessionId, snapshot.error)
    } catch (error) {
      const checkedAt = Date.now()
      this.healthBySessionId.set(sessionId, {
        status: 'unhealthy',
        checkedAt,
        durationMs: checkedAt - startedAt,
        error: error instanceof Error ? error.message : String(error),
      })
      await this.maybeAutoRebuild(sessionId, error instanceof Error ? error.message : String(error))
    }
  }

  private async maybeAutoRebuild(sessionId: string, reason?: string): Promise<void> {
    if (this.deps.autoRebuildCooldownMs < 0) return

    const session = this.deps.sessionRegistry.get(sessionId)
    if (!session) return
    // Don't attempt rebuild while the session is actively running / awaiting user.
    if (session.sessionStatus !== 'idle' || session.activeRunId) {
      this.deferAutoRebuildUntilIdle(sessionId, reason ?? 'unknown')
      return
    }

    const now = Date.now()
    const last = this.lastAutoRebuildAtBySessionId.get(sessionId) ?? 0
    if (this.deps.autoRebuildCooldownMs > 0) {
      if (now - last < this.deps.autoRebuildCooldownMs) return
      this.lastAutoRebuildAtBySessionId.set(sessionId, now)
    }

    try {
      await this.deps.orchestrator.rebuildSession(sessionId)
      this.deps.logger.info('worker-governance:auto-rebuild:success', {
        sessionId,
        reason: reason ?? 'unknown',
      })
    } catch (error) {
      this.deps.logger.warn('worker-governance:auto-rebuild:error', {
        sessionId,
        reason: reason ?? 'unknown',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private scheduleCrashRetry(sessionId: string, reason: 'worker_error' | 'worker_closed'): void {
    const now = Date.now()
    const last = this.crashRetryLastAtBySessionId.get(sessionId) ?? 0
    const attempt = now - last > 5 * 60_000
      ? 1
      : (this.crashRetryAttemptBySessionId.get(sessionId) ?? 0) + 1
    this.crashRetryLastAtBySessionId.set(sessionId, now)
    this.crashRetryAttemptBySessionId.set(sessionId, attempt)

    const baseDelayMs = this.deps.autoRebuildCooldownMs > 0 ? this.deps.autoRebuildCooldownMs : 1_000
    const delayMs = attempt <= 1 ? 0 : Math.min(baseDelayMs * 2 ** (attempt - 2), 30_000)

    const existingTimer = this.crashRetryTimerBySessionId.get(sessionId)
    if (existingTimer) clearTimeout(existingTimer)

    if (delayMs <= 0) {
      void this.maybeAutoRebuild(sessionId, reason)
      return
    }

    this.deps.logger.info('worker-governance:crash-retry:scheduled', {
      sessionId,
      reason,
      attempt,
      delayMs,
    })
    const timer = setTimeout(() => {
      this.crashRetryTimerBySessionId.delete(sessionId)
      void this.maybeAutoRebuild(sessionId, `retry:${reason}`)
    }, delayMs)
    this.crashRetryTimerBySessionId.set(sessionId, timer)
  }

  private deferredKey(sessionId: string): string {
    return `worker-governance:defer:${sessionId}`
  }

  private deferAutoRebuildUntilIdle(sessionId: string, reason: string): void {
    if (!sessionId) return
    // Keep the latest reason (useful for logging/debugging).
    this.deferredRebuildReasonBySessionId.set(sessionId, reason)

    const key = this.deferredKey(sessionId)
    // Ensure single subscription per session.
    this.deps.orchestrator.unsubscribe(key)
    this.deps.orchestrator.subscribe(key, (event) => {
      if (event.sessionId !== sessionId) return
      const session = this.deps.sessionRegistry.get(sessionId)
      if (!session) return
      if (session.sessionStatus !== 'idle') return
      if (session.activeRunId) return

      this.deps.orchestrator.unsubscribe(key)
      const deferredReason = this.deferredRebuildReasonBySessionId.get(sessionId) ?? reason
      this.deferredRebuildReasonBySessionId.delete(sessionId)
      void this.maybeAutoRebuild(sessionId, `deferred:${deferredReason}`)
    })
  }

  private waitForControlCompletion(sessionId: string, requestId: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const key = `worker-health:${sessionId}:${requestId}`
      const timeout = setTimeout(() => {
        this.deps.orchestrator.unsubscribe(key)
        resolve(false)
      }, Math.max(50, timeoutMs))

      this.deps.orchestrator.subscribe(key, (event) => {
        if (event.sessionId !== sessionId) return

        if (event.kind === 'worker_error' || event.kind === 'worker_closed') {
          clearTimeout(timeout)
          this.deps.orchestrator.unsubscribe(key)
          resolve(false)
          return
        }

        if (event.kind !== 'control_transaction') return
        const transaction = (event as ControlTransactionEvent).transaction
        if (!transaction || transaction.requestId !== requestId) return
        const phase = (event as ControlTransactionEvent).phase
        if (phase === 'completed') {
          clearTimeout(timeout)
          this.deps.orchestrator.unsubscribe(key)
          resolve(true)
        } else if (phase === 'failed') {
          clearTimeout(timeout)
          this.deps.orchestrator.unsubscribe(key)
          resolve(false)
        }
      })
    })
  }
}
