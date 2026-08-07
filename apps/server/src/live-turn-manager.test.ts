import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { LiveEventStore, PersistedLiveEventRecord } from './live-event-store.js'

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}))

import { LiveTurnManager, type LiveTurnEvent } from './live-turn-manager.js'

function queryFromGenerator(generator: AsyncGenerator<SDKMessage>, overrides: Partial<Query> = {}): Query {
  return Object.assign(generator, { close: vi.fn(), interrupt: vi.fn(), setPermissionMode: vi.fn(), setModel: vi.fn(), applyFlagSettings: vi.fn(), initializationResult: vi.fn().mockResolvedValue({}), ...overrides }) as unknown as Query
}

function streamingQuery(prompt: AsyncIterable<SDKUserMessage>, overrides: Partial<Query> = {}): Query {
  return queryFromGenerator((async function* () {
    for await (const message of prompt) {
      yield message
      yield { type: 'result', subtype: 'success' } as SDKMessage
    }
  })(), overrides)
}

function failingQuery(prompt: AsyncIterable<SDKUserMessage>): Query {
  return queryFromGenerator((async function* () {
    for await (const message of prompt) {
      yield message
      throw new Error('SDK stream failed')
    }
  })())
}

function endingQuery(prompt: AsyncIterable<SDKUserMessage>): Query {
  return queryFromGenerator((async function* () {
    for await (const _message of prompt) return
  })())
}

function resultOnlyQuery(prompt: AsyncIterable<SDKUserMessage>): Query {
  return queryFromGenerator((async function* () {
    for await (const _message of prompt) yield { type: 'result', subtype: 'success' } as SDKMessage
  })())
}

function requiresActionQuery(prompt: AsyncIterable<SDKUserMessage>): Query {
  return queryFromGenerator((async function* () {
    for await (const _message of prompt) {
      yield { type: 'system', subtype: 'session_state_changed', state: 'requires_action' } as SDKMessage
      yield { type: 'result', subtype: 'success' } as SDKMessage
    }
  })())
}

function pendingQuery(prompt: AsyncIterable<SDKUserMessage>, overrides: Partial<Query> = {}): Query {
  return queryFromGenerator((async function* () {
    for await (const message of prompt) yield message
  })(), overrides)
}

function recordingStore(messages: unknown[]): LiveEventStore {
  return {
    append: (_projectId, _sessionId, message) => messages.push(message),
    listSessionEvents: () => [] as PersistedLiveEventRecord[],
  }
}

describe('LiveTurnManager', () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it('creates a new SDK session with the client-provided session id', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => resultOnlyQuery(prompt))
    const persisted: unknown[] = []
    const recordLiveResult = vi.fn()
    const manager = new LiveTurnManager(recordingStore(persisted), undefined, { recordLiveResult })
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

    expect(queryMock).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({ sessionId: 'session-1' }),
    }))
    expect(queryMock.mock.calls[0]?.[0].options).not.toHaveProperty('resume')
    await vi.waitFor(() => expect(persisted).toHaveLength(2))

    expect(persisted[0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      parent_tool_use_id: null,
      uuid: 'user-1',
      session_id: 'session-1',
      timestamp: expect.any(String),
    })
    expect(persisted[1]).toMatchObject({ type: 'result', subtype: 'success' })
    expect(recordLiveResult).toHaveBeenCalledWith(Buffer.from('/repo/a').toString('base64url'), 'session-1', 'user-1', expect.objectContaining({ type: 'result', subtype: 'success' }))
    expect(events).toEqual([expect.objectContaining({ type: 'result', subtype: 'success' })])
  })

  it('publishes a failure terminal event when the SDK stream rejects', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => failingQuery(prompt))
    const observeSession = vi.fn()
    const manager = new LiveTurnManager(undefined, { observeSession })
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
    expect(observeSession).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'session-1' }))
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

  it('observes key runtime states without publishing run-state versions immediately', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => requiresActionQuery(prompt))
    const observeSession = vi.fn()
    const manager = new LiveTurnManager(undefined, { observeSession })
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
    await vi.waitFor(() => expect(observeSession).toHaveBeenCalledTimes(3))
    expect(observeSession.mock.calls).toEqual([
      [{ sessionId: 'session-1', projectId }],
      [{ sessionId: 'session-1', projectId }],
      [{ sessionId: 'session-1', projectId }],
    ])
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

    expect(queryMock).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({ model: 'claude-sonnet-5', effort: 'xhigh' }),
    }))
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

    expect(queryMock).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({ model: 'default' }),
    }))
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
    expect(setModel).toHaveBeenCalledWith('claude-sonnet-5')
    expect(applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'xhigh' })
    await vi.waitFor(() => expect(manager.sessionRunState('session-1')).toEqual({ phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'user-2', outcome: 'success' } }))
    await manager.rebuildRuntimeAfterCliIdle({ projectId: Buffer.from('/repo/a').toString('base64url'), sessionId: 'session-1', permissionMode: 'plan', model: 'claude-sonnet-5', effort: 'xhigh' })
    expect(queryMock).toHaveBeenLastCalledWith(expect.objectContaining({
      options: expect.objectContaining({ permissionMode: 'plan', model: 'claude-sonnet-5', effort: 'xhigh' }),
    }))
    manager.closeAll()
  })

  it('clears effort when a reused runtime switches to no effort', async () => {
    const applyFlagSettings = vi.fn()
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => streamingQuery(prompt, { applyFlagSettings }))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'first', userMessageUuid: 'user-1', permissionMode: 'default', model: 'claude-opus-5', effort: 'high' })
    await vi.waitFor(() => expect(manager.sessionRunState('session-1')?.phase).toBe('idle'))
    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'second', userMessageUuid: 'user-2', permissionMode: 'default', model: 'default', effort: null })

    expect(applyFlagSettings).toHaveBeenCalledWith({ effortLevel: null })
  })

  it('updates a reused runtime to the explicit default model', async () => {
    const setModel = vi.fn()
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => streamingQuery(prompt, { setModel }))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'first', userMessageUuid: 'user-1', permissionMode: 'default', model: 'claude-opus-5' })
    await vi.waitFor(() => expect(manager.sessionRunState('session-1')?.phase).toBe('idle'))
    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'second', userMessageUuid: 'user-2', permissionMode: 'default', model: 'default' })

    expect(setModel).toHaveBeenCalledWith('default')
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
    await expect(manager.ensureRuntime({ projectId: projectB, sessionId: 'session-1' })).resolves.toBeUndefined()

    expect(close).toHaveBeenCalledTimes(1)
    expect(queryMock).toHaveBeenLastCalledWith(expect.objectContaining({ options: expect.objectContaining({ cwd: '/repo/b', resume: 'session-1' }) }))
    await expect(manager.ensureRuntime({ projectId: projectB, sessionId: 'session-1' })).resolves.toBeUndefined()
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

    await expect(manager.rebuildRuntimeAfterCliIdle({ projectId: projectB, sessionId: 'session-1', permissionMode: 'plan', model: 'default', effort: null })).resolves.toBe(true)

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
    await expect(manager.rebuildRuntimeAfterCliIdle({ projectId, sessionId: 'session-1', permissionMode: 'plan', model: 'claude-opus-5', effort: 'high' })).resolves.toBe(true)

    expect(close).toHaveBeenCalledTimes(1)
    expect(queryMock).toHaveBeenCalledTimes(2)
    expect(queryMock).toHaveBeenLastCalledWith(expect.objectContaining({
      options: expect.objectContaining({ resume: 'session-1', permissionMode: 'plan', model: 'claude-opus-5', effort: 'high' }),
    }))
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
    await expect(manager.rebuildRuntimeAfterCliIdle({ projectId, sessionId: 'session-1', permissionMode: 'plan', model: 'claude-opus-5', effort: 'high' })).resolves.toBe(true)

    expect(close).toHaveBeenCalledTimes(1)
    expect(queryMock).toHaveBeenCalledTimes(2)
    expect(queryMock).toHaveBeenLastCalledWith(expect.objectContaining({
      options: expect.objectContaining({ cwd: '/repo/a', resume: 'session-1', permissionMode: 'plan', model: 'claude-opus-5', effort: 'high' }),
    }))
    manager.closeAll()
  })

  it('waits for external ownership to close before rebuilding', async () => {
    let resolveInterrupt!: () => void
    const interrupt = vi.fn(() => new Promise<undefined>((resolve) => { resolveInterrupt = () => resolve(undefined) }))
    queryMock
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { interrupt }))
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')
    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'active', userMessageUuid: 'user-1', permissionMode: 'default' })

    const closing = manager.closeForExternalOwner('session-1')
    const rebuild = manager.rebuildRuntimeAfterCliIdle({ projectId, sessionId: 'session-1', permissionMode: 'default', model: 'default', effort: null })
    await Promise.resolve()
    expect(queryMock).toHaveBeenCalledTimes(1)

    resolveInterrupt()
    await expect(closing).resolves.toBe(true)
    await expect(rebuild).resolves.toBe(true)
    expect(queryMock).toHaveBeenCalledTimes(2)
    manager.closeAll()
  })

  it('does not rebuild when CLI ownership becomes active again during close', async () => {
    let resolveInterrupt!: () => void
    const interrupt = vi.fn(() => new Promise<undefined>((resolve) => { resolveInterrupt = () => resolve(undefined) }))
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { interrupt }))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')
    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'active', userMessageUuid: 'user-1', permissionMode: 'default' })

    const closing = manager.closeForExternalOwner('session-1')
    const rebuild = manager.rebuildRuntimeAfterCliIdle({ projectId, sessionId: 'session-1', permissionMode: 'default', model: 'default', effort: null })
    const secondActive = manager.closeForExternalOwner('session-1')
    resolveInterrupt()

    await expect(closing).resolves.toBe(true)
    await expect(secondActive).resolves.toBe(true)
    await expect(rebuild).resolves.toBe(false)
    expect(queryMock).toHaveBeenCalledTimes(1)
    manager.closeAll()
  })

  it('holds new turns until a CLI-idle replacement initializes', async () => {
    let resolveInitialization!: () => void
    const replacementReady = new Promise<void>((resolve) => { resolveInitialization = resolve })
    queryMock
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, {
        initializationResult: vi.fn(async () => { await replacementReady; return {} as Awaited<ReturnType<Query['initializationResult']>> }),
      }))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')
    await manager.ensureRuntime({ projectId, sessionId: 'session-1' })

    const rebuild = manager.rebuildRuntimeAfterCliIdle({ projectId, sessionId: 'session-1', permissionMode: 'default', model: 'default', effort: null })
    let started = false
    const start = manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'latest', userMessageUuid: 'user-1', permissionMode: 'default' }).then(() => { started = true })
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
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, {
        close: replacementClose,
        initializationResult: vi.fn().mockRejectedValue(new Error('setup failed')),
      }))
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')
    await manager.ensureRuntime({ projectId, sessionId: 'session-1' })

    await expect(manager.rebuildRuntimeAfterCliIdle({ projectId, sessionId: 'session-1', permissionMode: 'default', model: 'default', effort: null })).rejects.toThrow('setup failed')
    expect(replacementClose).toHaveBeenCalledTimes(1)
    await expect(manager.ensureRuntime({ projectId, sessionId: 'session-1' })).resolves.toBeUndefined()
    expect(queryMock).toHaveBeenCalledTimes(3)
    manager.closeAll()
  })

  it('does not rebuild a runtime with an active frontend turn', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt))
    const manager = new LiveTurnManager()
    const projectId = Buffer.from('/repo/a').toString('base64url')
    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'active', userMessageUuid: 'user-1', permissionMode: 'default' })

    await expect(manager.rebuildRuntimeAfterCliIdle({ projectId, sessionId: 'session-1', permissionMode: 'default', model: 'default', effort: null })).resolves.toBe(false)
    expect(queryMock).toHaveBeenCalledTimes(1)
    manager.closeAll()
  })

  it('interrupts active frontend turns before closing for external ownership', async () => {
    const close = vi.fn()
    const interrupt = vi.fn()
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { close, interrupt }))
    const persisted: unknown[] = []
    const manager = new LiveTurnManager(recordingStore(persisted))
    const events: LiveTurnEvent[] = []
    manager.subscribe('session-1', (event) => events.push(event))
    const projectId = Buffer.from('/repo/a').toString('base64url')

    await manager.startTurn({ projectId, sessionId: 'session-1', resume: true, text: 'active', userMessageUuid: 'user-1', permissionMode: 'default' })
    await expect(manager.closeForExternalOwner('session-1')).resolves.toBe(true)

    expect(interrupt).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual({ type: 'cotta_live_turn_failed', error: 'Session was interrupted because it was taken over by Claude Code CLI/background agent.', session_id: 'session-1' })
    expect(persisted[0]).toMatchObject({ type: 'user', uuid: 'user-1' })
    expect(persisted).toContainEqual({ type: 'cotta_live_turn_failed', error: 'Session was interrupted because it was taken over by Claude Code CLI/background agent.', session_id: 'session-1' })
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

  it('recreates the runtime when escalating to max effort', async () => {
    const close = vi.fn()
    queryMock
      .mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => streamingQuery(prompt, { close }))
      .mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => streamingQuery(prompt))
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

    expect(close).toHaveBeenCalledTimes(1)
    expect(queryMock).toHaveBeenLastCalledWith(expect.objectContaining({
      options: expect.objectContaining({ resume: 'session-1', effort: 'max' }),
    }))
  })

  it('closes idle runtimes after ten minutes', () => {
    vi.useFakeTimers()
    const close = vi.fn()
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => pendingQuery(prompt, { close }))
    const manager = new LiveTurnManager()

    manager.ensureRuntime({ projectId: Buffer.from('/repo/a').toString('base64url'), sessionId: 'session-1' })
    vi.advanceTimersByTime(10 * 60 * 1000 - 1)
    expect(close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

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
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => queryFromGenerator((async function* () {
      for await (const message of prompt) {
        yield message
        throw new Error('SDK stream failed')
      }
    })(), { close }))
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
})
