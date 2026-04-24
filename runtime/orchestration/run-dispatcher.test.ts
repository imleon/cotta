import { describe, expect, it, vi } from 'vitest'
import { RunRegistry } from './run-registry.js'
import { RunDispatcher, SessionBusyError } from './run-dispatcher.js'
import { SessionRegistry } from './session-registry.js'

function createHarness() {
  const sessionRegistry = new SessionRegistry()
  const runRegistry = new RunRegistry()
  const workerInput = {
    write: vi.fn().mockResolvedValue(undefined),
  }
  const workerHandle = {
    workerRef: 'worker-1',
    sessionId: 'session-1',
    input: workerInput,
    output: {
      async *[Symbol.asyncIterator]() {},
    },
    close: vi.fn(),
  }
  const workerSupervisor = {
    ensureWorker: vi.fn().mockResolvedValue(workerHandle),
  }
  const persistSyntheticUserMessage = vi.fn().mockResolvedValue(undefined)
  const dispatcher = new RunDispatcher({
    configRegistry: {
      getAgent: vi.fn().mockReturnValue({
        agentId: 'agent-1',
        projectDir: '/tmp/project',
      }),
    } as never,
    sessionRegistry,
    runRegistry,
    workerSupervisor: workerSupervisor as never,
    persistSyntheticUserMessage,
  })

  return {
    dispatcher,
    sessionRegistry,
    runRegistry,
    workerSupervisor,
    persistSyntheticUserMessage,
    workerInput,
  }
}

describe('RunDispatcher', () => {
  it('blocks a new message run when the session already has an active running request', async () => {
    const harness = createHarness()
    harness.sessionRegistry.ensure('session-1', 'agent-1', {
      activeRunId: 'run-active',
      sessionStatus: 'running',
    })

    await expect(harness.dispatcher.dispatchRun({
      sessionId: 'session-1',
      agentId: 'agent-1',
      text: 'hello',
    })).rejects.toBeInstanceOf(SessionBusyError)
    expect(harness.workerSupervisor.ensureWorker).not.toHaveBeenCalled()
  })

  it('allows control requests even while the session is busy', async () => {
    const harness = createHarness()
    harness.sessionRegistry.ensure('session-1', 'agent-1', {
      activeRunId: 'run-active',
      sessionStatus: 'running',
    })

    const result = await harness.dispatcher.requestControlSession('session-1', 'interrupt')

    expect(result.sessionId).toBe('session-1')
    expect(result.requestId.startsWith('interrupt:')).toBe(true)
    expect(harness.workerSupervisor.ensureWorker).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ agentId: 'agent-1' }),
      'resume',
    )
    expect(harness.workerInput.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'control',
        subtype: 'interrupt',
      }),
    )
  })

  it('persists the synthetic user message before sending the worker query', async () => {
    const harness = createHarness()
    const callOrder: string[] = []
    harness.persistSyntheticUserMessage.mockImplementation(async (input: { runId: string }) => {
      callOrder.push(`persist:${input.runId}`)
    })
    harness.workerInput.write.mockImplementation(async (input: { runId: string }) => {
      callOrder.push(`write:${input.runId}`)
    })

    const result = await harness.dispatcher.dispatchRun({
      sessionId: 'session-1',
      agentId: 'agent-1',
      text: 'hello',
    })

    expect(result.sessionId).toBe('session-1')
    expect(callOrder).toHaveLength(2)
    expect(callOrder[0].startsWith('persist:')).toBe(true)
    expect(callOrder[1]).toBe(callOrder[0].replace('persist:', 'write:'))
    expect(harness.sessionRegistry.get('session-1')?.activeRunId).toBe(result.runId)
    expect(harness.runRegistry.get(result.runId)).toMatchObject({
      sessionId: 'session-1',
      runStatus: 'running',
    })
  })
})
