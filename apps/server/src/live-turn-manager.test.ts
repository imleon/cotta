import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}))

import { LiveTurnManager, type LiveTurnEvent } from './live-turn-manager.js'

function failingQuery(prompt: AsyncIterable<SDKUserMessage>): Query {
  const iterator = (async function* () {
    for await (const message of prompt) {
      yield message
      throw new Error('SDK stream failed')
    }
  })()
  return Object.assign(iterator, { interrupt: vi.fn() }) as unknown as Query
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
    })

    await vi.waitFor(() => expect(events).toHaveLength(2))

    expect(events[0]).toMatchObject({ type: 'user', uuid: 'user-1' })
    expect(events[1]).toEqual({ type: 'live.turn.failed', userMessageUuid: 'user-1', error: 'SDK stream failed' })
    expect(manager.sessionState('session-1')).toBeNull()
  })
})
