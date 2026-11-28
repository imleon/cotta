import { describe, expect, it } from 'vitest'
import { decodeLarkCardAction, encodeLarkCardAction, type LarkCardAction } from './lark-card-action.js'

const action: LarkCardAction = {
  version: 1,
  botId: 'bot-1',
  configVersion: 2,
  projectId: 'project-1',
  card: 'turn',
  operation: 'previous_turn',
  sessionId: 'session-1',
  turnId: 'turn-1',
  createdAtMs: 1_000,
}

describe('lark card actions', () => {
  it.each(['first_turn', 'previous_turn', 'latest_turn', 'new', 'refresh_result'] as const)('round trips compact signed %s actions', (operation) => {
    const value = { ...action, operation }
    const token = encodeLarkCardAction(value, 'secret')
    expect(decodeLarkCardAction(token, 'secret', 2_000)).toEqual(value)
    expect(Buffer.byteLength(token)).toBeLessThan(512)
  })

  it('round trips an empty displayed session count', () => {
    const value = { ...action, card: 'sessions' as const, operation: 'refresh' as const, loadedCount: 0 }
    expect(decodeLarkCardAction(encodeLarkCardAction(value, 'secret'), 'secret', 2_000)).toEqual(value)
  })

  it('round trips question answer and submit actions', () => {
    const answer = { ...action, card: 'permission' as const, operation: 'answer' as const, requestId: 'req', toolUseID: 'tool', questionIndex: 1, optionIndex: 0 }
    expect(decodeLarkCardAction(encodeLarkCardAction(answer, 'secret'), 'secret', 2_000)).toEqual(answer)
    const submit = { ...action, card: 'permission' as const, operation: 'submit_answers' as const, requestId: 'req', toolUseID: 'tool' }
    expect(decodeLarkCardAction(encodeLarkCardAction(submit, 'secret'), 'secret', 2_000)).toEqual(submit)
  })

  it('rejects tampering and a different secret', () => {
    const token = encodeLarkCardAction(action, 'secret')
    expect(decodeLarkCardAction(`${token.slice(0, -1)}x`, 'secret', 2_000)).toBeNull()
    expect(decodeLarkCardAction(token, 'other', 2_000)).toBeNull()
  })

  it('rejects future and expired actions', () => {
    const token = encodeLarkCardAction(action, 'secret')
    expect(decodeLarkCardAction(token, 'secret', 999)).toBeNull()
    expect(decodeLarkCardAction(token, 'secret', action.createdAtMs + 14 * 24 * 60 * 60 * 1000 + 1)).toBeNull()
  })

  it('rejects malformed and oversized tokens', () => {
    expect(decodeLarkCardAction('invalid', 'secret')).toBeNull()
    expect(decodeLarkCardAction('x'.repeat(4097), 'secret')).toBeNull()
  })
})
