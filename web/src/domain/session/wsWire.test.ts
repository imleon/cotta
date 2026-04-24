import { describe, expect, it } from 'vitest'
import { isExternalAdminWsEvent, isSessionEventWire } from './wsWire'

describe('wsWire', () => {
  it('accepts public session events as external admin ws events', () => {
    const event = { type: 'session.run.completed', sessionId: 'session-1', runId: 'run-1' }

    expect(isExternalAdminWsEvent(event)).toBe(true)
    expect(isSessionEventWire(event)).toBe(true)
  })

  it('accepts explicit ws notices but does not treat them as session events', () => {
    const notice = { type: 'ws.notice', message: 'read only' }

    expect(isExternalAdminWsEvent(notice)).toBe(true)
    expect(isSessionEventWire(notice)).toBe(false)
  })

  it('rejects internal worker events on the public ws boundary', () => {
    const workerEvent = {
      kind: 'sdk_message',
      sessionId: 'session-1',
      runId: 'run-1',
      receivedAt: Date.now(),
      payload: { type: 'assistant' },
    }

    expect(isExternalAdminWsEvent(workerEvent)).toBe(false)
    expect(isSessionEventWire(workerEvent)).toBe(false)
  })
})
