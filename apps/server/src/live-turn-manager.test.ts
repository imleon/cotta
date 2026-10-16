import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { queryMock, statMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  statMock: vi.fn().mockResolvedValue({ isDirectory: () => true }),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}))
vi.mock('node:fs/promises', () => ({ stat: statMock }))

import { type LiveTurnEvent, LiveTurnManager, ProjectDirectoryUnavailableError, SessionExternallyOwnedError, SessionTurnInProgressError } from './live-turn-manager.js'

function queryFromGenerator(generator: AsyncGenerator<SDKMessage>, overrides: Partial<Query> = {}): Query {
  return Object.assign(generator, {
    close: vi.fn(),
    interrupt: vi.fn(),
    setPermissionMode: vi.fn(),
    setModel: vi.fn(),
    applyFlagSettings: vi.fn(),
    initializationResult: vi.fn().mockResolvedValue({}),
    getContextUsage: vi.fn().mockResolvedValue({ categories: [], totalTokens: 0, maxTokens: 200_000, percentage: 0 }),
    ...overrides,
  }) as unknown as Query
}

function streamingQuery(prompt: AsyncIterable<SDKUserMessage>, overrides: Partial<Query> = {}): Query {
  return queryFromGenerator(
    (async function* () {
      for await (const message of prompt) {
        yield message
        yield { type: 'result', subtype: 'success' } as SDKMessage
      }
    })(),
    overrides,
  )
}

function failingQuery(prompt: AsyncIterable<SDKUserMessage>): Query {
  return queryFromGenerator(
    (async function* () {
      for await (const message of prompt) {
        yield message
        throw new Error('SDK stream failed')
      }
    })(),
  )
}

function endingQuery(prompt: AsyncIterable<SDKUserMessage>): Query {
  return queryFromGenerator(
    (async function* () {
      for await (const _message of prompt) return
    })(),
  )
}

function resultOnlyQuery(prompt: AsyncIterable<SDKUserMessage>, overrides: Partial<Query> = {}): Query {
  return queryFromGenerator(
    (async function* () {
      for await (const _message of prompt) yield { type: 'result', subtype: 'success' } as SDKMessage
    })(),
    overrides,
  )
}

function slashCommandQuery(prompt: AsyncIterable<SDKUserMessage>, messages: SDKMessage[]): Query {
  return queryFromGenerator(
    (async function* () {
      for await (const _message of prompt) {
        for (const message of messages) yield message
        yield { type: 'result', subtype: 'success' } as SDKMessage
      }
    })(),
  )
}

function assistantResultQuery(prompt: AsyncIterable<SDKUserMessage>, overrides: Partial<Query> = {}): Query {
  return queryFromGenerator(
    (async function* () {
      for await (const _message of prompt) {
        yield { type: 'stream_event', event: { type: 'content_block_delta' } } as unknown as SDKMessage
        yield { type: 'assistant', message: { id: 'message-1', role: 'assistant', content: [{ type: 'text', text: 'done' }] } } as SDKMessage
        yield { type: 'result', subtype: 'success' } as SDKMessage
      }
    })(),
    overrides,
  )
}

function backgroundLifecycleQuery(prompt: AsyncIterable<SDKUserMessage>): Query {
  return queryFromGenerator(
    (async function* () {
      for await (const _message of prompt) {
        yield { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'task-a', task_type: 'local_agent', description: 'A' }] } as SDKMessage
        yield { type: 'result', subtype: 'success' } as SDKMessage
        yield {
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [
            { task_id: 'task-a', task_type: 'local_agent', description: 'A' },
            { task_id: 'task-b', task_type: 'local_agent', description: 'B' },
            { task_id: 'task-c', task_type: 'local_agent', description: 'C', ambient: true },
          ],
        } as SDKMessage
      }
    })(),
  )
}

function sessionLifecycleQuery(prompt: AsyncIterable<SDKUserMessage>): Query {
  return queryFromGenerator(
    (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'session-1' } as SDKMessage
      for await (const _message of prompt) {
        yield { type: 'result', subtype: 'success' } as SDKMessage
        yield { type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed' } as SDKMessage
      }
    })(),
  )
}

function detachedResultQuery(): Query {
  return queryFromGenerator(
    (async function* () {
      yield { type: 'result', subtype: 'success' } as SDKMessage
    })(),
  )
}

function requiresActionQuery(prompt: AsyncIterable<SDKUserMessage>): Query {
  return queryFromGenerator(
    (async function* () {
      for await (const _message of prompt) {
        yield { type: 'system', subtype: 'session_state_changed', state: 'requires_action' } as SDKMessage
        yield { type: 'result', subtype: 'success' } as SDKMessage
      }
    })(),
  )
}

function pendingQuery(prompt: AsyncIterable<SDKUserMessage>, overrides: Partial<Query> = {}): Query {
  return queryFromGenerator(
    (async function* () {
      for await (const message of prompt) yield message
    })(),
    overrides,
  )
}

function planModeQuery(prompt: AsyncIterable<SDKUserMessage>): Query {
  return queryFromGenerator(
    (async function* () {
      for await (const _message of prompt) yield { type: 'system', subtype: 'status', status: null, permissionMode: 'plan' } as SDKMessage
    })(),
  )
}

describe('LiveTurnManager', () => {
  beforeEach(() => {
    queryMock.mockReset()
    statMock.mockReset().mockResolvedValue({ isDirectory: () => true })
  })

  afterEach(() => vi.restoreAllMocks())

  it('returns the SDK initialization result after ensuring runtime', async () => {
    const initializationResult = { models: [{ value: 'model-a' }], raw: { source: 'sdk' } }
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
      pendingQuery(prompt, { initializationResult: vi.fn().mockResolvedValue(initializationResult) } as Partial<Query>),
    )
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await expect(manager.ensureRuntime({ projectId, sessionId: 'session-1' })).resolves.toBe(initializationResult)
  })

  it('passes auto-compact percent to SDK subprocess env when configured', async () => {
    process.env.COTTA_TEST_ENV = 'kept'
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const settingsStore = { getAll: () => ({ autoCompactPercent: 80 }) }
    const manager = new LiveTurnManager(undefined, undefined, undefined, settingsStore as never)
    const projectId = Buffer.from('/repo/a').toString('base64url')

    try {
      await manager.ensureRuntime({ projectId, sessionId: 'session-1' })

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            env: expect.objectContaining({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80', COTTA_TEST_ENV: 'kept' }),
          }),
        }),
      )
    } finally {
      delete process.env.COTTA_TEST_ENV
    }
  })

  it('updates session options when ensuring an existing runtime', async () => {
    const setPermissionMode = vi.fn()
    const setModel = vi.fn()
    const applyFlagSettings = vi.fn()
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { setPermissionMode, setModel, applyFlagSettings }))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.ensureRuntime({ projectId, sessionId: 'session-1', permissionMode: 'default', model: 'claude-opus-5', effort: 'high' })
    await manager.ensureRuntime({ projectId, sessionId: 'session-1', permissionMode: 'plan', model: 'claude-sonnet-5', effort: 'max' })

    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(setPermissionMode).toHaveBeenCalledWith('plan')
    expect(setModel).not.toHaveBeenCalled()
    expect(applyFlagSettings).toHaveBeenCalledWith({ model: 'claude-sonnet-5', effortLevel: 'max' })
  })

  it('tracks permission mode from SDK init and status messages', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123)
    const setPermissionMode = vi.fn()
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
      queryFromGenerator(
        (async function* () {
          yield { type: 'system', subtype: 'init', permissionMode: 'auto' } as SDKMessage
          yield { type: 'system', subtype: 'status', status: 'requesting' } as SDKMessage
          yield { type: 'system', subtype: 'status', status: null, permissionMode: 'plan' } as SDKMessage
          yield { type: 'system', subtype: 'status', status: null, permissionMode: 'auto' } as SDKMessage
          for await (const message of prompt) yield message
        })(),
        { setPermissionMode },
      ),
    )
    const onPermissionModeChanged = vi.fn()
    const manager = new LiveTurnManager({ onPermissionModeChanged })
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.ensureRuntime({ projectId, sessionId: 'session-1', permissionMode: 'default' })
    await vi.waitFor(() =>
      expect(onPermissionModeChanged.mock.calls.map(([input]) => input)).toEqual([
        { sessionId: 'session-1', projectId, mode: 'auto', observedAtMs: 123 },
        { sessionId: 'session-1', projectId, mode: 'plan', observedAtMs: 123 },
        { sessionId: 'session-1', projectId, mode: 'auto', observedAtMs: 123 },
      ]),
    )
    setPermissionMode.mockClear()
    await manager.syncExistingRuntimeOptions({ projectId, sessionId: 'session-1', permissionMode: 'auto' })

    expect(setPermissionMode).not.toHaveBeenCalled()
  })

  it('closes the runtime when SDK permission mode persistence fails', async () => {
    const close = vi.fn()
    queryMock.mockImplementation(() =>
      queryFromGenerator(
        (async function* () {
          yield { type: 'system', subtype: 'status', status: null, permissionMode: 'plan' } as SDKMessage
          yield { type: 'system', subtype: 'status', status: null, permissionMode: 'auto' } as SDKMessage
        })(),
        { close },
      ),
    )
    const onPermissionModeChanged = vi.fn(() => {
      throw new Error('database unavailable')
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const manager = new LiveTurnManager({ onPermissionModeChanged })
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.ensureRuntime({ projectId, sessionId: 'session-1', permissionMode: 'default' })
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())

    expect(onPermissionModeChanged).toHaveBeenCalledOnce()
    expect(onPermissionModeChanged).toHaveBeenCalledWith({ sessionId: 'session-1', projectId, mode: 'plan', observedAtMs: expect.any(Number) })
  })

  it('syncs options only when a runtime already exists', async () => {
    const setPermissionMode = vi.fn()
    const setModel = vi.fn()
    const applyFlagSettings = vi.fn()
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { setPermissionMode, setModel, applyFlagSettings }))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await expect(manager.syncExistingRuntimeOptions({ projectId, sessionId: 'missing', permissionMode: 'plan', model: 'claude-sonnet-5', effort: 'xhigh' })).resolves.toBe(false)
    expect(queryMock).not.toHaveBeenCalled()

    await manager.ensureRuntime({ projectId, sessionId: 'session-1', permissionMode: 'default', model: 'claude-opus-5', effort: 'high' })
    await expect(manager.syncExistingRuntimeOptions({ projectId, sessionId: 'session-1', permissionMode: 'plan', model: 'claude-sonnet-5', effort: 'xhigh' })).resolves.toBe(true)

    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(setPermissionMode).toHaveBeenCalledWith('plan')
    expect(setModel).not.toHaveBeenCalled()
    expect(applyFlagSettings).toHaveBeenCalledWith({ model: 'claude-sonnet-5', effortLevel: 'xhigh' })
  })

  it('does not publish SDK replay feedback from runtime option changes', async () => {
    queryMock.mockImplementation(() =>
      queryFromGenerator(
        (async function* () {
          yield {
            type: 'user',
            message: { role: 'user', content: '<local-command-stdout>Set model to `claude-sonnet-5`</local-command-stdout>' },
            uuid: 'replay',
            isReplay: true,
          } as unknown as SDKMessage
          yield { type: 'system', subtype: 'status', status: null } as SDKMessage
          await new Promise(() => {})
        })(),
      ),
    )
    const manager = new LiveTurnManager()
    const events: LiveTurnEvent[] = []
    manager.subscribe('session-1', (event) => events.push(event))

    await manager.ensureRuntime({ projectId: Buffer.from('/repo/a').toString('base64url'), sessionId: 'session-1' })

    await vi.waitFor(() => expect(events).toEqual([{ type: 'system', subtype: 'status', status: null }]))
  })

  it('refreshes and serves context usage from the current runtime', async () => {
    const getContextUsage = vi.fn().mockResolvedValueOnce({
      model: 'claude-sonnet-5',
      categories: [
        { name: 'Messages', tokens: 10, kind: 'used' },
        { name: 'Free space', tokens: 150, kind: 'free' },
        { name: 'System prompt', tokens: 25, kind: 'buffer' },
        { name: 'Deferred tools', tokens: 15, kind: 'deferred' },
      ],
      totalTokens: 10,
      maxTokens: 200,
      percentage: 5,
    })
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { getContextUsage } as Partial<Query>))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.ensureRuntime({ projectId, sessionId: 'session-1' })
    await expect(manager.contextUsage('session-1')).resolves.toEqual({
      model: 'claude-sonnet-5',
      categories: [
        { name: 'Messages', tokens: 10, kind: 'used' },
        { name: 'Free space', tokens: 150, kind: 'free' },
        { name: 'System prompt', tokens: 25, kind: 'buffer' },
        { name: 'Deferred tools', tokens: 15, kind: 'deferred' },
      ],
      totalTokens: 10,
      autoCompactThreshold: null,
      maxTokens: 200,
      percentage: 5,
      updatedAtMs: expect.any(Number),
    })
    expect(getContextUsage).toHaveBeenCalledWith({ detail: 'summary' })
    await expect(manager.contextUsage('session-1')).resolves.toMatchObject({ totalTokens: 10 })
    expect(getContextUsage).toHaveBeenCalledTimes(1)
  })

  it('does not report a context usage refresh canceled by runtime closure', async () => {
    let rejectContextUsage!: (error: Error) => void
    const getContextUsage = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectContextUsage = reject
        }),
    )
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { getContextUsage } as Partial<Query>))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.ensureRuntime({ projectId, sessionId: 'session-1' })
    expect(getContextUsage).toHaveBeenCalledTimes(1)
    await manager.closeForExternalOwner('session-1')
    rejectContextUsage(new Error('Query closed before response received'))
    await Promise.resolve()
    await Promise.resolve()

    expect(consoleError).not.toHaveBeenCalledWith('live-runtime:context usage refresh failed', expect.anything())
    consoleError.mockRestore()
  })

  it('reports a context usage refresh failure on the current runtime', async () => {
    const failure = new Error('context usage failed')
    const getContextUsage = vi.fn().mockRejectedValue(failure)
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { getContextUsage } as Partial<Query>))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const manager = new LiveTurnManager()

    await manager.ensureRuntime({ projectId: Buffer.from('/repo/a').toString('base64url'), sessionId: 'session-1' })
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith('live-runtime:context usage refresh failed', failure))

    manager.closeAll()
    consoleError.mockRestore()
  })

  it('rejects an unavailable project directory before creating an SDK runtime', async () => {
    statMock.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    const manager = new LiveTurnManager()

    await expect(manager.ensureRuntime({ projectId: Buffer.from('/missing').toString('base64url'), sessionId: 'session-1' })).rejects.toBeInstanceOf(ProjectDirectoryUnavailableError)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('refreshes context usage after final assistant messages but not stream events or results', async () => {
    const getContextUsage = vi.fn().mockResolvedValue({ categories: [], totalTokens: 10, maxTokens: 200, percentage: 5 })
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => assistantResultQuery(prompt, { getContextUsage } as Partial<Query>))
    const manager = new LiveTurnManager()

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      resume: false,
      text: 'hello',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
    })

    await vi.waitFor(() => expect(getContextUsage).toHaveBeenCalledTimes(2))
    expect(getContextUsage).toHaveBeenCalledWith({ detail: 'summary' })
  })

  it('persists final context usage before publishing a terminal result', async () => {
    let resolveAssistantUsage!: (usage: { categories: never[]; totalTokens: number; maxTokens: number; percentage: number }) => void
    let resolveTerminalUsage!: (usage: { categories: never[]; totalTokens: number; maxTokens: number; percentage: number }) => void
    const getContextUsage = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveAssistantUsage = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveTerminalUsage = resolve
          }),
      )
    let liveQuery: Query
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
      liveQuery = assistantResultQuery(prompt, { getContextUsage } as Partial<Query>)
      return liveQuery
    })
    let persistedUsage: { totalTokens: number } | null = null
    const contextUsageStore = {
      getContextUsage: () => persistedUsage,
      setContextUsage: (_sessionId: string, usage: { totalTokens: number }) => {
        persistedUsage = usage
      },
    }
    const manager = new LiveTurnManager(undefined, undefined, contextUsageStore as never)
    const events: LiveTurnEvent[] = []
    manager.subscribe('session-1', (event) => {
      events.push(event)
      if (event.type === 'result') expect(persistedUsage).toMatchObject({ totalTokens: 20 })
    })

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      resume: false,
      text: 'hello',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
    })

    await vi.waitFor(() => expect(getContextUsage).toHaveBeenCalledTimes(1))
    expect(events.some((event) => event.type === 'result')).toBe(false)
    resolveAssistantUsage({ categories: [], totalTokens: 10, maxTokens: 200, percentage: 5 })
    await vi.waitFor(() => expect(getContextUsage).toHaveBeenCalledTimes(2))
    expect(events.some((event) => event.type === 'result')).toBe(false)
    expect(liveQuery!.close).not.toHaveBeenCalled()
    resolveTerminalUsage({ categories: [], totalTokens: 20, maxTokens: 200, percentage: 10 })

    await vi.waitFor(() => expect(events.some((event) => event.type === 'result')).toBe(true))
    expect(persistedUsage).toMatchObject({ totalTokens: 20 })
  })

  it('sends images before text as SDK content blocks', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => streamingQuery(prompt))
    const manager = new LiveTurnManager()
    const events: LiveTurnEvent[] = []
    manager.subscribe('session-1', (event) => events.push(event))

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      resume: false,
      text: 'describe this',
      images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }],
      userMessageUuid: 'user-1',
      permissionMode: 'default',
    })

    await vi.waitFor(() => expect(events[0]).toMatchObject({ type: 'user' }))
    expect((events[0] as SDKUserMessage).message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      { type: 'text', text: 'describe this' },
    ])
  })

  it('creates a new SDK session with the client-provided session id', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => resultOnlyQuery(prompt))
    const recordLiveResult = vi.fn()
    const manager = new LiveTurnManager(undefined, { recordLiveResult })
    const events: LiveTurnEvent[] = []
    manager.subscribe('session-1', (event) => events.push(event))

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      resume: false,
      text: 'hello',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
    })

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ sessionId: 'session-1' }),
      }),
    )
    expect(queryMock.mock.calls[0]?.[0].options).not.toHaveProperty('resume')
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(recordLiveResult).toHaveBeenCalledWith(Buffer.from('/repo/a').toString('base64url'), 'session-1', 'user-1', expect.objectContaining({ type: 'result', subtype: 'success' }))
    expect(events).toEqual([expect.objectContaining({ type: 'result', subtype: 'success' })])
  })

  it('replaces runtime background task snapshots before and after result', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => backgroundLifecycleQuery(prompt))
    const manager = new LiveTurnManager(undefined, { recordLiveResult: vi.fn() })
    const events: LiveTurnEvent[] = []
    manager.subscribe('session-1', (event) => events.push(event))

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      resume: true,
      text: 'hello',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
    })

    await vi.waitFor(() =>
      expect(manager.liveBackgroundTasks('session-1')).toEqual([
        { taskId: 'task-a', taskType: 'local_agent' },
        { taskId: 'task-b', taskType: 'local_agent' },
      ]),
    )
    expect(manager.sessionRunState('session-1')).toMatchObject({ phase: 'idle', activeUserMessageUuid: null })
    expect(events.filter((event: any) => event.subtype === 'background_tasks_changed')).toHaveLength(2)
  })

  it('publishes session messages before and after an active turn', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => sessionLifecycleQuery(prompt))
    const recordLiveResult = vi.fn()
    const manager = new LiveTurnManager(undefined, { recordLiveResult })
    const events: LiveTurnEvent[] = []
    manager.subscribe('session-1', (event) => events.push(event))

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      resume: true,
      text: 'hello',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
    })

    await vi.waitFor(() => expect(events).toHaveLength(3))
    expect(events).toEqual([
      expect.objectContaining({ type: 'system', subtype: 'init' }),
      expect.objectContaining({ type: 'result', subtype: 'success' }),
      expect.objectContaining({ type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed' }),
    ])
    expect(recordLiveResult).toHaveBeenCalledTimes(1)
    expect(recordLiveResult).toHaveBeenCalledWith(Buffer.from('/repo/a').toString('base64url'), 'session-1', 'user-1', expect.objectContaining({ type: 'result', subtype: 'success' }))
    expect(manager.sessionRunState('session-1')).toEqual({ phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'user-1', outcome: 'success' } })
  })

  it('publishes a result without attributing it to a turn', async () => {
    queryMock.mockImplementation(() => detachedResultQuery())
    const recordLiveResult = vi.fn()
    const manager = new LiveTurnManager(undefined, { recordLiveResult })
    const events: LiveTurnEvent[] = []
    manager.subscribe('session-1', (event) => events.push(event))

    await manager.ensureRuntime({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      permissionMode: 'default',
    })

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({ type: 'result', subtype: 'success' })
    expect(recordLiveResult).not.toHaveBeenCalled()
    expect(manager.sessionRunState('session-1')).toBeNull()
  })

  it('publishes a failure terminal event when the SDK stream rejects', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => failingQuery(prompt))
    const signalSessionActivity = vi.fn()
    const manager = new LiveTurnManager({ signalSessionActivity })
    const events: LiveTurnEvent[] = []
    manager.subscribe('session-1', (event) => events.push(event))

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      resume: true,
      text: 'hello',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
      model: 'claude-opus-5',
      effort: 'high',
    })

    await vi.waitFor(() => expect(events).toHaveLength(2))

    expect(events[0]).toMatchObject({ type: 'user', uuid: 'user-1' })
    expect(events[1]).toEqual({ type: 'cotta_live_turn_failed', error: 'SDK stream failed', session_id: 'session-1' })
    expect(manager.sessionRunState('session-1')).toEqual({ phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'user-1', outcome: 'error' } })
    expect(signalSessionActivity).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'session-1' }))
  })

  it('fails an active turn when the SDK stream ends without a result', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => endingQuery(prompt))
    const manager = new LiveTurnManager()
    const events: LiveTurnEvent[] = []
    manager.subscribe('session-1', (event) => events.push(event))

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      resume: true,
      text: 'hello',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
    })

    await vi.waitFor(() => expect(manager.sessionRunState('session-1')?.phase).toBe('idle'))
    expect(events).toEqual([{ type: 'cotta_live_turn_failed', error: 'SDK stream ended before the turn completed.', session_id: 'session-1' }])
    expect(manager.sessionRunState('session-1')).toEqual({ phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'user-1', outcome: 'error' } })
  })

  it('keeps a turn successful when the activity observer throws synchronously', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => streamingQuery(prompt))
    const manager = new LiveTurnManager({
      signalSessionActivity: () => {
        throw new Error('listener unavailable')
      },
    })
    const events: LiveTurnEvent[] = []
    manager.subscribe('session-1', (event) => events.push(event))

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      resume: true,
      text: 'hello',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
    })

    await vi.waitFor(() => expect(manager.sessionRunState('session-1')?.phase).toBe('idle'))
    expect(events.some((event) => event.type === 'cotta_live_turn_failed')).toBe(false)
    expect(manager.sessionRunState('session-1')).toEqual({ phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'user-1', outcome: 'success' } })
  })

  it('publishes non-idle run-state versions immediately', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => requiresActionQuery(prompt))
    const signalSessionActivity = vi.fn()
    const notifySessionRunStateActive = vi.fn()
    const manager = new LiveTurnManager({ signalSessionActivity, notifySessionRunStateActive })
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({
      projectId,
      sessionId: 'session-1',
      resume: true,
      text: 'hello',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
    })

    expect(manager.sessionRunState('session-1')).toEqual({ phase: 'running', activeUserMessageUuid: 'user-1', lastTurn: null })
    await vi.waitFor(() => expect(notifySessionRunStateActive).toHaveBeenCalledTimes(4))
    expect(notifySessionRunStateActive.mock.calls).toEqual([
      [{ sessionId: 'session-1', projectId, version: 1 }],
      [{ sessionId: 'session-1', projectId, version: 2 }],
      [{ sessionId: 'session-1', projectId, version: 3 }],
      [{ sessionId: 'session-1', projectId, version: 4 }],
    ])
    expect(signalSessionActivity.mock.calls).toEqual([[{ sessionId: 'session-1', projectId }], [{ sessionId: 'session-1', projectId }], [{ sessionId: 'session-1', projectId }]])
  })

  it('exposes and answers pending tool approvals', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const notifySessionRunStateActive = vi.fn()
    const manager = new LiveTurnManager({ notifySessionRunStateActive })
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'hello', userMessageUuid: 'user-1', permissionMode: 'default' })
    const canUseTool = queryMock.mock.calls[0]?.[0].options.canUseTool
    const approval = canUseTool(
      'Bash',
      { command: 'npm test' },
      {
        requestId: 'req-1',
        toolUseID: 'tool-1',
        signal: new AbortController().signal,
        title: 'Do you want to proceed?',
        displayName: 'Run command',
        description: 'npm test',
        suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] }],
      },
    )

    expect(manager.sessionRunState('session-1')).toEqual({
      phase: 'requires_action',
      activeUserMessageUuid: 'user-1',
      lastTurn: null,
      pendingPermission: {
        requestId: 'req-1',
        toolUseID: 'tool-1',
        toolName: 'Bash',
        input: { command: 'npm test' },
        title: 'Do you want to proceed?',
        displayName: 'Run command',
        description: 'npm test',
        suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] }],
      },
    })
    expect(manager.respondToPermission('session-1', 'req-1', { decision: 'allow' })).toEqual({ status: 'answered' })
    await expect(approval).resolves.toEqual({ behavior: 'allow', toolUseID: 'tool-1' })
    expect(manager.sessionRunState('session-1')).toEqual({ phase: 'running', activeUserMessageUuid: 'user-1', lastTurn: null })
    expect(manager.respondToPermission('session-1', 'req-1', { decision: 'deny' })).toBeNull()
  })

  it('keeps a pending approval valid after an interrupt acknowledgement', async () => {
    const interrupt = vi.fn().mockResolvedValue(undefined)
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { interrupt }))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'hello', userMessageUuid: 'user-1', permissionMode: 'default' })
    const canUseTool = queryMock.mock.calls[0]?.[0].options.canUseTool
    const approval = canUseTool('Bash', { command: 'npm test' }, { requestId: 'req-1', toolUseID: 'tool-1', signal: new AbortController().signal })

    await expect(manager.interrupt('session-1')).resolves.toBe(true)
    expect(interrupt).toHaveBeenCalledTimes(1)
    expect(manager.sessionRunState('session-1')).toMatchObject({ phase: 'requires_action', pendingPermission: { requestId: 'req-1' } })
    expect(manager.respondToPermission('session-1', 'req-1', { decision: 'allow' })).toEqual({ status: 'answered' })
    await expect(approval).resolves.toEqual({ behavior: 'allow', toolUseID: 'tool-1' })
  })

  it('publishes a run-state-changed event when entering and leaving requires_action', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const events: LiveTurnEvent[] = []
    manager.subscribe('session-1', (event) => events.push(event))
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'hello', userMessageUuid: 'user-1', permissionMode: 'default' })
    const canUseTool = queryMock.mock.calls[0]?.[0].options.canUseTool
    const approval = canUseTool('Bash', { command: 'npm test' }, { requestId: 'req-1', toolUseID: 'tool-1', signal: new AbortController().signal })
    const runStateEvents = () => events.filter((event) => event.type === 'cotta_run_state_changed')
    await vi.waitFor(() => expect(runStateEvents()).toContainEqual({ type: 'cotta_run_state_changed', session_id: 'session-1' }))
    const enteredCount = runStateEvents().length

    expect(manager.respondToPermission('session-1', 'req-1', { decision: 'allow' })).toEqual({ status: 'answered' })
    await expect(approval).resolves.toEqual({ behavior: 'allow', toolUseID: 'tool-1' })
    expect(runStateEvents().length).toBeGreaterThan(enteredCount)
  })

  it('publishes a run-state-changed event when swapping to the next pending approval', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const events: LiveTurnEvent[] = []
    manager.subscribe('session-1', (event) => events.push(event))
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'hello', userMessageUuid: 'user-1', permissionMode: 'default' })
    const canUseTool = queryMock.mock.calls[0]?.[0].options.canUseTool
    canUseTool('Bash', { command: 'npm test' }, { requestId: 'req-1', toolUseID: 'tool-1', signal: new AbortController().signal })
    canUseTool('Read', { file_path: '/repo/a/x' }, { requestId: 'req-2', toolUseID: 'tool-2', signal: new AbortController().signal })
    const runStateEvents = () => events.filter((event) => event.type === 'cotta_run_state_changed')
    await vi.waitFor(() => expect(manager.sessionRunState('session-1')).toMatchObject({ phase: 'requires_action', pendingPermission: { requestId: 'req-1' } }))
    const beforeSwap = runStateEvents().length

    expect(manager.respondToPermission('session-1', 'req-1', { decision: 'allow' })).toEqual({ status: 'answered' })
    expect(manager.sessionRunState('session-1')).toMatchObject({ phase: 'requires_action', pendingPermission: { requestId: 'req-2' } })
    expect(runStateEvents().length).toBeGreaterThan(beforeSwap)
  })

  it('keeps requires_action when SDK reports running with a pending approval', async () => {
    let emitRunning!: () => void
    const running = new Promise<void>((resolve) => {
      emitRunning = resolve
    })
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
      queryFromGenerator(
        (async function* () {
          for await (const message of prompt) {
            yield message
            await running
            yield { type: 'system', subtype: 'session_state_changed', state: 'running' } as SDKMessage
          }
        })(),
      ),
    )
    const manager = new LiveTurnManager()
    const events: LiveTurnEvent[] = []
    manager.subscribe('session-1', (event) => events.push(event))
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'hello', userMessageUuid: 'user-1', permissionMode: 'default' })
    const canUseTool = queryMock.mock.calls[0]?.[0].options.canUseTool
    const approval = canUseTool('Bash', { command: 'npm test' }, { requestId: 'req-1', toolUseID: 'tool-1', signal: new AbortController().signal })
    emitRunning()

    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'system', subtype: 'session_state_changed', state: 'running' })))
    expect(manager.sessionRunState('session-1')).toMatchObject({ phase: 'requires_action', pendingPermission: { requestId: 'req-1' } })
    expect(manager.respondToPermission('session-1', 'req-1', { decision: 'deny' })).toEqual({ status: 'answered' })
    await expect(approval).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('answers AskUserQuestion with server-owned updated input', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'hello', userMessageUuid: 'user-1', permissionMode: 'default' })
    const canUseTool = queryMock.mock.calls[0]?.[0].options.canUseTool
    const questions = [
      {
        question: 'Ship?',
        header: 'Ship',
        options: [
          { label: 'Yes', description: 'Ship it', preview: 'release' },
          { label: 'No', description: 'Wait' },
        ],
        multiSelect: false,
      },
    ]
    const approval = canUseTool(
      'AskUserQuestion',
      { questions, metadata: { source: 'test' } },
      {
        requestId: 'req-1',
        toolUseID: 'tool-1',
        signal: new AbortController().signal,
      },
    )
    const annotations = { 'Ship?': { preview: 'release', notes: 'today' } }

    expect(manager.respondToQuestion('session-1', 'req-1', { behavior: 'completed', toolUseID: 'tool-1', answers: { 'Ship?': 'Yes' }, annotations })).toEqual({ status: 'answered' })
    await expect(approval).resolves.toEqual({
      behavior: 'allow',
      toolUseID: 'tool-1',
      updatedInput: { questions, metadata: { source: 'test' }, answers: { 'Ship?': 'Yes' }, annotations },
    })
    expect(manager.respondToQuestion('session-1', 'req-1', { behavior: 'cancelled', toolUseID: 'tool-1' })).toBeNull()
  })

  it('only answers AskUserQuestion through the question response path', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'hello', userMessageUuid: 'user-1', permissionMode: 'default' })
    const canUseTool = queryMock.mock.calls[0]?.[0].options.canUseTool
    const approval = canUseTool('AskUserQuestion', { questions: [] }, { requestId: 'req-1', toolUseID: 'tool-1', signal: new AbortController().signal })

    expect(manager.respondToPermission('session-1', 'req-1', { decision: 'deny' })).toBeNull()
    expect(manager.sessionRunState('session-1')?.phase).toBe('requires_action')
    expect(manager.respondToQuestion('session-1', 'req-1', { behavior: 'cancelled', toolUseID: 'tool-1' })).toEqual({ status: 'answered' })
    await expect(approval).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('rejects mismatched and invalid AskUserQuestion answers without consuming the request', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')
    const questions = [
      {
        question: 'Ship?',
        header: 'Ship',
        options: [
          { label: 'Yes', description: 'Ship', preview: 'release' },
          { label: 'No', description: 'Wait' },
        ],
        multiSelect: false,
      },
      {
        question: 'Features?',
        header: 'Features',
        options: [
          { label: 'API', description: 'API' },
          { label: 'Web', description: 'Web' },
        ],
        multiSelect: true,
      },
    ]

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'hello', userMessageUuid: 'user-1', permissionMode: 'default' })
    const canUseTool = queryMock.mock.calls[0]?.[0].options.canUseTool
    const approval = canUseTool('AskUserQuestion', { questions }, { requestId: 'req-1', toolUseID: 'tool-1', signal: new AbortController().signal })

    expect(manager.respondToQuestion('session-1', 'req-1', { behavior: 'completed', toolUseID: 'wrong', answers: { 'Ship?': 'Yes', 'Features?': 'API' } })).toBeNull()
    expect(manager.respondToQuestion('session-1', 'req-1', { behavior: 'completed', toolUseID: 'tool-1', answers: { 'Ship?': '', 'Features?': 'API' } })).toBeNull()
    expect(
      manager.respondToQuestion('session-1', 'req-1', { behavior: 'completed', toolUseID: 'tool-1', answers: { 'Ship?': 'Yes', 'Features?': 'API' }, annotations: { Unknown: { notes: 'custom' } } }),
    ).toBeNull()
    expect(
      manager.respondToQuestion('session-1', 'req-1', { behavior: 'completed', toolUseID: 'tool-1', answers: { 'Ship?': 'Yes', 'Features?': 'API' }, annotations: { 'Ship?': { preview: 'wrong' } } }),
    ).toBeNull()
    // Partial answers are accepted (the Lark card may submit a subset); unknown keys and empty answers are still rejected.
    expect(manager.respondToQuestion('session-1', 'req-1', { behavior: 'completed', toolUseID: 'tool-1', answers: { Unknown: 'x' } })).toBeNull()
    const answers = { 'Ship?': 'Yes', 'Features?': 'API, observability, logs' }
    const annotations = { 'Ship?': { preview: 'release', notes: 'today' }, 'Features?': { notes: 'includes commas' } }
    expect(manager.respondToQuestion('session-1', 'req-1', { behavior: 'completed', toolUseID: 'tool-1', answers, annotations })).toEqual({ status: 'answered' })
    await expect(approval).resolves.toEqual({ behavior: 'allow', toolUseID: 'tool-1', updatedInput: { questions, answers, annotations } })
  })

  it('denies a cancelled AskUserQuestion', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'hello', userMessageUuid: 'user-1', permissionMode: 'default' })
    const canUseTool = queryMock.mock.calls[0]?.[0].options.canUseTool
    const approval = canUseTool('AskUserQuestion', { questions: [] }, { requestId: 'req-1', toolUseID: 'tool-1', signal: new AbortController().signal })

    expect(manager.respondToQuestion('session-1', 'req-1', { behavior: 'cancelled', toolUseID: 'tool-1' })).toEqual({ status: 'answered' })
    await expect(approval).resolves.toEqual({ behavior: 'deny', message: 'User declined to answer questions.', toolUseID: 'tool-1' })
  })

  it('keeps an answered approval successful when its run-state observer throws', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager({
      notifySessionRunStateActive: () => {
        throw new Error('listener unavailable')
      },
    })
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'hello', userMessageUuid: 'user-1', permissionMode: 'default' })
    const canUseTool = queryMock.mock.calls[0]?.[0].options.canUseTool
    const approval = canUseTool('Bash', { command: 'npm test' }, { requestId: 'req-1', toolUseID: 'tool-1', signal: new AbortController().signal })

    expect(manager.respondToPermission('session-1', 'req-1', { decision: 'allow' })).toEqual({ status: 'answered' })
    await expect(approval).resolves.toEqual({ behavior: 'allow', toolUseID: 'tool-1' })
    expect(manager.sessionRunState('session-1')).toEqual({ phase: 'running', activeUserMessageUuid: 'user-1', lastTurn: null })
  })

  it('waits for SDK status before updating runtime permission mode', async () => {
    const setPermissionMode = vi.fn()
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { setPermissionMode }))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'hello', userMessageUuid: 'user-1', permissionMode: 'default' })
    const canUseTool = queryMock.mock.calls[0]?.[0].options.canUseTool
    const suggestion = { type: 'setMode', mode: 'acceptEdits', destination: 'userSettings' }
    const approval = canUseTool('Bash', { command: 'npm test' }, { requestId: 'req-1', toolUseID: 'tool-1', signal: new AbortController().signal, suggestions: [suggestion] })

    expect(manager.respondToPermission('session-1', 'req-1', { decision: 'allow_suggestion' })).toEqual({ status: 'answered' })
    await expect(approval).resolves.toEqual({ behavior: 'allow', toolUseID: 'tool-1', updatedPermissions: [suggestion] })
    await manager.syncExistingRuntimeOptions({ projectId, sessionId: 'session-1', permissionMode: 'acceptEdits' })

    expect(setPermissionMode).toHaveBeenCalledWith('acceptEdits')
  })

  it('rejects permission updates that were not suggested', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'hello', userMessageUuid: 'user-1', permissionMode: 'default' })
    const canUseTool = queryMock.mock.calls[0]?.[0].options.canUseTool
    const approval = canUseTool('Bash', { command: 'npm test' }, { requestId: 'req-1', toolUseID: 'tool-1', signal: new AbortController().signal, suggestions: [] })

    expect(manager.respondToPermission('session-1', 'req-1', { decision: 'allow_suggestion' })).toEqual({ status: 'invalid_update' })
    expect(manager.sessionRunState('session-1')?.phase).toBe('requires_action')
    expect(manager.respondToPermission('session-1', 'req-1', { decision: 'deny' })).toEqual({ status: 'answered' })
    await expect(approval).resolves.toEqual({ behavior: 'deny', message: 'Denied by user.', toolUseID: 'tool-1' })
  })

  it('clears requires_action when a pending tool approval is aborted', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'hello', userMessageUuid: 'user-1', permissionMode: 'default' })
    const canUseTool = queryMock.mock.calls[0]?.[0].options.canUseTool
    const controller = new AbortController()
    const approval = canUseTool('Bash', { command: 'npm test' }, { requestId: 'req-1', toolUseID: 'tool-1', signal: controller.signal })

    expect(manager.sessionRunState('session-1')?.phase).toBe('requires_action')
    controller.abort()

    await expect(approval).resolves.toEqual({ behavior: 'deny', message: 'Permission request was cancelled.', toolUseID: 'tool-1' })
    expect(manager.sessionRunState('session-1')).toEqual({ phase: 'running', activeUserMessageUuid: 'user-1', lastTurn: null })
  })

  it('passes model and effort to new SDK runtimes', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => streamingQuery(prompt))
    const manager = new LiveTurnManager()

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      resume: true,
      text: 'first',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
      model: 'claude-sonnet-5',
      effort: 'xhigh',
    })

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ model: 'claude-sonnet-5', effort: 'xhigh' }),
      }),
    )
  })

  it('passes the explicit default model and omits effort', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => streamingQuery(prompt))
    const manager = new LiveTurnManager()

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      resume: true,
      text: 'first',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
      model: 'default',
    })

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ model: 'default' }),
      }),
    )
    expect(queryMock.mock.calls[0]?.[0].options).not.toHaveProperty('effort')
  })

  it('updates session options when reusing a session runtime', async () => {
    const setPermissionMode = vi.fn()
    const setModel = vi.fn()
    const applyFlagSettings = vi.fn()
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => streamingQuery(prompt, { setPermissionMode, setModel, applyFlagSettings }))
    const manager = new LiveTurnManager()

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      resume: true,
      text: 'first',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
      model: 'claude-opus-5',
      effort: 'high',
    })
    await vi.waitFor(() => expect(manager.sessionRunState('session-1')).toEqual({ phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'user-1', outcome: 'success' } }))
    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      resume: true,
      text: 'second',
      userMessageUuid: 'user-2',
      permissionMode: 'plan',
      model: 'claude-sonnet-5',
      effort: 'xhigh',
    })

    expect(setPermissionMode).toHaveBeenCalledWith('plan')
    expect(setModel).not.toHaveBeenCalled()
    expect(applyFlagSettings).toHaveBeenCalledWith({ model: 'claude-sonnet-5', effortLevel: 'xhigh' })
    await vi.waitFor(() => expect(manager.sessionRunState('session-1')).toEqual({ phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'user-2', outcome: 'success' } }))
    await manager.closeForExternalOwner('session-1')
    await manager.rebuildRuntimeAfterCliIdle({
      hasCliOwnership: () => false,
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      permissionMode: 'plan',
      model: 'claude-sonnet-5',
      effort: 'xhigh',
    })
    expect(queryMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ permissionMode: 'plan', model: 'claude-sonnet-5', effort: 'xhigh' }),
      }),
    )
    manager.closeAll()
  })

  it('correlates slash command roots without rewriting SDK correlation', async () => {
    const command = (uuid: string, extra: Record<string, unknown> = {}, source = '/status') =>
      ({ type: 'assistant', uuid, parent_tool_use_id: null, local_command_source: source, message: { role: 'assistant', content: [] }, ...extra }) as unknown as SDKMessage
    queryMock.mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
      slashCommandQuery(prompt, [
        command('unparseable', {}, 'not a command'),
        command('command-wrong', { user_message_uuid: 'other' }),
        command('command-1', { user_message_uuids: ['user-1'] }),
        command('command-1', { user_message_uuids: ['user-1'] }),
        command('command-conflict', { user_message_uuids: ['other'] }),
        command('command-late'),
      ]),
    )
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const manager = new LiveTurnManager()
    const events: LiveTurnEvent[] = []
    manager.subscribe('session-1', (event) => events.push(event))
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: '/status', userMessageUuid: 'user-1', permissionMode: 'default' })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'result')).toBe(true))

    const eventByUuid = (uuid: string) => events.find((event) => (event as unknown as Record<string, unknown>).uuid === uuid)
    expect(eventByUuid('unparseable')).not.toHaveProperty('user_message_uuid')
    expect(eventByUuid('command-wrong')).toHaveProperty('user_message_uuid', 'other')
    expect(eventByUuid('command-1')).toHaveProperty('user_message_uuids', ['user-1'])
    expect(eventByUuid('command-conflict')).toHaveProperty('user_message_uuids', ['other'])
    expect(eventByUuid('command-late')).toHaveProperty('user_message_uuid', 'user-1')
    expect(manager.runtimeTurnProjection('session-1')).toEqual({ submissionUuid: 'user-1', kind: 'visible', visibleTurnUuid: 'command-1' })
    expect(consoleWarn).toHaveBeenCalledOnce()
    expect(consoleWarn).toHaveBeenCalledWith('live-runtime:conflicting turn projection', {
      sessionId: 'session-1',
      submissionUuid: 'user-1',
      existingVisibleTurnUuid: 'command-1',
      visibleTurnUuid: 'command-late',
    })
    expect(manager.acknowledgeCompletedTurn({ projectId, sessionId: 'session-1', turnId: 'user-1' })).toBe(true)
    expect(manager.runtimeTurnProjection('session-1', 'user-1')).toEqual({ submissionUuid: 'user-1', kind: 'visible', visibleTurnUuid: 'command-1' })
    expect(manager.close('session-1')).toBe(true)
    expect(manager.runtimeTurnProjection('session-1', 'user-1')).toEqual({ submissionUuid: 'user-1', kind: 'visible', visibleTurnUuid: 'command-1' })
    manager.clearRuntimeTurnProjection('session-1')
    expect(manager.runtimeTurnProjection('session-1')).toBeNull()
  })

  it('retains slash projections across turns and resolves them by submission uuid', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
      queryFromGenerator(
        (async function* () {
          for await (const message of prompt) {
            const submissionUuid = message.uuid!
            yield {
              type: 'assistant',
              uuid: `command-${submissionUuid}`,
              parent_tool_use_id: null,
              parent_agent_id: null,
              local_command_source: '/status',
              user_message_uuid: submissionUuid,
              message: { role: 'assistant', content: [] },
            } as unknown as SDKMessage
            yield { type: 'result', subtype: 'success' } as SDKMessage
          }
        })(),
      ),
    )
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: '/status', userMessageUuid: 'user-1', permissionMode: 'default' })
    await vi.waitFor(() => expect(manager.sessionRunState('session-1')?.phase).toBe('idle'))
    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: '/status', userMessageUuid: 'user-2', permissionMode: 'default' })
    await vi.waitFor(() => expect(manager.sessionRunState('session-1')?.lastTurn?.id).toBe('user-2'))

    expect(manager.runtimeTurnProjection('session-1', 'user-1')).toEqual({ submissionUuid: 'user-1', kind: 'visible', visibleTurnUuid: 'command-user-1' })
    expect(manager.runtimeTurnProjection('session-1', 'user-2')).toEqual({ submissionUuid: 'user-2', kind: 'visible', visibleTurnUuid: 'command-user-2' })
    expect(manager.runtimeTurnProjection('session-1')).toEqual({ submissionUuid: 'user-2', kind: 'visible', visibleTurnUuid: 'command-user-2' })
    expect(manager.runtimeTurnProjection('session-1', 'missing')).toBeNull()
  })

  it('ignores subagent and sidechain slash roots for projection and correlation', async () => {
    const command = (uuid: string, extra: Record<string, unknown>) =>
      ({ type: 'assistant', uuid, local_command_source: '/status', message: { role: 'assistant', content: [] }, ...extra }) as unknown as SDKMessage
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
      slashCommandQuery(prompt, [
        { type: 'user', uuid: 'user-1', parent_tool_use_id: 'tool-1', parent_agent_id: null } as unknown as SDKMessage,
        { type: 'user', uuid: 'user-1', parent_tool_use_id: null, parent_agent_id: 'agent-1' } as unknown as SDKMessage,
        { type: 'user', uuid: 'user-1', parent_tool_use_id: null, parent_agent_id: null, isSidechain: true } as unknown as SDKMessage,
        command('subagent-tool', { parent_tool_use_id: 'tool-1', parent_agent_id: null }),
        command('subagent-agent', { parent_tool_use_id: null, parent_agent_id: 'agent-1' }),
        command('sidechain', { parent_tool_use_id: null, parent_agent_id: null, isSidechain: true }),
      ]),
    )
    const manager = new LiveTurnManager()
    const events: LiveTurnEvent[] = []
    manager.subscribe('session-1', (event) => events.push(event))

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      resume: true,
      text: '/status',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
    })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'result')).toBe(true))

    for (const uuid of ['subagent-tool', 'subagent-agent', 'sidechain']) expect(events.find((event) => (event as unknown as { uuid?: string }).uuid === uuid)).not.toHaveProperty('user_message_uuid')
    expect(manager.runtimeTurnProjection('session-1', 'user-1')).toEqual({ submissionUuid: 'user-1', kind: 'terminal-only' })
  })

  it('projects primary slash echoes and terminal-only submissions', async () => {
    queryMock
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
        slashCommandQuery(prompt, [{ type: 'user', uuid: 'user-2', parent_tool_use_id: null, parent_agent_id: null } as unknown as SDKMessage]),
      )
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => resultOnlyQuery(prompt))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-2', resume: true, text: '/unknown', userMessageUuid: 'user-2', permissionMode: 'default' })
    await vi.waitFor(() => expect(manager.runtimeTurnProjection('session-2')).toEqual({ submissionUuid: 'user-2', kind: 'visible', visibleTurnUuid: 'user-2' }))

    await manager.startTurn({ projectId, sessionId: 'session-3', resume: true, text: '/clear', userMessageUuid: 'user-3', permissionMode: 'default' })
    await vi.waitFor(() => expect(manager.runtimeTurnProjection('session-3')).toEqual({ submissionUuid: 'user-3', kind: 'terminal-only' }))
  })

  it('acknowledges only the matching completed turn', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => streamingQuery(prompt))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'hello', userMessageUuid: 'user-1', permissionMode: 'default' })
    await vi.waitFor(() => expect(manager.sessionRunState('session-1')).toEqual({ phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'user-1', outcome: 'success' } }))

    expect(manager.acknowledgeCompletedTurn({ projectId, sessionId: 'session-1', turnId: 'stale' })).toBe(false)
    expect(manager.acknowledgeCompletedTurn({ projectId, sessionId: 'session-1', turnId: 'user-1' })).toBe(true)
    expect(manager.sessionRunState('session-1')).toEqual({ phase: 'idle', activeUserMessageUuid: null })
    expect(manager.acknowledgeCompletedTurn({ projectId, sessionId: 'session-1', turnId: 'user-1' })).toBe(false)
  })

  it('clears effort when a reused runtime switches to no effort', async () => {
    const applyFlagSettings = vi.fn()
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => streamingQuery(prompt, { applyFlagSettings }))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'first', userMessageUuid: 'user-1', permissionMode: 'default', model: 'claude-opus-5', effort: 'high' })
    await vi.waitFor(() => expect(manager.sessionRunState('session-1')?.phase).toBe('idle'))
    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'second', userMessageUuid: 'user-2', permissionMode: 'default', model: 'default', effort: null })

    expect(applyFlagSettings).toHaveBeenCalledWith({ model: 'default', effortLevel: null })
  })

  it('updates a reused runtime to the explicit default model', async () => {
    const setModel = vi.fn()
    const applyFlagSettings = vi.fn()
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => streamingQuery(prompt, { setModel, applyFlagSettings }))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'first', userMessageUuid: 'user-1', permissionMode: 'default', model: 'claude-opus-5' })
    await vi.waitFor(() => expect(manager.sessionRunState('session-1')?.phase).toBe('idle'))
    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'second', userMessageUuid: 'user-2', permissionMode: 'default', model: 'default' })

    expect(setModel).not.toHaveBeenCalled()
    expect(applyFlagSettings).toHaveBeenCalledWith({ model: 'default' })
  })

  it('ignores buffered status from a replaced runtime', async () => {
    let releaseOld!: () => void
    let oldDrainFinished = false
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve
    })
    queryMock
      .mockImplementationOnce(() =>
        queryFromGenerator(
          (async function* () {
            try {
              await oldGate
              yield { type: 'system', subtype: 'status', status: null, permissionMode: 'plan' } as SDKMessage
            } finally {
              oldDrainFinished = true
            }
          })(),
        ),
      )
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const onPermissionModeChanged = vi.fn()
    const manager = new LiveTurnManager({ onPermissionModeChanged })
    const projectA = Buffer.from('/repo/a').toString('base64url')
    const projectB = Buffer.from('/repo/b').toString('base64url')

    await manager.ensureRuntime({ projectId: projectA, sessionId: 'session-1', permissionMode: 'default' })
    await manager.ensureRuntime({ projectId: projectB, sessionId: 'session-1', permissionMode: 'default' })
    releaseOld()
    await vi.waitFor(() => expect(oldDrainFinished).toBe(true))

    expect(onPermissionModeChanged).not.toHaveBeenCalled()
    manager.closeAll()
  })

  it('replaces an idle runtime when its session moves projects', async () => {
    const close = vi.fn()
    queryMock
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { close }))
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const projectA = Buffer.from('/repo/a').toString('base64url')
    const projectB = Buffer.from('/repo/b').toString('base64url')

    await manager.ensureRuntime({ projectId: projectA, sessionId: 'session-1' })
    await expect(manager.ensureRuntime({ projectId: projectB, sessionId: 'session-1' })).resolves.toEqual({})

    expect(close).toHaveBeenCalledTimes(1)
    expect(queryMock).toHaveBeenLastCalledWith(expect.objectContaining({ options: expect.objectContaining({ cwd: '/repo/b', resume: 'session-1' }) }))
    await expect(manager.ensureRuntime({ projectId: projectB, sessionId: 'session-1' })).resolves.toEqual({})
    expect(queryMock).toHaveBeenCalledTimes(2)
    manager.closeAll()
  })

  it('does not replace an active runtime when another project claims its session', async () => {
    const close = vi.fn()
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { close }))
    const manager = new LiveTurnManager()
    const projectA = Buffer.from('/repo/a').toString('base64url')
    const projectB = Buffer.from('/repo/b').toString('base64url')
    await manager.startTurn({ projectId: projectA, sessionId: 'session-1', resume: true, text: 'active', userMessageUuid: 'user-1', permissionMode: 'default' })

    await expect(manager.ensureRuntime({ projectId: projectB, sessionId: 'session-1' })).rejects.toThrow('Session runtime project mismatch')
    expect(close).not.toHaveBeenCalled()
    expect(queryMock).toHaveBeenCalledTimes(1)
    manager.closeAll()
  })

  it('rebuilds an idle runtime after its session moves projects', async () => {
    const close = vi.fn()
    queryMock
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { close }))
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const projectA = Buffer.from('/repo/a').toString('base64url')
    const projectB = Buffer.from('/repo/b').toString('base64url')
    await manager.ensureRuntime({ projectId: projectA, sessionId: 'session-1' })
    await manager.closeForExternalOwner('session-1')

    await expect(
      manager.rebuildRuntimeAfterCliIdle({ hasCliOwnership: () => false, projectId: projectB, sessionId: 'session-1', permissionMode: 'plan', model: 'default', effort: null }),
    ).resolves.toBe(true)

    expect(close).toHaveBeenCalledTimes(1)
    expect(queryMock).toHaveBeenLastCalledWith(expect.objectContaining({ options: expect.objectContaining({ cwd: '/repo/b', resume: 'session-1', permissionMode: 'plan' }) }))
    manager.closeAll()
  })

  it('rebuilds an opened runtime after CLI idle and preserves current options', async () => {
    const close = vi.fn()
    queryMock
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { close }))
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.ensureRuntime({ projectId, sessionId: 'session-1', permissionMode: 'plan', model: 'claude-opus-5', effort: 'high' })
    await manager.closeForExternalOwner('session-1')
    await expect(manager.rebuildRuntimeAfterCliIdle({ hasCliOwnership: () => false, projectId, sessionId: 'session-1', permissionMode: 'plan', model: 'claude-opus-5', effort: 'high' })).resolves.toBe(
      true,
    )

    expect(close).toHaveBeenCalledTimes(1)
    expect(queryMock).toHaveBeenCalledTimes(2)
    expect(queryMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ resume: 'session-1', permissionMode: 'plan', model: 'claude-opus-5', effort: 'high' }),
      }),
    )
    manager.closeAll()
  })

  it('recreates a runtime after external ownership closes it', async () => {
    const close = vi.fn()
    queryMock
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { close }))
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.ensureRuntime({ projectId, sessionId: 'session-1' })
    await manager.closeForExternalOwner('session-1')
    await expect(manager.rebuildRuntimeAfterCliIdle({ hasCliOwnership: () => false, projectId, sessionId: 'session-1', permissionMode: 'plan', model: 'claude-opus-5', effort: 'high' })).resolves.toBe(
      true,
    )

    expect(close).toHaveBeenCalledTimes(1)
    expect(queryMock).toHaveBeenCalledTimes(2)
    expect(queryMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ cwd: '/repo/a', resume: 'session-1', permissionMode: 'plan', model: 'claude-opus-5', effort: 'high' }),
      }),
    )
    manager.closeAll()
  })

  it('does not interrupt a runtime that is already tearing down for external ownership', async () => {
    let resolveInterrupt!: () => void
    const interrupt = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          resolveInterrupt = () => resolve(undefined)
        }),
    )
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { interrupt }))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')
    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'active', userMessageUuid: 'user-1', permissionMode: 'default' })

    // External-owner close marks the runtime stale and issues its own interrupt (still pending here).
    const closing = manager.closeForExternalOwner('session-1')
    await Promise.resolve()
    expect(interrupt).toHaveBeenCalledTimes(1)

    // A user interrupt landing during teardown must be a no-op, not a second SDK interrupt on a stale runtime.
    await expect(manager.interrupt('session-1')).resolves.toBe(false)
    expect(interrupt).toHaveBeenCalledTimes(1)

    resolveInterrupt()
    await expect(closing).resolves.toBe(true)
    manager.closeAll()
  })

  it('waits for external ownership to close before rebuilding', async () => {
    let resolveInterrupt!: () => void
    const interrupt = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          resolveInterrupt = () => resolve(undefined)
        }),
    )
    queryMock
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { interrupt }))
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')
    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'active', userMessageUuid: 'user-1', permissionMode: 'default' })

    const closing = manager.closeForExternalOwner('session-1')
    const rebuild = manager.rebuildRuntimeAfterCliIdle({ hasCliOwnership: () => false, projectId, sessionId: 'session-1', permissionMode: 'default', model: 'default', effort: null })
    await Promise.resolve()
    expect(queryMock).toHaveBeenCalledTimes(1)

    resolveInterrupt()
    await expect(closing).resolves.toBe(true)
    await expect(rebuild).resolves.toBe(true)
    expect(queryMock).toHaveBeenCalledTimes(2)
    manager.closeAll()
  })

  it('rejects question responses while external ownership takeover is pending', async () => {
    let resolveInterrupt!: () => void
    const interrupt = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          resolveInterrupt = () => resolve(undefined)
        }),
    )
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { interrupt }))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')
    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'active', userMessageUuid: 'user-1', permissionMode: 'default' })
    const canUseTool = queryMock.mock.calls[0]?.[0].options.canUseTool
    const approval = canUseTool('AskUserQuestion', { questions: [] }, { requestId: 'req-1', toolUseID: 'tool-1', signal: new AbortController().signal })

    const closing = manager.closeForExternalOwner('session-1')
    expect(manager.respondToQuestion('session-1', 'req-1', { behavior: 'cancelled', toolUseID: 'tool-1' })).toBeNull()
    resolveInterrupt()
    await expect(closing).resolves.toBe(true)
    await expect(approval).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('does not rebuild when CLI ownership becomes active again during close', async () => {
    let resolveInterrupt!: () => void
    const interrupt = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          resolveInterrupt = () => resolve(undefined)
        }),
    )
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { interrupt }))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')
    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'active', userMessageUuid: 'user-1', permissionMode: 'default' })

    let cliOwned = false
    const closing = manager.closeForExternalOwner('session-1')
    const rebuild = manager.rebuildRuntimeAfterCliIdle({ hasCliOwnership: () => cliOwned, projectId, sessionId: 'session-1', permissionMode: 'default', model: 'default', effort: null })
    cliOwned = true
    const secondActive = manager.closeForExternalOwner('session-1')
    resolveInterrupt()

    await expect(closing).resolves.toBe(true)
    await expect(secondActive).resolves.toBe(true)
    await expect(rebuild).resolves.toBe(false)
    expect(queryMock).toHaveBeenCalledTimes(1)
    manager.closeAll()
  })

  it('does not re-arm a deleted session while its external-owner close is pending', async () => {
    let resolveInterrupt!: () => void
    const interrupt = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          resolveInterrupt = () => resolve(undefined)
        }),
    )
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { interrupt }))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')
    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'active', userMessageUuid: 'user-1', permissionMode: 'default' })

    const deleted = manager.closeForExternalOwner('session-1', 'deleted', { rebuildAfterCliIdle: false })
    const secondActive = manager.closeForExternalOwner('session-1')
    resolveInterrupt()

    await expect(deleted).resolves.toBe(true)
    await expect(secondActive).resolves.toBe(true)
    await expect(manager.rebuildRuntimeAfterCliIdle({ hasCliOwnership: () => false, projectId, sessionId: 'session-1', permissionMode: 'default', model: 'default', effort: null })).resolves.toBe(
      false,
    )
    expect(queryMock).toHaveBeenCalledTimes(1)
    manager.closeAll()
  })

  it('does not fail a caller waiting on runtime setup after external ownership closes it', async () => {
    let rejectInitialization!: (error: Error) => void
    const pendingInitialization = new Promise<Awaited<ReturnType<Query['initializationResult']>>>((_resolve, reject) => {
      rejectInitialization = reject
    })
    const close = vi.fn(() => rejectInitialization(new Error('Query closed before response received')))
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
      pendingQuery(prompt, {
        close,
        initializationResult: vi.fn(() => pendingInitialization),
      }),
    )
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    const ensure = manager.ensureRuntime({ projectId, sessionId: 'session-1' })
    await vi.waitFor(() => expect(queryMock).toHaveBeenCalledTimes(1))
    await manager.closeForExternalOwner('session-1')

    await expect(ensure).resolves.toBeNull()
    expect(close).toHaveBeenCalledTimes(1)
    manager.closeAll()
  })

  it('holds new turns until a CLI-idle replacement initializes', async () => {
    let resolveInitialization!: () => void
    const replacementReady = new Promise<void>((resolve) => {
      resolveInitialization = resolve
    })
    queryMock
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
        pendingQuery(prompt, {
          initializationResult: vi.fn(async () => {
            await replacementReady
            return {} as Awaited<ReturnType<Query['initializationResult']>>
          }),
        }),
      )
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')
    await manager.ensureRuntime({ projectId, sessionId: 'session-1' })
    await manager.closeForExternalOwner('session-1')

    const rebuild = manager.rebuildRuntimeAfterCliIdle({ hasCliOwnership: () => false, projectId, sessionId: 'session-1', permissionMode: 'default', model: 'default', effort: null })
    let started = false
    const start = manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'latest', userMessageUuid: 'user-1', permissionMode: 'default' }).then(() => {
      started = true
    })
    await Promise.resolve()
    expect(started).toBe(false)

    resolveInitialization()
    await expect(rebuild).resolves.toBe(true)
    await start
    expect(started).toBe(true)
    manager.closeAll()
  })

  it('cleans up a failed CLI-idle replacement so a later request can retry', async () => {
    const replacementClose = vi.fn()
    queryMock
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
        pendingQuery(prompt, {
          close: replacementClose,
          initializationResult: vi.fn().mockRejectedValue(new Error('setup failed')),
        }),
      )
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')
    await manager.ensureRuntime({ projectId, sessionId: 'session-1' })
    await manager.closeForExternalOwner('session-1')

    await expect(manager.rebuildRuntimeAfterCliIdle({ hasCliOwnership: () => false, projectId, sessionId: 'session-1', permissionMode: 'default', model: 'default', effort: null })).rejects.toThrow(
      'setup failed',
    )
    expect(replacementClose).toHaveBeenCalledTimes(1)
    await expect(manager.ensureRuntime({ projectId, sessionId: 'session-1' })).resolves.toEqual({})
    expect(queryMock).toHaveBeenCalledTimes(3)
    manager.closeAll()
  })

  it('does not rebuild a runtime without prior external ownership', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await expect(manager.rebuildRuntimeAfterCliIdle({ hasCliOwnership: () => false, projectId, sessionId: 'session-1', permissionMode: 'default', model: 'default', effort: null })).resolves.toBe(
      false,
    )
    expect(queryMock).not.toHaveBeenCalled()
    manager.closeAll()
  })

  it('does not arm a CLI-idle rebuild when external ownership finds no runtime', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await expect(manager.closeForExternalOwner('session-1')).resolves.toBe(false)
    await expect(manager.rebuildRuntimeAfterCliIdle({ hasCliOwnership: () => false, projectId, sessionId: 'session-1', permissionMode: 'default', model: 'default', effort: null })).resolves.toBe(
      false,
    )
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('keeps a CLI-idle rebuild armed across repeated active notifications with no runtime', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')
    const rebuildInput = { hasCliOwnership: () => false, projectId, sessionId: 'session-1', permissionMode: 'default' as const, model: 'default' as const, effort: null }

    await manager.ensureRuntime({ projectId, sessionId: 'session-1' })
    await manager.closeForExternalOwner('session-1')
    await expect(manager.closeForExternalOwner('session-1')).resolves.toBe(false)
    await expect(manager.rebuildRuntimeAfterCliIdle(rebuildInput)).resolves.toBe(true)
    expect(queryMock).toHaveBeenCalledTimes(2)
    manager.closeAll()
  })

  it('cancels a pending CLI-idle rebuild when deletion finds no runtime', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')
    const rebuildInput = { hasCliOwnership: () => false, projectId, sessionId: 'session-1', permissionMode: 'default' as const, model: 'default' as const, effort: null }

    await manager.ensureRuntime({ projectId, sessionId: 'session-1' })
    await manager.closeForExternalOwner('session-1')
    await expect(manager.closeForExternalOwner('session-1', 'deleted', { rebuildAfterCliIdle: false })).resolves.toBe(false)
    await expect(manager.rebuildRuntimeAfterCliIdle(rebuildInput)).resolves.toBe(false)
    expect(queryMock).toHaveBeenCalledTimes(1)
    manager.closeAll()
  })

  it('clears external-owner generations after rebuild or non-rebuild closure', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')
    const rebuildInput = { hasCliOwnership: () => false, projectId, sessionId: 'session-1', permissionMode: 'default' as const, model: 'default' as const, effort: null }

    await manager.ensureRuntime({ projectId, sessionId: 'session-1' })
    await manager.closeForExternalOwner('session-1')
    await expect(manager.rebuildRuntimeAfterCliIdle(rebuildInput)).resolves.toBe(true)
    await expect(manager.rebuildRuntimeAfterCliIdle(rebuildInput)).resolves.toBe(false)

    await manager.closeForExternalOwner('session-1', 'deleted', { rebuildAfterCliIdle: false })
    await expect(manager.rebuildRuntimeAfterCliIdle(rebuildInput)).resolves.toBe(false)
    manager.closeAll()
  })

  it('interrupts active frontend turns before closing for external ownership', async () => {
    const close = vi.fn()
    const interrupt = vi.fn()
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { close, interrupt }))
    const manager = new LiveTurnManager()
    const events: LiveTurnEvent[] = []
    manager.subscribe('session-1', (event) => events.push(event))
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'active', userMessageUuid: 'user-1', permissionMode: 'default' })
    await expect(manager.closeForExternalOwner('session-1')).resolves.toBe(true)

    expect(interrupt).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual({ type: 'cotta_live_turn_failed', error: 'Session was interrupted because it was taken over by Claude Code CLI/background agent.', session_id: 'session-1' })
    expect(manager.sessionRunState('session-1')).toEqual({ phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'user-1', outcome: 'error' } })
  })

  it('closes idle runtimes for external ownership without interrupting', async () => {
    const close = vi.fn()
    const interrupt = vi.fn()
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { close, interrupt }))
    const manager = new LiveTurnManager()
    await manager.ensureRuntime({ projectId: Buffer.from('/repo/a').toString('base64url'), sessionId: 'session-1' })

    await expect(manager.closeForExternalOwner('session-1')).resolves.toBe(true)

    expect(interrupt).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes a session runtime explicitly once', async () => {
    const close = vi.fn()
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => streamingQuery(prompt, { close }))
    const manager = new LiveTurnManager()

    await manager.ensureRuntime({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
    })

    expect(manager.close('session-1')).toBe(true)
    expect(manager.close('session-1')).toBe(false)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes all session runtimes', async () => {
    const closeA = vi.fn()
    const closeB = vi.fn()
    queryMock
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => streamingQuery(prompt, { close: closeA }))
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => streamingQuery(prompt, { close: closeB }))
    const manager = new LiveTurnManager()

    await Promise.all([
      manager.ensureRuntime({ projectId: Buffer.from('/repo/a').toString('base64url'), sessionId: 'session-1' }),
      manager.ensureRuntime({ projectId: Buffer.from('/repo/a').toString('base64url'), sessionId: 'session-2' }),
    ])
    manager.closeAll()

    expect(closeA).toHaveBeenCalledTimes(1)
    expect(closeB).toHaveBeenCalledTimes(1)
  })

  it('arbitrates concurrent turns and checks external ownership inside the lifecycle lock', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    let externallyOwned = false
    const manager = new LiveTurnManager(undefined, undefined, undefined, undefined, () => (externallyOwned ? {} : null))
    const input = { projectId: Buffer.from('/repo/a').toString('base64url'), sessionId: 'session-1', resume: true, text: 'hello', permissionMode: 'default' as const }

    const [first, second] = await Promise.allSettled([manager.startTurn({ ...input, userMessageUuid: 'user-1' }), manager.startTurn({ ...input, userMessageUuid: 'user-2' })])
    expect(first.status).toBe('fulfilled')
    expect(second).toMatchObject({ status: 'rejected', reason: expect.any(SessionTurnInProgressError) })

    externallyOwned = true
    await expect(manager.startTurn({ ...input, sessionId: 'session-2', userMessageUuid: 'user-3' })).rejects.toBeInstanceOf(SessionExternallyOwnedError)
    expect(queryMock).toHaveBeenCalledTimes(1)
    manager.closeAll()
  })

  it('applies max effort to an idle runtime without recreating it', async () => {
    const close = vi.fn()
    const applyFlagSettings = vi.fn()
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => streamingQuery(prompt, { close, applyFlagSettings }))
    const manager = new LiveTurnManager()

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      resume: true,
      text: 'first',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
      effort: 'high',
    })
    await vi.waitFor(() => expect(manager.sessionRunState('session-1')).toEqual({ phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'user-1', outcome: 'success' } }))

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      resume: true,
      text: 'second',
      userMessageUuid: 'user-2',
      permissionMode: 'default',
      effort: 'max',
    })

    await vi.waitFor(() => expect(manager.sessionRunState('session-1')).toEqual({ phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'user-2', outcome: 'success' } }))

    expect(close).not.toHaveBeenCalled()
    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'max' })
  })

  it('closes idle runtimes after ten minutes', async () => {
    vi.useFakeTimers()
    const close = vi.fn()
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { close }))
    const manager = new LiveTurnManager()

    await manager.ensureRuntime({ projectId: Buffer.from('/repo/a').toString('base64url'), sessionId: 'session-1' })
    vi.advanceTimersByTime(10 * 60 * 1000 - 1)
    expect(close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(close).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('keeps runtimes with background tasks alive until their snapshot clears', async () => {
    vi.useFakeTimers()
    const close = vi.fn()
    const messages: SDKMessage[] = []
    let resume: (() => void) | null = null
    let emit!: (message: SDKMessage) => void
    queryMock.mockImplementation(() => {
      emit = (message) => {
        messages.push(message)
        resume?.()
        resume = null
      }
      return queryFromGenerator(
        (async function* () {
          for (;;) {
            if (messages.length === 0) await new Promise<void>((resolve) => (resume = resolve))
            while (messages.length > 0) yield messages.shift()!
          }
        })(),
        { close },
      )
    })
    const manager = new LiveTurnManager()

    await manager.ensureRuntime({ projectId: Buffer.from('/repo/a').toString('base64url'), sessionId: 'session-1' })
    emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'task-1', task_type: 'local_bash', description: 'Bash' }] } as SDKMessage)
    await vi.waitFor(() => expect(manager.liveBackgroundTasks('session-1')).toHaveLength(1))
    vi.advanceTimersByTime(10 * 60 * 1000)
    expect(close).not.toHaveBeenCalled()

    emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] } as unknown as SDKMessage)
    await vi.waitFor(() => expect(manager.liveBackgroundTasks('session-1')).toEqual([]))
    vi.advanceTimersByTime(10 * 60 * 1000)
    expect(close).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('clears the idle timer when a new turn starts', async () => {
    vi.useFakeTimers()
    const close = vi.fn()
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { close }))
    const manager = new LiveTurnManager()

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      resume: true,
      text: 'hello',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
    })
    vi.advanceTimersByTime(10 * 60 * 1000)

    expect(close).not.toHaveBeenCalled()
    manager.closeAll()
    vi.useRealTimers()
  })

  it('closes the runtime after the SDK stream rejects', async () => {
    const close = vi.fn()
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
      queryFromGenerator(
        (async function* () {
          for await (const message of prompt) {
            yield message
            throw new Error('SDK stream failed')
          }
        })(),
        { close },
      ),
    )
    const manager = new LiveTurnManager()
    const events: LiveTurnEvent[] = []
    manager.subscribe('session-1', (event) => events.push(event))

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      resume: true,
      text: 'hello',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
    })

    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('offers native restore and manual ExitPlanMode approvals without optimistic mode changes', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => planModeQuery(prompt))
    const onPermissionModeChanged = vi.fn()
    const manager = new LiveTurnManager({ onPermissionModeChanged })
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'plan it', userMessageUuid: 'user-1', permissionMode: 'auto' })
    await vi.waitFor(() => expect(onPermissionModeChanged).toHaveBeenCalledWith({ sessionId: 'session-1', projectId, mode: 'plan', observedAtMs: expect.any(Number) }))
    const canUseTool = queryMock.mock.calls[0]?.[0].options.canUseTool
    const sdkSuggestion = { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash' }] }
    const nativeRestore = canUseTool(
      'ExitPlanMode',
      {},
      {
        requestId: 'req-1',
        toolUseID: 'exit-1',
        signal: new AbortController().signal,
        suggestions: [{ type: 'setMode', mode: 'auto', destination: 'session' }, sdkSuggestion],
      },
    )
    const pending = manager.sessionRunState('session-1')
    expect(pending?.phase === 'requires_action' ? pending.pendingPermission?.suggestions : undefined).toBeUndefined()

    expect(manager.respondToPermission('session-1', 'req-1', { decision: 'allow' })).toEqual({ status: 'answered' })
    await expect(nativeRestore).resolves.toEqual({ behavior: 'allow', toolUseID: 'exit-1' })
    expect(onPermissionModeChanged).toHaveBeenCalledTimes(1)

    const manual = canUseTool('ExitPlanMode', {}, { requestId: 'req-2', toolUseID: 'exit-2', signal: new AbortController().signal })
    const defaultMode = { type: 'setMode', mode: 'default', destination: 'session' }
    expect(manager.respondToPermission('session-1', 'req-2', { decision: 'allow_suggestion' })).toEqual({ status: 'answered' })
    await expect(manual).resolves.toEqual({ behavior: 'allow', toolUseID: 'exit-2', updatedPermissions: [defaultMode] })
    expect(onPermissionModeChanged).toHaveBeenCalledTimes(1)
  })

  it('maps the ExitPlanMode manual action to the fixed default mode update', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'plan it', userMessageUuid: 'user-1', permissionMode: 'plan' })
    const canUseTool = queryMock.mock.calls[0]?.[0].options.canUseTool
    const approval = canUseTool('ExitPlanMode', {}, { requestId: 'req-1', toolUseID: 'exit-1', signal: new AbortController().signal })

    expect(manager.respondToPermission('session-1', 'req-1', { decision: 'allow_suggestion' })).toEqual({ status: 'answered' })
    await expect(approval).resolves.toEqual({
      behavior: 'allow',
      toolUseID: 'exit-1',
      updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }],
    })
  })

  it('does not infer permission mode from a successful EnterPlanMode tool result', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
      queryFromGenerator(
        (async function* () {
          for await (const _message of prompt) {
            yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'EnterPlanMode', input: {} }] } } as unknown as SDKMessage
            yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Entered plan mode.' }] } } as unknown as SDKMessage
            yield { type: 'result', subtype: 'success' } as SDKMessage
          }
        })(),
      ),
    )
    const onPermissionModeChanged = vi.fn()
    const manager = new LiveTurnManager({ onPermissionModeChanged })
    const events: LiveTurnEvent[] = []
    manager.subscribe('session-1', (event) => events.push(event))

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      resume: true,
      text: 'plan it',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
    })

    await vi.waitFor(() => expect(events.some((event) => event.type === 'result')).toBe(true))
    expect(onPermissionModeChanged).not.toHaveBeenCalled()
  })

  it('ignores a failed EnterPlanMode tool result', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
      queryFromGenerator(
        (async function* () {
          for await (const _message of prompt) {
            yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'EnterPlanMode', input: {} }] } } as unknown as SDKMessage
            yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'boom', is_error: true }] } } as unknown as SDKMessage
            yield { type: 'result', subtype: 'success' } as SDKMessage
          }
        })(),
      ),
    )
    const onPermissionModeChanged = vi.fn()
    const manager = new LiveTurnManager({ onPermissionModeChanged })
    const events: LiveTurnEvent[] = []
    manager.subscribe('session-1', (event) => events.push(event))

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      resume: true,
      text: 'plan it',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
    })

    await vi.waitFor(() => expect(events.some((event) => event.type === 'result')).toBe(true))
    expect(onPermissionModeChanged).not.toHaveBeenCalled()
  })
})
