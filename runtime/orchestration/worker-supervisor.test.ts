import { describe, expect, it, vi } from 'vitest'
import type { WorkerOutputEvent } from '../execution/types.js'
import { WorkerSupervisor } from './worker-supervisor.js'
import { computeWorkerConfigSignature } from './worker-config-signature.js'
import { SessionRegistry } from './session-registry.js'
import type { AgentTemplate } from './types.js'

function createPendingOutput(): AsyncIterable<WorkerOutputEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise<void>(() => {})
    },
  }
}

function createAsyncQueue<T>() {
  const queued: T[] = []
  let done = false
  let resolver: ((value: IteratorResult<T>) => void) | null = null

  return {
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next(): Promise<IteratorResult<T>> {
            if (queued.length > 0) {
              return Promise.resolve({ value: queued.shift() as T, done: false })
            }
            if (done) {
              return Promise.resolve({ value: undefined as T, done: true })
            }
            return new Promise((resolve) => {
              resolver = resolve
            })
          },
        }
      },
    } satisfies AsyncIterable<T>,
    push(value: T) {
      if (resolver) {
        const current = resolver
        resolver = null
        current({ value, done: false })
        return
      }
      queued.push(value)
    },
    close() {
      done = true
      if (resolver) {
        const current = resolver
        resolver = null
        current({ value: undefined as T, done: true })
      }
    },
  }
}

const baseAgent: AgentTemplate = {
  agentId: 'agent-1',
  projectDir: '/tmp/project',
  model: 'claude-sonnet',
}

describe('WorkerSupervisor', () => {
  it('backfills the worker config signature when an existing session predates signatures', async () => {
    const sessionRegistry = new SessionRegistry()
    sessionRegistry.ensure('session-1', 'agent-1', {
      workerRef: 'worker-1',
      sessionStatus: 'idle',
    })

    const handle = {
      workerRef: 'worker-1',
      sessionId: 'session-1',
      input: { write: vi.fn() },
      output: createPendingOutput(),
      close: vi.fn(),
    }
    const workerManager = {
      get: vi.fn().mockReturnValue(handle),
      start: vi.fn(),
      stop: vi.fn(),
      remove: vi.fn(),
    }
    const supervisor = new WorkerSupervisor(
      {
        workerManager: workerManager as never,
        sessionRegistry,
      },
      {
        onWorkerEvent: vi.fn().mockResolvedValue(undefined),
      },
    )

    const result = await supervisor.ensureWorker('session-1', baseAgent, 'resume')

    expect(result).toBe(handle)
    expect(sessionRegistry.get('session-1')?.workerConfigSig).toBe(
      computeWorkerConfigSignature(baseAgent),
    )
    expect(workerManager.start).not.toHaveBeenCalled()
  })

  it('defers config-change rebuilds while the session is busy', async () => {
    const sessionRegistry = new SessionRegistry()
    sessionRegistry.ensure('session-1', 'agent-1', {
      workerRef: 'worker-1',
      workerConfigSig: 'legacy-signature',
      activeRunId: 'run-1',
      sessionStatus: 'running',
    })

    const existingHandle = {
      workerRef: 'worker-1',
      sessionId: 'session-1',
      input: { write: vi.fn() },
      output: createPendingOutput(),
      close: vi.fn(),
    }
    const workerManager = {
      get: vi.fn().mockReturnValue(existingHandle),
      start: vi.fn(),
      stop: vi.fn(),
      remove: vi.fn(),
    }
    const supervisor = new WorkerSupervisor(
      {
        workerManager: workerManager as never,
        sessionRegistry,
      },
      {
        onWorkerEvent: vi.fn().mockResolvedValue(undefined),
      },
    )

    const result = await supervisor.ensureWorker('session-1', baseAgent, 'resume')

    expect(result).toBe(existingHandle)
    expect(workerManager.stop).not.toHaveBeenCalled()
    expect(workerManager.start).not.toHaveBeenCalled()
  })

  it('rebuilds with a fresh worker once an idle session detects a config change', async () => {
    const sessionRegistry = new SessionRegistry()
    sessionRegistry.ensure('session-1', 'agent-1', {
      workerRef: 'worker-1',
      workerConfigSig: 'legacy-signature',
      sessionStatus: 'idle',
    })

    const oldHandle = {
      workerRef: 'worker-1',
      sessionId: 'session-1',
      input: { write: vi.fn() },
      output: createPendingOutput(),
      close: vi.fn(),
    }
    const newHandle = {
      workerRef: 'worker-2',
      sessionId: 'session-1',
      input: { write: vi.fn() },
      output: createPendingOutput(),
      close: vi.fn(),
    }
    const workerManager = {
      get: vi.fn().mockReturnValue(oldHandle),
      start: vi.fn().mockResolvedValue(newHandle),
      stop: vi.fn().mockResolvedValue(true),
      remove: vi.fn(),
    }
    const supervisor = new WorkerSupervisor(
      {
        workerManager: workerManager as never,
        sessionRegistry,
      },
      {
        onWorkerEvent: vi.fn().mockResolvedValue(undefined),
      },
    )

    const result = await supervisor.ensureWorker('session-1', baseAgent, 'resume')

    expect(workerManager.stop).toHaveBeenCalledWith('session-1')
    expect(workerManager.start).toHaveBeenCalledWith('session-1', baseAgent, 'resume')
    expect(result).toBe(newHandle)
    expect(sessionRegistry.get('session-1')).toMatchObject({
      workerRef: 'worker-2',
      workerConfigSig: computeWorkerConfigSignature(baseAgent),
    })
  })

  it('attaches worker output at most once per worker and cleans up after completion', async () => {
    const sessionRegistry = new SessionRegistry()
    sessionRegistry.ensure('session-1', 'agent-1', {
      workerRef: 'worker-1',
      sessionStatus: 'idle',
    })

    const queue = createAsyncQueue<WorkerOutputEvent>()
    const handle = {
      workerRef: 'worker-1',
      sessionId: 'session-1',
      input: { write: vi.fn() },
      output: queue.iterable,
      close: vi.fn(),
    }
    const workerManager = {
      get: vi.fn().mockReturnValue(handle),
      start: vi.fn(),
      stop: vi.fn(),
      remove: vi.fn(),
    }
    const onWorkerEvent = vi.fn().mockResolvedValue(undefined)
    const supervisor = new WorkerSupervisor(
      {
        workerManager: workerManager as never,
        sessionRegistry,
      },
      {
        onWorkerEvent,
      },
    )

    await supervisor.ensureWorker('session-1', baseAgent, 'resume')
    await supervisor.ensureWorker('session-1', baseAgent, 'resume')

    queue.push({
      kind: 'worker_closed',
      sessionId: 'session-1',
      receivedAt: 1,
    })
    queue.close()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onWorkerEvent).toHaveBeenCalledTimes(1)
    expect(workerManager.remove).toHaveBeenCalledWith('session-1')
    expect(sessionRegistry.get('session-1')?.workerRef).toBeUndefined()
  })

  it('does not let an old worker output finally block detach a newer worker', async () => {
    const sessionRegistry = new SessionRegistry()
    const oldAgent: AgentTemplate = {
      ...baseAgent,
      model: 'claude-old',
    }
    const newAgent: AgentTemplate = {
      ...baseAgent,
      model: 'claude-new',
    }
    const oldQueue = createAsyncQueue<WorkerOutputEvent>()
    const newQueue = createAsyncQueue<WorkerOutputEvent>()
    const oldHandle = {
      workerRef: 'worker-1',
      sessionId: 'session-1',
      input: { write: vi.fn() },
      output: oldQueue.iterable,
      close: vi.fn(),
    }
    const newHandle = {
      workerRef: 'worker-2',
      sessionId: 'session-1',
      input: { write: vi.fn() },
      output: newQueue.iterable,
      close: vi.fn(),
    }

    let currentHandle: typeof oldHandle | typeof newHandle | null = oldHandle
    const workerManager = {
      get: vi.fn(() => currentHandle),
      start: vi.fn(async () => {
        currentHandle = newHandle
        return newHandle
      }),
      stop: vi.fn(async () => {
        currentHandle = null
        return true
      }),
      remove: vi.fn((sessionId: string) => {
        if (currentHandle?.sessionId === sessionId) {
          currentHandle = null
        }
      }),
    }

    sessionRegistry.ensure('session-1', 'agent-1', {
      workerRef: 'worker-1',
      workerConfigSig: computeWorkerConfigSignature(oldAgent),
      sessionStatus: 'idle',
    })

    const supervisor = new WorkerSupervisor(
      {
        workerManager: workerManager as never,
        sessionRegistry,
      },
      {
        onWorkerEvent: vi.fn().mockResolvedValue(undefined),
      },
    )

    await supervisor.ensureWorker('session-1', oldAgent, 'resume')
    await supervisor.ensureWorker('session-1', newAgent, 'resume')

    expect(sessionRegistry.get('session-1')).toMatchObject({
      workerRef: 'worker-2',
      workerConfigSig: computeWorkerConfigSignature(newAgent),
    })

    oldQueue.close()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(workerManager.get()).toBe(newHandle)
    expect(sessionRegistry.get('session-1')).toMatchObject({
      workerRef: 'worker-2',
      workerConfigSig: computeWorkerConfigSignature(newAgent),
    })

    newQueue.close()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('keeps consuming worker output after a single callback failure', async () => {
    const sessionRegistry = new SessionRegistry()
    sessionRegistry.ensure('session-1', 'agent-1', {
      workerRef: 'worker-1',
      sessionStatus: 'idle',
    })

    const queue = createAsyncQueue<WorkerOutputEvent>()
    const handle = {
      workerRef: 'worker-1',
      sessionId: 'session-1',
      input: { write: vi.fn() },
      output: queue.iterable,
      close: vi.fn(),
    }
    const workerManager = {
      get: vi.fn().mockReturnValue(handle),
      start: vi.fn(),
      stop: vi.fn(),
      remove: vi.fn(),
    }
    const onWorkerEvent = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined)
    const supervisor = new WorkerSupervisor(
      {
        workerManager: workerManager as never,
        sessionRegistry,
      },
      {
        onWorkerEvent,
      },
    )

    await supervisor.ensureWorker('session-1', baseAgent, 'resume')

    queue.push({
      kind: 'worker_closed',
      sessionId: 'session-1',
      receivedAt: 1,
    })
    queue.push({
      kind: 'worker_closed',
      sessionId: 'session-1',
      receivedAt: 2,
    })
    queue.close()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onWorkerEvent).toHaveBeenCalledTimes(2)
    expect(workerManager.remove).toHaveBeenCalledWith('session-1')
  })
})
