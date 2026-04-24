import { describe, expect, it, vi } from 'vitest'
import { Orchestrator } from './orchestrator.js'
import { RunRegistry } from './run-registry.js'
import { SessionRegistry } from './session-registry.js'
import type { AgentTemplate } from './types.js'

const agent: AgentTemplate = {
  agentId: 'agent-1',
  projectDir: '/tmp/project',
  model: 'claude-sonnet',
}

function createOrchestratorHarness() {
  const sessionRegistry = new SessionRegistry()
  const runRegistry = new RunRegistry()
  const sdkRawLogWriter = vi.fn().mockResolvedValue(undefined)
  const configRegistry = {
    getAgent: vi.fn().mockReturnValue(agent),
  }
  const workerManager = {
    get: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    remove: vi.fn(),
  }
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  const orchestrator = new Orchestrator({
    configRegistry: configRegistry as never,
    sessionRegistry,
    runRegistry,
    workerManager: workerManager as never,
    logger,
    sdkRawLogWriter,
  })

  return {
    orchestrator,
    sessionRegistry,
    runRegistry,
    configRegistry,
    logger,
    sdkRawLogWriter,
  }
}

describe('Orchestrator', () => {
  it('clears the active run on idle and lazily stops stale workers instead of eagerly rebuilding', async () => {
    const harness = createOrchestratorHarness()
    harness.sessionRegistry.ensure('session-1', 'agent-1', {
      workerRef: 'worker-1',
      workerConfigSig: 'legacy-signature',
      sessionStatus: 'running',
      activeRunId: 'run-1',
    })
    harness.runRegistry.create('session-1', 'run-1')

    const workerSupervisor = (harness.orchestrator as any).workerSupervisor
    vi.spyOn(workerSupervisor, 'getWorker').mockReturnValue({ workerRef: 'worker-1' })
    vi.spyOn(workerSupervisor, 'stopWorker').mockResolvedValue(true)

    await (harness.orchestrator as any).handleWorkerOutput({
      kind: 'session_state_changed',
      sessionId: 'session-1',
      runId: 'run-1',
      receivedAt: 1,
      state: 'idle',
      payload: null,
    })

    expect(harness.sessionRegistry.get('session-1')).toMatchObject({
      sessionStatus: 'idle',
      activeRunId: undefined,
    })
    expect(workerSupervisor.stopWorker).toHaveBeenCalledWith('session-1')
  })

  it('marks successful results complete and clears the active run', async () => {
    const harness = createOrchestratorHarness()
    harness.sessionRegistry.ensure('session-1', 'agent-1', {
      sessionStatus: 'idle',
      activeRunId: 'run-1',
    })
    harness.runRegistry.create('session-1', 'run-1')

    const workerSupervisor = (harness.orchestrator as any).workerSupervisor
    vi.spyOn(workerSupervisor, 'getWorker').mockReturnValue(null)
    vi.spyOn(workerSupervisor, 'ensureWorker').mockResolvedValue({ workerRef: 'worker-2' })

    await (harness.orchestrator as any).handleWorkerOutput({
      kind: 'result',
      sessionId: 'session-1',
      runId: 'run-1',
      receivedAt: 2,
      subtype: 'success',
      payload: { ok: true },
    })

    expect(harness.runRegistry.get('run-1')).toMatchObject({
      runStatus: 'success',
      resultSummary: { kind: 'success' },
    })
    expect(harness.sessionRegistry.get('session-1')?.activeRunId).toBeUndefined()
    expect(workerSupervisor.ensureWorker).not.toHaveBeenCalled()
  })

  it('persists sdk raw messages with monotonic per-run sequence numbers', async () => {
    const harness = createOrchestratorHarness()

    await (harness.orchestrator as any).handleWorkerOutput({
      kind: 'sdk_message',
      sessionId: 'session-1',
      runId: 'run-1',
      receivedAt: 10,
      payload: { type: 'assistant', message: { id: 'm-1', content: [] } },
    })
    await (harness.orchestrator as any).handleWorkerOutput({
      kind: 'control_message',
      sessionId: 'session-1',
      runId: 'run-1',
      receivedAt: 11,
      direction: 'host_to_sdk',
      message: { type: 'control_request', subtype: 'interrupt' },
      transaction: {
        requestId: 'req-1',
        subtype: 'interrupt',
        family: 'control',
      },
    })

    expect(harness.sdkRawLogWriter).toHaveBeenNthCalledWith(
      1,
      'run-1',
      expect.objectContaining({
        source: 'sdk-raw',
        kind: 'sdk_message',
        direction: 'sdk_to_host',
        sessionId: 'session-1',
        sequence: 1,
      }),
    )
    expect(harness.sdkRawLogWriter).toHaveBeenNthCalledWith(
      2,
      'run-1',
      expect.objectContaining({
        source: 'sdk-raw',
        kind: 'control_request',
        direction: 'host_to_sdk',
        requestId: 'req-1',
        subtype: 'interrupt',
        sessionId: 'session-1',
        sequence: 2,
      }),
    )
  })

  it('escalates sdk raw persistence failures and emits a single session notice per run', async () => {
    const harness = createOrchestratorHarness()
    const sessionSubscriber = vi.fn()
    harness.orchestrator.subscribeSessionEvents('raw-log-failure', sessionSubscriber)
    harness.sdkRawLogWriter.mockRejectedValueOnce(new Error('disk full'))
      .mockRejectedValueOnce(new Error('still full'))

    await expect((harness.orchestrator as any).handleWorkerOutput({
      kind: 'sdk_message',
      sessionId: 'session-1',
      runId: 'run-1',
      receivedAt: 12,
      payload: { type: 'assistant', message: { id: 'm-2', content: [] } },
    })).resolves.toBeUndefined()

    await expect((harness.orchestrator as any).persistSyntheticUserMessage({
      sessionId: 'session-1',
      runId: 'run-1',
      text: 'hello from host',
    })).resolves.toBeUndefined()

    expect(harness.logger.error).toHaveBeenCalledWith(
      'orchestrator:sdk-raw-log:append-failed',
      expect.objectContaining({
        sessionId: 'session-1',
        runId: 'run-1',
        kind: 'sdk_message',
        error: 'disk full',
      }),
    )
    expect(harness.logger.error).toHaveBeenCalledWith(
      'orchestrator:synthetic-user-log:append-failed',
      expect.objectContaining({
        sessionId: 'session-1',
        runId: 'run-1',
        error: 'still full',
      }),
    )
    const rawLogFailureNotices = sessionSubscriber.mock.calls
      .map(([event]) => event)
      .filter((event) => event?.type === 'session.error' && event?.error === 'SDK raw log persistence failed; audit trail may be incomplete.')
    expect(rawLogFailureNotices).toEqual([
      {
        type: 'session.error',
        sessionId: 'session-1',
        runId: 'run-1',
        error: 'SDK raw log persistence failed; audit trail may be incomplete.',
      },
    ])
  })

  it('refreshes idle sessions after config changes without starting new workers for missing sessions', async () => {
    const harness = createOrchestratorHarness()
    const workerSupervisor = (harness.orchestrator as any).workerSupervisor
    // Ensure the session exists and is idle with an attached worker + signature.
    harness.sessionRegistry.ensure('session-1', 'agent-1', {
      sessionStatus: 'idle',
      workerRef: 'worker-1',
      workerConfigSig: 'sig-old',
    })
    vi.spyOn(workerSupervisor, 'getWorker').mockReturnValue({
      sessionId: 'session-1',
      workerRef: 'worker-1',
      output: (async function* () {})(),
    } as any)
    vi.spyOn(workerSupervisor, 'ensureWorker').mockImplementation(async (_sessionId, nextAgent: any) => {
      harness.sessionRegistry.setWorkerConfigSig('session-1', JSON.stringify({ model: nextAgent.model }))
      return { workerRef: 'worker-2' } as any
    })
    vi.spyOn(workerSupervisor, 'stopWorker').mockResolvedValue(true)
    // Make sure configRegistry returns an agent whose signature differs.
    vi.spyOn(harness.configRegistry, 'getAgent').mockReturnValue({
      agentId: 'agent-1',
      projectDir: '/tmp/project',
      model: 'claude-new',
    } as any)

    await expect(harness.orchestrator.refreshConfigDependentSessions()).resolves.toMatchObject({
      checked: 1,
    })

    // Rebuild path stops and restarts the worker when idle + signature changed.
    expect(workerSupervisor.ensureWorker).toHaveBeenCalledWith('session-1', expect.objectContaining({
      agentId: 'agent-1',
      model: 'claude-new',
    }), 'resume')
  })

  it('fails the active run when the worker crashes unexpectedly', async () => {
    const harness = createOrchestratorHarness()
    const workerSupervisor = (harness.orchestrator as any).workerSupervisor
    vi.spyOn(workerSupervisor, 'getWorker').mockReturnValue({ workerRef: 'worker-1' } as any)

    harness.sessionRegistry.ensure('session-1', 'agent-1', {
      sessionStatus: 'running',
      activeRunId: 'run-1',
      workerRef: 'worker-1',
    })
    harness.runRegistry.create('session-1', 'run-1')

    const sessionSubscriber = vi.fn()
    harness.orchestrator.subscribeSessionEvents('test-worker-crash', sessionSubscriber)

    await (harness.orchestrator as any).handleWorkerOutput({
      kind: 'worker_error',
      sessionId: 'session-1',
      runId: 'run-1',
      receivedAt: 123,
      error: 'boom',
    })

    expect(harness.runRegistry.get('run-1')).toMatchObject({
      runStatus: 'error_during_execution',
    })
    const failed = sessionSubscriber.mock.calls
      .map(([event]) => event)
      .filter((event) => event?.type === 'session.run.failed')
    expect(failed).toEqual([
      { type: 'session.run.failed', runId: 'run-1', sessionId: 'session-1', error: 'error_during_execution' },
    ])
  })

  it('rebuildSession stops and then re-ensures the worker', async () => {
    const harness = createOrchestratorHarness()
    const workerSupervisor = (harness.orchestrator as any).workerSupervisor
    vi.spyOn(workerSupervisor, 'stopWorker').mockResolvedValue(true)
    vi.spyOn(workerSupervisor, 'ensureWorker').mockResolvedValue({ workerRef: 'worker-2' })

    harness.sessionRegistry.ensure('session-1', 'agent-1', {
      sessionStatus: 'idle',
      workerRef: 'worker-1',
    })

    await expect(harness.orchestrator.rebuildSession('session-1')).resolves.toMatchObject({
      sessionId: 'session-1',
      rebuilt: true,
    })
    expect(workerSupervisor.ensureWorker).toHaveBeenCalledWith('session-1', expect.any(Object), 'resume')
  })

  it('does not re-ensure the worker when rebuild stop fails', async () => {
    const harness = createOrchestratorHarness()
    const workerSupervisor = (harness.orchestrator as any).workerSupervisor
    vi.spyOn(workerSupervisor, 'stopWorker').mockResolvedValue(false)
    const ensureWorker = vi.spyOn(workerSupervisor, 'ensureWorker').mockResolvedValue({ workerRef: 'worker-2' })

    harness.sessionRegistry.ensure('session-1', 'agent-1', {
      sessionStatus: 'idle',
      workerRef: 'worker-1',
    })

    await expect(harness.orchestrator.rebuildSession('session-1')).rejects.toThrow(
      'Failed to stop session before rebuild: session-1',
    )
    expect(ensureWorker).not.toHaveBeenCalled()
  })

  it('persists synthetic user messages as sdk raw host_to_sdk entries', async () => {
    const harness = createOrchestratorHarness()

    await (harness.orchestrator as any).persistSyntheticUserMessage({
      sessionId: 'session-1',
      runId: 'run-1',
      text: 'hello from host',
    })

    expect(harness.sdkRawLogWriter).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        source: 'sdk-raw',
        kind: 'sdk_message',
        direction: 'host_to_sdk',
        sessionId: 'session-1',
        message: {
          type: 'synthetic_user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'hello from host' }],
          },
        },
      }),
    )
  })

  it('resolves waitForSessionIdle once an idle state change is broadcast', async () => {
    const harness = createOrchestratorHarness()

    const wait = (harness.orchestrator as any).waitForSessionIdle('session-1', 500)
    ;(harness.orchestrator as any).broadcast({
      kind: 'session_state_changed',
      sessionId: 'session-1',
      receivedAt: 20,
      state: 'idle',
      payload: null,
    })

    await expect(wait).resolves.toBe(true)
  })

  it('resolves waitForSessionIdle immediately when the session is already idle', async () => {
    const harness = createOrchestratorHarness()
    harness.sessionRegistry.ensure('session-1', 'agent-1', {
      sessionStatus: 'idle',
    })

    await expect((harness.orchestrator as any).waitForSessionIdle('session-1', 500)).resolves.toBe(true)
  })

  it('routes control transactions through the interaction coordinator and publishes mapped session events', async () => {
    const harness = createOrchestratorHarness()
    const interactionCoordinator = (harness.orchestrator as any).interactionCoordinator
    const onControlTransaction = vi.spyOn(interactionCoordinator, 'onControlTransaction')
    const sessionSubscriber = vi.fn()
    harness.orchestrator.subscribeSessionEvents('test-subscriber', sessionSubscriber)

    await (harness.orchestrator as any).handleWorkerOutput({
      kind: 'control_transaction',
      sessionId: 'session-1',
      runId: 'run-1',
      receivedAt: 21,
      phase: 'awaiting_user',
      transaction: {
        requestId: 'request-1',
        subtype: 'interrupt',
        family: 'interactive',
      },
      payload: { prompt: 'approve?' },
    })

    expect(onControlTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'control_transaction',
        sessionId: 'session-1',
        runId: 'run-1',
      }),
    )
    expect(sessionSubscriber).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session.interactive.awaiting_user',
        sessionId: 'session-1',
        runId: 'run-1',
      }),
    )
  })
})
