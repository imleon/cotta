import { describe, expect, it, vi } from 'vitest'
import { RunRegistry } from './run-registry.js'
import { SessionLifecycleService } from './session-lifecycle-service.js'
import { SessionRegistry } from './session-registry.js'

describe('SessionLifecycleService', () => {
  it('fails the active run when a session is stopped manually', async () => {
    const sessionRegistry = new SessionRegistry()
    const runRegistry = new RunRegistry()
    sessionRegistry.ensure('session-1', 'agent-1', {
      activeRunId: 'run-1',
      sessionStatus: 'running',
    })
    runRegistry.create('session-1', 'run-1')

    const workerSupervisor = {
      stopWorker: vi.fn().mockResolvedValue(true),
    }

    const service = new SessionLifecycleService({
      sessionRegistry,
      runRegistry,
      workerSupervisor: workerSupervisor as never,
      requestInterrupt: vi.fn(),
      waitForIdle: vi.fn(),
    })

    const result = await service.stopSession('session-1')

    expect(result).toEqual({
      sessionId: 'session-1',
      stopped: true,
      hadActiveRun: true,
    })
    expect(workerSupervisor.stopWorker).toHaveBeenCalledWith('session-1')
    expect(runRegistry.get('run-1')).toMatchObject({
      runStatus: 'error_during_execution',
      resultSummary: {
        kind: 'error_during_execution',
        title: 'Session Stopped',
      },
    })
  })

  it('aborts recovery when interrupt cannot be requested for an active run', async () => {
    const sessionRegistry = new SessionRegistry()
    const runRegistry = new RunRegistry()
    sessionRegistry.ensure('session-1', 'agent-1', {
      activeRunId: 'run-1',
      sessionStatus: 'running',
    })
    runRegistry.create('session-1', 'run-1')

    const workerSupervisor = {
      stopWorker: vi.fn().mockResolvedValue(true),
    }
    const requestInterrupt = vi.fn().mockRejectedValue(new Error('worker already gone'))
    const waitForIdle = vi.fn().mockResolvedValue(false)

    const service = new SessionLifecycleService({
      sessionRegistry,
      runRegistry,
      workerSupervisor: workerSupervisor as never,
      requestInterrupt,
      waitForIdle,
    })

    const result = await service.recoverSession('session-1', { interruptTimeoutMs: 250 })

    expect(requestInterrupt).toHaveBeenCalledWith('session-1')
    expect(waitForIdle).not.toHaveBeenCalled()
    expect(workerSupervisor.stopWorker).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      sessionId: 'session-1',
      stopped: false,
      rebuilt: false,
      hadActiveRun: true,
      interruptRequested: false,
      interruptError: 'worker already gone',
      idleObserved: false,
      aborted: true,
      abortReason: 'interrupt_failed',
    })
    expect(result.interruptWaitMs).toBeTypeOf('number')
  })

  it('records a successful interrupt request and idle observation during recovery', async () => {
    const sessionRegistry = new SessionRegistry()
    const runRegistry = new RunRegistry()
    sessionRegistry.ensure('session-1', 'agent-1', {
      activeRunId: 'run-1',
      sessionStatus: 'running',
    })
    runRegistry.create('session-1', 'run-1')

    const workerSupervisor = {
      stopWorker: vi.fn().mockResolvedValue(true),
    }
    const requestInterrupt = vi.fn().mockResolvedValue({ requestId: 'interrupt-1' })
    const waitForIdle = vi.fn().mockResolvedValue(true)

    const service = new SessionLifecycleService({
      sessionRegistry,
      runRegistry,
      workerSupervisor: workerSupervisor as never,
      requestInterrupt,
      waitForIdle,
    })

    const result = await service.recoverSession('session-1', { interruptTimeoutMs: 500 })

    expect(result).toMatchObject({
      sessionId: 'session-1',
      stopped: true,
      rebuilt: true,
      hadActiveRun: true,
      interruptRequested: true,
      interruptRequestId: 'interrupt-1',
      idleObserved: true,
    })
    expect(waitForIdle).toHaveBeenCalledWith('session-1', 500)
  })

  it('aborts recovery when stop fails after a successful interrupt flow', async () => {
    const sessionRegistry = new SessionRegistry()
    const runRegistry = new RunRegistry()
    sessionRegistry.ensure('session-1', 'agent-1', {
      activeRunId: 'run-1',
      sessionStatus: 'running',
    })
    runRegistry.create('session-1', 'run-1')

    const workerSupervisor = {
      stopWorker: vi.fn().mockResolvedValue(false),
    }
    const requestInterrupt = vi.fn().mockResolvedValue({ requestId: 'interrupt-1' })
    const waitForIdle = vi.fn().mockResolvedValue(true)

    const service = new SessionLifecycleService({
      sessionRegistry,
      runRegistry,
      workerSupervisor: workerSupervisor as never,
      requestInterrupt,
      waitForIdle,
    })

    const result = await service.recoverSession('session-1', { interruptTimeoutMs: 500 })

    expect(result).toMatchObject({
      sessionId: 'session-1',
      stopped: false,
      rebuilt: false,
      hadActiveRun: true,
      interruptRequested: true,
      interruptRequestId: 'interrupt-1',
      idleObserved: true,
      aborted: true,
      abortReason: 'stop_failed',
    })
  })

  it('fails rebuild when stop does not succeed', async () => {
    const sessionRegistry = new SessionRegistry()
    const runRegistry = new RunRegistry()
    sessionRegistry.ensure('session-1', 'agent-1', {
      sessionStatus: 'idle',
      workerRef: 'worker-1',
    })

    const workerSupervisor = {
      stopWorker: vi.fn().mockResolvedValue(false),
    }

    const service = new SessionLifecycleService({
      sessionRegistry,
      runRegistry,
      workerSupervisor: workerSupervisor as never,
      requestInterrupt: vi.fn(),
      waitForIdle: vi.fn(),
    })

    await expect(service.rebuildSession('session-1')).rejects.toThrow(
      'Failed to stop session before rebuild: session-1',
    )
  })
})
