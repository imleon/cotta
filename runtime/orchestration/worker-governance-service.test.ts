import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './session-registry.js'
import { WorkerGovernanceService } from './worker-governance-service.js'
import type { SessionRecord } from './types.js'

function setSessionRecord(sessionRegistry: SessionRegistry, record: SessionRecord): void {
  ;((sessionRegistry as unknown as { records: Map<string, SessionRecord> }).records).set(record.sessionId, record)
}

function createHarness() {
  const sessionRegistry = new SessionRegistry()
  const subscriptions = new Map<string, (event: unknown) => void>()
  const workerManager = {
    list: vi.fn().mockReturnValue([]),
    stop: vi.fn().mockResolvedValue(true),
  }
  const orchestrator = {
    requestControlSession: vi.fn(),
    rebuildSession: vi.fn().mockResolvedValue({}),
    subscribe: vi.fn((key: string, subscriber: (event: unknown) => void) => {
      subscriptions.set(key, subscriber)
    }),
    unsubscribe: vi.fn((key: string) => {
      subscriptions.delete(key)
    }),
  }
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  }
  const service = new WorkerGovernanceService({
    workerManager: workerManager as never,
    sessionRegistry,
    orchestrator: orchestrator as never,
    logger,
    idleTimeoutMs: 5_000,
    sweepIntervalMs: 60_000,
    healthCheckIntervalMs: 60_000,
    healthCheckTimeoutMs: 100,
    autoRebuildCooldownMs: 1_000,
  })

  return {
    service,
    sessionRegistry,
    workerManager,
    orchestrator,
    logger,
    subscriptions,
  }
}

describe('WorkerGovernanceService', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('reaps workers that have stayed idle past the configured timeout', async () => {
    const harness = createHarness()
    const now = Date.now()
    setSessionRecord(harness.sessionRegistry, {
      sessionId: 'session-1',
      agentId: 'agent-1',
      sessionScope: 'managed',
      workerRef: 'worker-1',
      sessionStatus: 'idle',
      createdAt: now - 20_000,
      updatedAt: now - 20_000,
    })
    harness.workerManager.list.mockReturnValue([
      { sessionId: 'session-1', workerRef: 'worker-1' },
    ])

    await (harness.service as any).sweep()

    expect(harness.workerManager.stop).toHaveBeenCalledWith('session-1')
    expect(harness.sessionRegistry.get('session-1')?.workerRef).toBeUndefined()
    expect(harness.logger.info).toHaveBeenCalledWith(
      'worker-governance:idle-reaped',
      expect.objectContaining({ sessionId: 'session-1', workerRef: 'worker-1' }),
    )
  })

  it('defers auto-rebuild until the session becomes idle', async () => {
    const harness = createHarness()
    setSessionRecord(harness.sessionRegistry, {
      sessionId: 'session-1',
      agentId: 'agent-1',
      sessionScope: 'managed',
      workerRef: 'worker-1',
      sessionStatus: 'running',
      activeRunId: 'run-1',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })

    await (harness.service as any).maybeAutoRebuild('session-1', 'worker_error')

    expect(harness.orchestrator.rebuildSession).not.toHaveBeenCalled()
    expect(harness.subscriptions.has('worker-governance:defer:session-1')).toBe(true)

    setSessionRecord(harness.sessionRegistry, {
      sessionId: 'session-1',
      agentId: 'agent-1',
      sessionScope: 'managed',
      workerRef: 'worker-1',
      sessionStatus: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    harness.subscriptions.get('worker-governance:defer:session-1')?.({
      kind: 'session_state_changed',
      sessionId: 'session-1',
      state: 'idle',
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.orchestrator.rebuildSession).toHaveBeenCalledWith('session-1')
    expect(harness.subscriptions.has('worker-governance:defer:session-1')).toBe(false)
  })

  it('marks failed health probes as unhealthy and triggers best-effort rebuild', async () => {
    const harness = createHarness()
    setSessionRecord(harness.sessionRegistry, {
      sessionId: 'session-1',
      agentId: 'agent-1',
      sessionScope: 'managed',
      workerRef: 'worker-1',
      sessionStatus: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    harness.orchestrator.requestControlSession.mockRejectedValue(new Error('mcp unavailable'))

    await (harness.service as any).probeWorkerHealth('session-1')

    expect(harness.service.getHealth('session-1')).toMatchObject({
      status: 'unhealthy',
      error: 'mcp unavailable',
    })
    expect(harness.orchestrator.rebuildSession).toHaveBeenCalledWith('session-1')
  })

  it('treats cooldown=0 as immediate rebuild instead of disabling auto-rebuild', async () => {
    const harness = createHarness()
    const immediate = new WorkerGovernanceService({
      workerManager: harness.workerManager as never,
      sessionRegistry: harness.sessionRegistry,
      orchestrator: harness.orchestrator as never,
      logger: harness.logger,
      idleTimeoutMs: 5_000,
      sweepIntervalMs: 60_000,
      healthCheckIntervalMs: 60_000,
      healthCheckTimeoutMs: 100,
      autoRebuildCooldownMs: 0,
    })

    setSessionRecord(harness.sessionRegistry, {
      sessionId: 'session-1',
      agentId: 'agent-1',
      sessionScope: 'managed',
      workerRef: 'worker-1',
      sessionStatus: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })

    await (immediate as any).maybeAutoRebuild('session-1', 'worker_error')

    expect(harness.orchestrator.rebuildSession).toHaveBeenCalledWith('session-1')
  })

  it('schedules crash retries with backoff for repeated worker_error events', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    setSessionRecord(harness.sessionRegistry, {
      sessionId: 'session-1',
      agentId: 'agent-1',
      sessionScope: 'managed',
      workerRef: 'worker-1',
      sessionStatus: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })

    ;(harness.service as any).scheduleCrashRetry('session-1', 'worker_error')
    expect(harness.orchestrator.rebuildSession).toHaveBeenCalledWith('session-1')

    ;(harness.service as any).scheduleCrashRetry('session-1', 'worker_error')
    expect(harness.logger.info).toHaveBeenCalledWith(
      'worker-governance:crash-retry:scheduled',
      expect.objectContaining({ sessionId: 'session-1', attempt: 2 }),
    )

    await vi.advanceTimersByTimeAsync(1_000)
    expect(harness.orchestrator.rebuildSession).toHaveBeenCalledTimes(2)
  })
})
