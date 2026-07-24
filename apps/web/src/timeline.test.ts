import { describe, expect, it } from 'vitest'
import type { TimelineBlock, TurnSummary } from '@cotta/shared'
import { applySdkMessage, isPrimaryUserMessage, LiveAssistantStreamAccumulator, reconcileTimelineTurns, timelineTurnIndex } from './timeline'

function userTurn(id: string, blocks: TimelineBlock[] = []): TurnSummary {
  return {
    id,
    sessionId: 'session-1',
    title: id,
    startedAt: 1,
    rawStatus: 'running',
    displayStatus: 'running',
    blocks: blocks.length > 0 ? blocks : [{ id: `${id}:user`, kind: 'user.message', sourceEventIds: [id], data: { text: id, status: 'pending' } }],
  }
}

describe('timeline reconciliation', () => {
  it('removes pending/live turns represented by history user uuid', () => {
    const pending = userTurn('user-1')
    const history = { ...userTurn('user-1'), rawStatus: 'complete', displayStatus: 'complete', blocks: [{ id: 'history-user', kind: 'user.message', sourceEventIds: ['user-1'], data: { text: 'from history', status: 'confirmed' } }] }

    expect(reconcileTimelineTurns([pending], [history])).toEqual([history])
  })

  it('keeps live assistant blocks while history has only confirmed the user message', () => {
    const live = userTurn('user-1', [
      { id: 'user-1:user', kind: 'user.message', sourceEventIds: ['user-1'], data: { text: 'hello', status: 'pending' } },
      { id: 'user-1:assistant:0:0', kind: 'assistant.text', sourceEventIds: ['stream-1'], apiMessageId: 'msg-1', data: { type: 'text', text: 'partial', streaming: true } },
    ])
    const history = { ...userTurn('user-1'), rawStatus: 'complete', displayStatus: 'complete', blocks: [{ id: 'history-user', kind: 'user.message', sourceEventIds: ['user-1'], data: { text: 'hello', status: 'confirmed' } }] }

    expect(reconcileTimelineTurns([live], [history])[0]!.blocks).toEqual([...history.blocks, live.blocks[1]])
  })

  it('ignores late live assistant blocks represented by history apiMessageId', () => {
    const live = userTurn('user-1')
    const history = userTurn('user-1', [{ id: 'assistant-history', kind: 'assistant.text', sourceEventIds: ['assistant-event-1'], apiMessageId: 'msg-1', data: { text: 'final' } }])
    const raw = { type: 'assistant', uuid: 'assistant-event-2', session_id: 'session-1', message: { id: 'msg-1', content: [{ type: 'text', text: 'late' }] } }

    expect(applySdkMessage([live], raw, timelineTurnIndex([history]), 'user-1', null).turns).toEqual([live])
  })

  it('confirms raw SDK user messages without duplicating the pending turn', () => {
    const pending = userTurn('user-1')
    const raw = { type: 'user', uuid: 'user-1', session_id: 'session-1', message: { role: 'user', content: 'hello' } }

    const result = applySdkMessage([pending], raw, timelineTurnIndex([]), 'user-1', null)

    expect(result.turns).toHaveLength(1)
    expect(result.turns[0]!.id).toBe('user-1')
    expect(result.turns[0]!.blocks[0]!.data).toMatchObject({ text: 'hello', status: 'confirmed' })
  })

  it('does not duplicate live assistant blocks already represented by incoming history', () => {
    const live = userTurn('user-1', [
      { id: 'user-1:user', kind: 'user.message', sourceEventIds: ['user-1'], data: { text: 'hello' } },
      { id: 'user-1:assistant:0:0', kind: 'assistant.text', sourceEventIds: ['assistant-live'], apiMessageId: 'msg-1', data: { type: 'text', text: 'final' } },
    ])
    const history = userTurn('user-1', [
      { id: 'history-user', kind: 'user.message', sourceEventIds: ['user-1'], data: { text: 'hello' } },
      { id: 'history-assistant', kind: 'assistant.text', sourceEventIds: ['assistant-history'], apiMessageId: 'msg-1', data: { type: 'text', text: 'final' } },
    ])

    expect(reconcileTimelineTurns([live], [history])[0]!.blocks).toEqual(history.blocks)
  })




  it('reuses the same assistant draft when message_start is replayed', () => {
    let turns = [userTurn('user-1')]
    const accumulator = new LiveAssistantStreamAccumulator('user-1')
    const historyIndex = timelineTurnIndex([])
    const messages = [
      { type: 'stream_event', uuid: 'stream-start', event: { type: 'message_start', message: { id: 'msg-1' } } },
      { type: 'stream_event', uuid: 'stream-block', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { type: 'stream_event', uuid: 'stream-start-replay', event: { type: 'message_start', message: { id: 'msg-1' } } },
      { type: 'stream_event', uuid: 'stream-delta', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } } },
      { type: 'assistant', uuid: 'assistant-1', session_id: 'session-1', message: { id: 'msg-1', content: [{ type: 'text', text: 'hello' }] } },
    ]

    for (const message of messages) turns = applySdkMessage(turns, message, historyIndex, 'user-1', accumulator).turns

    expect(turns[0]!.blocks.filter((block) => block.kind === 'assistant.text')).toHaveLength(1)
    expect(turns[0]!.blocks.find((block) => block.kind === 'assistant.text')?.id).toBe('user-1:assistant:0:0')
  })

  it('keeps tool results and subsequent assistant output on the active user turn', () => {
    const toolResult = {
      type: 'user',
      uuid: 'tool-result-1',
      session_id: 'session-1',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] },
    }
    const assistant = {
      type: 'assistant',
      uuid: 'assistant-1',
      session_id: 'session-1',
      message: { id: 'message-1', content: [{ type: 'text', text: 'answer' }] },
    }
    const turns = applySdkMessage([userTurn('user-1')], toolResult, timelineTurnIndex([]), 'user-1', new LiveAssistantStreamAccumulator('user-1')).turns
    const result = applySdkMessage(turns, assistant, timelineTurnIndex([]), 'user-1', new LiveAssistantStreamAccumulator('user-1'))

    expect(isPrimaryUserMessage(toolResult)).toBe(false)
    expect(result.turns[0]?.blocks.map((block) => block.kind)).toEqual(['user.message', 'tool.result', 'assistant.text'])
  })

  it('identifies SDK user echoes as primary messages', () => {
    expect(isPrimaryUserMessage({ type: 'user', message: { role: 'user', content: 'hello' } })).toBe(true)
    expect(isPrimaryUserMessage({ type: 'user', message: { role: 'user', content: [{ type: 'image' }] } })).toBe(true)
  })

  it('treats raw SDK result as terminal without adding timeline content', () => {
    const live = userTurn('user-1')
    const raw = { type: 'result', subtype: 'success', is_error: false, errors: [] }

    const result = applySdkMessage([live], raw, timelineTurnIndex([]), 'user-1', null)

    expect(result).toEqual({ turns: [live], currentUserMessageUuid: null, terminal: true })
  })
})
