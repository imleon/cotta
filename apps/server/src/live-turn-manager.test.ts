import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}))

import { LiveTurnManager, type LiveTurnEvent } from './live-turn-manager.js'

function queryFromGenerator(generator: AsyncGenerator<SDKMessage>, overrides: Partial<Query> = {}): Query {
  return Object.assign(generator, { interrupt: vi.fn(), setPermissionMode: vi.fn(), setModel: vi.fn(), applyFlagSettings: vi.fn(), ...overrides }) as unknown as Query
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

describe('LiveTurnManager', () => {
  beforeEach(() => {
    queryMock.mockReset()
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
})
