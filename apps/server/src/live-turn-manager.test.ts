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
  return Object.assign(generator, { close: vi.fn(), interrupt: vi.fn(), setPermissionMode: vi.fn(), setModel: vi.fn(), applyFlagSettings: vi.fn(), ...overrides }) as unknown as Query
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

function resultOnlyQuery(prompt: AsyncIterable<SDKUserMessage>): Query {
  return queryFromGenerator((async function* () {
    for await (const _message of prompt) yield { type: 'result', subtype: 'success' } as SDKMessage
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

  it('persists the user turn before SDK output without publishing it', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => resultOnlyQuery(prompt))
    const persisted: unknown[] = []
    const manager = new LiveTurnManager(recordingStore(persisted))
    const events: LiveTurnEvent[] = []
    manager.subscribe('session-1', (event) => events.push(event))

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      text: 'hello',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
    })

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
    expect(events).toEqual([expect.objectContaining({ type: 'result', subtype: 'success' })])
  })

  it('publishes a failure terminal event when the SDK stream rejects', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => failingQuery(prompt))
    const manager = new LiveTurnManager()
    const events: LiveTurnEvent[] = []
    manager.subscribe('session-1', (event) => events.push(event))

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      text: 'hello',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
      model: 'claude-opus-5',
      effort: 'high',
    })

    await vi.waitFor(() => expect(events).toHaveLength(2))

    expect(events[0]).toMatchObject({ type: 'user', uuid: 'user-1' })
    expect(events[1]).toMatchObject({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['SDK stream failed'], session_id: 'session-1' })
    expect(manager.sessionRunState('session-1')).toEqual({ phase: 'idle', activeTurnId: null, lastTurn: { id: 'user-1', outcome: 'error' } })
  })

  it('passes model and effort to new SDK runtimes', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => streamingQuery(prompt))
    const manager = new LiveTurnManager()

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
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

  it('omits model and effort when using SDK defaults', async () => {
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => streamingQuery(prompt))
    const manager = new LiveTurnManager()

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      text: 'first',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
    })

    expect(queryMock).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.not.objectContaining({ model: expect.anything(), effort: expect.anything() }),
    }))
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
      text: 'first',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
      model: 'claude-opus-5',
      effort: 'high',
    })
    await vi.waitFor(() => expect(manager.sessionRunState('session-1')).toEqual({ phase: 'idle', activeTurnId: null, lastTurn: { id: 'user-1', outcome: 'success' } }))
    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
      text: 'second',
      userMessageUuid: 'user-2',
      permissionMode: 'plan',
      model: 'claude-sonnet-5',
      effort: 'xhigh',
    })

    expect(setPermissionMode).toHaveBeenCalledWith('plan')
    expect(setModel).toHaveBeenCalledWith('claude-sonnet-5')
    expect(applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'xhigh' })
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

    manager.ensureRuntime({ projectId: Buffer.from('/repo/a').toString('base64url'), sessionId: 'session-1' })
    manager.ensureRuntime({ projectId: Buffer.from('/repo/a').toString('base64url'), sessionId: 'session-2' })
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
      text: 'first',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
      effort: 'high',
    })
    await vi.waitFor(() => expect(manager.sessionRunState('session-1')).toEqual({ phase: 'idle', activeTurnId: null, lastTurn: { id: 'user-1', outcome: 'success' } }))

    await manager.startTurn({
      projectId: Buffer.from('/repo/a').toString('base64url'),
      sessionId: 'session-1',
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
      text: 'hello',
      userMessageUuid: 'user-1',
      permissionMode: 'default',
    })

    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(close).toHaveBeenCalledTimes(1)
  })
})
