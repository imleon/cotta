import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PersistedLiveEvent, TimelineBlock, TurnSummary } from '@cotta/shared'
import { applySdkMessage, groupAssistantResponseFrames, groupTimelineBlocks, isPrimaryUserMessage, LiveAssistantStreamAccumulator, LiveEventsTable, liveEventsForTurn, mergePersistedLiveEvents, rawMessageWaterfallRows, RawMessagesDialog, reconcileTimelineTurns, shouldResetSessionTimeline, timelineTurnIndex } from './timeline'

function userTurn(id: string, blocks: TimelineBlock[] = []): TurnSummary {
  return {
    id,
    sessionId: 'session-1',
    title: id,
    startedAt: 1,
    rawStatus: 'running',
    displayStatus: 'running',
    blocks: blocks.length > 0 ? blocks : [{ id: `${id}:user`, kind: 'user.message', sourceEventIds: [id], data: { text: id, status: 'pending', primaryTimelineUserMessage: true } }],
  }
}

describe('timeline scope reset', () => {
  it('preserves pending state when the same primary turn hydrates a real session id', () => {
    expect(shouldResetSessionTimeline(
      { projectId: 'project-1', sessionId: null, pendingPrimaryTurnUuid: 'user-1' },
      { projectId: 'project-1', sessionId: 'session-1', pendingPrimaryTurnUuid: 'user-1' },
    )).toBe(false)
  })

  it('resets when switching real sessions', () => {
    expect(shouldResetSessionTimeline(
      { projectId: 'project-1', sessionId: 'session-1', pendingPrimaryTurnUuid: null },
      { projectId: 'project-1', sessionId: 'session-2', pendingPrimaryTurnUuid: null },
    )).toBe(true)
  })

  it('resets when switching projects', () => {
    expect(shouldResetSessionTimeline(
      { projectId: 'project-1', sessionId: null, pendingPrimaryTurnUuid: 'user-1' },
      { projectId: 'project-2', sessionId: 'session-1', pendingPrimaryTurnUuid: 'user-1' },
    )).toBe(true)
  })

  it('resets null to real session without a pending anchor', () => {
    expect(shouldResetSessionTimeline(
      { projectId: 'project-1', sessionId: null, pendingPrimaryTurnUuid: null },
      { projectId: 'project-1', sessionId: 'session-1', pendingPrimaryTurnUuid: null },
    )).toBe(true)
  })
})

describe('raw timeline messages', () => {
  it('builds waterfall rows from timestamps and block types in endpoint order', () => {
    expect(rawMessageWaterfallRows([
      { timestamp: '2026-01-01T00:00:00.000Z', message: { content: [{ type: 'text', text: 'hi' }] } },
      { timestamp: '2026-01-01T00:00:00.120Z', message: { content: [{ type: 'tool_use' }, { type: 'text' }] } },
      { timestamp: '2026-01-01T00:00:00.500Z', message: { content: [{ type: 'tool_result' }] } },
    ])).toEqual([
      { messageIndex: 0, blockType: 'text', offsetMs: 0, durationMs: 120 },
      { messageIndex: 1, blockType: 'tool_use + text', offsetMs: 120, durationMs: 380 },
      { messageIndex: 2, blockType: 'tool_result', offsetMs: 500, durationMs: 0 },
    ])
  })

  it('ignores raw messages without valid timestamps', () => {
    expect(rawMessageWaterfallRows([
      { timestamp: 'bad', message: { content: [{ type: 'text' }] } },
      { message: { content: [{ type: 'tool_use' }] } },
      { timestamp: '2026-01-01T00:00:00.000Z', message: { content: [{ type: 'tool_result' }] } },
    ])).toEqual([{ messageIndex: 2, blockType: 'tool_result', offsetMs: 0, durationMs: 0 }])
  })

  it('renders raw messages as one row per content block with type split from content', () => {
    const html = renderToStaticMarkup(createElement(RawMessagesDialog, {
      messages: [{
        type: 'assistant',
        uuid: 'assistant-1',
        session_id: 'session-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          role: 'assistant',
          stop_reason: 'tool_use',
          content: [
            { type: 'thinking', thinking: 'plan', signature: '' },
            { type: 'text', text: 'answer' },
            { type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: '/tmp/a' } },
            { type: 'unknown_block', value: 1 },
          ],
        },
      }],
      loading: false,
      error: null,
      liveEvents: [],
      liveEventsLoading: false,
      liveEventsError: null,
      onClose: () => {},
    }))

    expect(html.match(/<tr class="raw-message-assistant"/g)).toHaveLength(4)
    expect(html).toContain('<td rowSpan="4">tool_use</td>')
    expect(html).toContain('<td>thinking</td>')
    expect(html).toContain('<td>text</td>')
    expect(html).toContain('<td>tool_use</td>')
    expect(html).toContain('<td>unknown_block</td>')
    expect(html).toContain('&quot;thinking&quot;: &quot;plan&quot;')
    expect(html).toContain('&quot;name&quot;: &quot;Read&quot;')
    expect(html).not.toContain('&quot;type&quot;: &quot;thinking&quot;')
    expect(html).not.toContain('&quot;type&quot;: &quot;tool_use&quot;')
  })
})

describe('persisted live events debug view', () => {
  const event = (id: number, payload: unknown, eventType = 'stream_event'): PersistedLiveEvent => ({
    id,
    projectId: 'project-1',
    sessionId: 'session-1',
    eventType,
    source: 'sdk',
    recordedAtMs: Date.UTC(2026, 0, 1, 0, 0, id),
    payload,
  })
  const user = (uuid: string) => ({ type: 'user', uuid, message: { role: 'user', content: 'hello' } })

  it('selects events from the primary user through result without crossing turn boundaries', () => {
    const events = [
      event(1, { type: 'system' }, 'system'),
      event(2, user('turn-1'), 'user'),
      event(3, { type: 'assistant', uuid: 'assistant-1' }, 'assistant'),
      event(4, { type: 'result', uuid: 'result-1' }, 'result'),
      event(5, { type: 'system' }, 'system'),
      event(6, user('turn-2'), 'user'),
      event(7, { type: 'result', uuid: 'result-2' }, 'result'),
    ]

    expect(liveEventsForTurn(events.reverse(), 'turn-1').map(({ id }) => id)).toEqual([2, 3, 4, 5])
    expect(liveEventsForTurn(events, 'turn-2').map(({ id }) => id)).toEqual([6, 7])
  })

  it('selects a leading response-only frame until the first primary', () => {
    const events = [
      event(1, { type: 'assistant', uuid: 'leading-assistant', message: { content: [{ type: 'text', text: 'continued' }] } }, 'assistant'),
      event(2, { type: 'status', uuid: 'leading-status', state: 'running' }, 'status'),
      event(3, user('turn-1'), 'user'),
    ]

    expect(liveEventsForTurn(events, 'leading-assistant').map(({ id }) => id)).toEqual([1, 2])
    expect(liveEventsForTurn(events, 'turn-1').map(({ id }) => id)).toEqual([3])
  })

  it('routes late tool results to the tool-use owner across primary boundaries', () => {
    const events = [
      event(1, user('turn-1'), 'user'),
      event(2, { type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: {} }] } }, 'assistant'),
      event(3, user('turn-2'), 'user'),
      event(4, { type: 'user', uuid: 'result-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }] } }, 'user'),
    ]

    expect(liveEventsForTurn(events, 'turn-1').map(({ id }) => id)).toEqual([1, 2, 4])
    expect(liveEventsForTurn(events, 'turn-2').map(({ id }) => id)).toEqual([3])
  })

  it('keeps scalar payloads in the active debug frame', () => {
    const events = [
      event(1, 'leading scalar', 'unknown'),
      event(2, user('turn-1'), 'user'),
      event(3, { type: 'result', uuid: 'result-1' }, 'result'),
      event(4, 'trailing string', 'unknown'),
      event(5, 42, 'unknown'),
      event(6, null, 'unknown'),
      event(7, user('turn-2'), 'user'),
      event(8, 'second frame', 'unknown'),
    ]

    expect(liveEventsForTurn(events, 'turn-1').map(({ id }) => id)).toEqual([2, 3, 4, 5, 6])
    expect(liveEventsForTurn(events, 'turn-2').map(({ id }) => id)).toEqual([7, 8])
  })

  it('keeps scalar payloads after a leading response frame has an id', () => {
    const events = [
      event(1, 'unscoped scalar', 'unknown'),
      event(2, { type: 'assistant', uuid: 'leading-assistant', message: { content: [] } }, 'assistant'),
      event(3, 'scoped scalar', 'unknown'),
      event(4, user('turn-1'), 'user'),
    ]

    expect(liveEventsForTurn(events, 'leading-assistant').map(({ id }) => id)).toEqual([2, 3])
  })

  it('renders the captured event as an independent table', () => {
    const html = renderToStaticMarkup(createElement(LiveEventsTable, {
      events: [event(2, { type: 'assistant', message: { content: 'hello live event' } }, 'assistant')],
      loading: false,
      error: null,
    }))

    expect(html).toContain('Captured live events')
    expect(html).toContain('<th>Recorded</th>')
    expect(html).toContain('<th>Payload</th>')
    expect(html).toContain('hello live event')
  })
})

describe('timeline response frame grouping', () => {
  it('keeps marked primary input separate and frames response-side blocks', () => {
    const display = groupAssistantResponseFrames(groupTimelineBlocks([
      { id: 'primary:user', kind: 'user.message', sourceEventIds: ['primary'], data: { text: 'prompt', primaryTimelineUserMessage: true } },
      { id: 'assistant:text', kind: 'assistant.text', sourceEventIds: ['assistant'], data: { text: 'answer' } },
      { id: 'non-primary:user', kind: 'user.message', sourceEventIds: ['non-primary'], data: { text: 'debug user event' } },
    ]))

    expect(display).toHaveLength(2)
    expect(display[0]).toMatchObject({ type: 'item', item: { type: 'block', block: { id: 'primary:user' } } })
    expect(display[1]).toMatchObject({ type: 'assistant-response-frame' })
    expect(display[1]?.type === 'assistant-response-frame' ? display[1].items.map((item) => item.type === 'block' ? item.block.id : item.toolUseId) : []).toEqual(['assistant:text', 'non-primary:user'])
  })
})

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

  it('keeps reply-side live tool and raw blocks missing from same-turn history', () => {
    const live = userTurn('user-1', [
      { id: 'live-user', kind: 'user.message', sourceEventIds: ['user-1'], data: { text: 'hello', status: 'pending' } },
      { id: 'live-tool-result', kind: 'tool.result', sourceEventIds: ['tool-result-1'], toolUseId: 'tool-1', data: { content: 'done' } },
      { id: 'live-status', kind: 'raw.status', sourceEventIds: ['status-1'], data: { state: 'running' } },
    ])
    const history = { ...userTurn('user-1'), rawStatus: 'complete', displayStatus: 'complete', blocks: [{ id: 'history-user', kind: 'user.message', sourceEventIds: ['user-1'], data: { text: 'hello' } }] }

    expect(reconcileTimelineTurns([live], [history])[0]!.blocks).toEqual([history.blocks[0], live.blocks[1], live.blocks[2]])
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
    expect(result.turns[0]!.blocks[0]!.data).toMatchObject({ text: 'hello', status: 'confirmed', primaryTimelineUserMessage: true })
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

  it('reattaches late tool results to the tool-use owner across primary boundaries', () => {
    const first = userTurn('user-1', [
      { id: 'user-1:user', kind: 'user.message', sourceEventIds: ['user-1'], data: { text: 'first', primaryTimelineUserMessage: true } },
      { id: 'assistant-1:tool', kind: 'assistant.tool_use', sourceEventIds: ['assistant-1'], toolUseId: 'call-1', data: { type: 'tool_use', id: 'call-1' } },
    ])
    const second = userTurn('user-2')
    const raw = { type: 'user', uuid: 'tool-result-1', session_id: 'session-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }] } }

    const result = applySdkMessage([first, second], raw, timelineTurnIndex([]), 'user-2', null)

    expect(result.turns[0]?.blocks.at(-1)).toMatchObject({ kind: 'tool.result', toolUseId: 'call-1' })
    expect(result.turns[1]?.blocks.some((block) => block.kind === 'tool.result')).toBe(false)
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

  it('identifies scheme A primary boundary user events', () => {
    expect(isPrimaryUserMessage({ type: 'user', message: { role: 'user', content: 'hello' } })).toBe(true)
    expect(isPrimaryUserMessage({ type: 'user', promptSource: 'typed', isMeta: true, message: { role: 'user', content: 'hello' } })).toBe(true)
    expect(isPrimaryUserMessage({ type: 'user', promptSource: 'sdk', origin: { kind: 'sdk' }, message: { role: 'user', content: 'hello' } })).toBe(true)
    expect(isPrimaryUserMessage({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'image' }] } })).toBe(true)
  })

  it('uses turn, api message, and block ids for identity but not provenance ids', () => {
    const first = userTurn('user-1', [
      { id: 'assistant-text', kind: 'assistant.text', sourceEventIds: ['same-event'], apiMessageId: 'msg-1', data: { text: 'text' } },
      { id: 'assistant-tool', kind: 'assistant.tool_use', sourceEventIds: ['same-event'], apiMessageId: 'msg-1', data: { name: 'Read' } },
    ])
    const second = userTurn('user-2', [{ id: 'stable-block', kind: 'system.message', sourceEventIds: ['same-event'], data: {} }])
    const index = timelineTurnIndex([first, second])

    expect(index).toEqual({ userMessageUuids: new Set(['user-1', 'user-2']), apiMessageIds: new Set(['msg-1']), blockIds: new Set(['assistant-text', 'assistant-tool', 'stable-block']) })
    expect(reconcileTimelineTurns([userTurn('other', [{ id: 'other-block', kind: 'system.message', sourceEventIds: ['same-event'], data: {} }])], [second])).toHaveLength(2)
  })

  it.each([
    ['tool result', { type: 'user', uuid: 'tool', session_id: 'session-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }] } }],
    ['task notification', { type: 'user', uuid: 'task', session_id: 'session-1', message: { role: 'user', content: '<task-notification><task-id>task-1</task-id><tool-use-id>call-1</tool-use-id><output-file>/tmp/task.output</output-file><status>completed</status><summary>Done</summary></task-notification>' } }],
    ['sidechain', { type: 'user', uuid: 'sidechain', session_id: 'session-1', isSidechain: true, message: { role: 'user', content: 'internal' } }],
    ['meta', { type: 'user', uuid: 'meta', session_id: 'session-1', isMeta: true, message: { role: 'user', content: 'internal' } }],
    ['task origin', { type: 'user', uuid: 'task-origin', session_id: 'session-1', promptSource: 'sdk', origin: { kind: 'task-notification' }, message: { role: 'user', content: 'internal' } }],
    ['peer origin', { type: 'user', uuid: 'peer', session_id: 'session-1', origin: { kind: 'peer' }, message: { role: 'user', content: 'internal' } }],
    ['parent tool', { type: 'user', uuid: 'parent-tool', session_id: 'session-1', parent_tool_use_id: 'call-1', message: { role: 'user', content: 'internal' } }],
    ['synthetic', { type: 'user', uuid: 'synthetic', session_id: 'session-1', message: { role: 'user', content: 'internal', isSynthetic: true } }],
    ['internal', { type: 'user', uuid: 'internal', session_id: 'session-1', message: { role: 'user', content: 'internal', origin: 'internal' } }],
    ['non-query', { type: 'user', uuid: 'non-query', session_id: 'session-1', message: { role: 'user', content: 'internal', shouldQuery: false } }],
    ['parent agent', { type: 'user', uuid: 'parent', session_id: 'session-1', parent_agent_id: 'agent-1', message: { role: 'user', content: 'internal' } }],
  ])('does not open a primary turn for %s messages', (_label, raw) => {
    const result = applySdkMessage([], raw, timelineTurnIndex([]), null, null, 10)

    expect(isPrimaryUserMessage(raw)).toBe(false)
    expect(result.currentUserMessageUuid).toBe(raw.uuid)
    expect(result.turns[0]?.id).toBe(raw.uuid)
  })

  it('attaches orphan tool results to session events and uses message-level parent tool id', () => {
    const raw = { type: 'user', uuid: 'tool-result', session_id: 'session-1', parent_tool_use_id: 'call-parent', message: { role: 'user', content: [{ type: 'tool_result', content: 'done' }] } }
    const result = applySdkMessage([], raw, timelineTurnIndex([]), null, null, 10)

    expect(result.turns[0]?.blocks[0]).toMatchObject({ kind: 'tool.result', toolUseId: 'call-parent' })
  })

  it.each(['status', 'unknown'])('keeps %s messages as raw session events', (type) => {
    const result = applySdkMessage([], { type, uuid: `${type}-1`, session_id: 'session-1', state: 'running' }, timelineTurnIndex([]), null, null, 10)

    expect(result.turns[0]).toMatchObject({ id: `${type}-1`, blocks: [{ kind: `raw.${type}`, id: `${type}-1:raw` }] })
  })

  it('aggregates leading response events into the first event frame', () => {
    const historyIndex = timelineTurnIndex([])
    const first = applySdkMessage([], { type: 'assistant', uuid: 'assistant-1', session_id: 'session-1', message: { id: 'message-1', content: [{ type: 'text', text: 'continued' }] } }, historyIndex, null, null, 10)
    const second = applySdkMessage(first.turns, { type: 'status', uuid: 'status-1', session_id: 'session-1', state: 'running' }, historyIndex, first.currentUserMessageUuid, null, 20)

    expect(second.currentUserMessageUuid).toBe('assistant-1')
    expect(second.turns).toHaveLength(1)
    expect(second.turns[0]).toMatchObject({ id: 'assistant-1' })
    expect(second.turns[0]?.blocks.map((block) => block.kind)).toEqual(['assistant.text', 'raw.status'])
  })

  it('marks the active turn complete on result without adding timeline content', () => {
    const live = userTurn('user-1')
    const raw = { type: 'result', subtype: 'success', is_error: false, errors: [] }

    const result = applySdkMessage([live], raw, timelineTurnIndex([]), 'user-1', null, 42)

    expect(result).toEqual({ turns: [{ ...live, rawStatus: 'complete', displayStatus: 'complete', completedAt: 42 }], currentUserMessageUuid: 'user-1', terminal: true })
  })

  it('keeps post-result events on the same frame until the next primary', () => {
    const historyIndex = timelineTurnIndex([])
    const completed = applySdkMessage([userTurn('user-1')], { type: 'result', subtype: 'success' }, historyIndex, 'user-1', null, 20)
    const trailing = applySdkMessage(completed.turns, { type: 'command_lifecycle', uuid: 'command-1', session_id: 'session-1' }, historyIndex, completed.currentUserMessageUuid, null, 30)
    const next = applySdkMessage(trailing.turns, { type: 'user', uuid: 'user-2', session_id: 'session-1', message: { role: 'user', content: 'next' } }, historyIndex, trailing.currentUserMessageUuid, null, 40)

    expect(trailing.currentUserMessageUuid).toBe('user-1')
    expect(trailing.turns[0]?.blocks.at(-1)).toMatchObject({ kind: 'raw.command_lifecycle' })
    expect(next.currentUserMessageUuid).toBe('user-2')
  })

  it('marks the active turn error on a failed result', () => {
    const live = userTurn('user-1')
    const raw = { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['SDK stream failed'] }

    const result = applySdkMessage([live], raw, timelineTurnIndex([]), 'user-1', null, 42)

    expect(result).toEqual({ turns: [{ ...live, rawStatus: 'error', displayStatus: 'error', completedAt: 42 }], currentUserMessageUuid: 'user-1', terminal: true })
  })

  it('replays persisted events in id order, merges history, and is idempotent', () => {
    const history = userTurn('user-1', [{ id: 'history-user', kind: 'user.message', sourceEventIds: ['user-1'], data: { text: 'hello' } }])
    const events: PersistedLiveEvent[] = [
      { id: 3, projectId: 'project-1', sessionId: 'session-1', eventType: 'result', source: 'sdk', recordedAtMs: 30, payload: { type: 'result', subtype: 'success' } },
      { id: 2, projectId: 'project-1', sessionId: 'session-1', eventType: 'status', source: 'sdk', recordedAtMs: 20, payload: { type: 'status', uuid: 'status-1', session_id: 'session-1', state: 'running' } },
      { id: 1, projectId: 'project-1', sessionId: 'session-1', eventType: 'user', source: 'sdk', recordedAtMs: 10, payload: { type: 'user', uuid: 'user-1', session_id: 'session-1', message: { role: 'user', content: 'hello' } } },
    ]

    const once = mergePersistedLiveEvents([history], events)
    const twice = mergePersistedLiveEvents(once, events)

    expect(once).toEqual(twice)
    const replayed = once.find((turn) => turn.id === 'user-1')
    expect(replayed).toMatchObject({ rawStatus: 'complete', displayStatus: 'complete', completedAt: 30 })
    expect(replayed?.blocks.filter((block) => block.kind === 'user.message')).toEqual(history.blocks)
    expect(replayed?.blocks.some((block) => block.kind === 'raw.status')).toBe(true)
  })

  it('replays persisted failed results as terminal errors', () => {
    const history = userTurn('user-1')
    const events: PersistedLiveEvent[] = [
      { id: 2, projectId: 'project-1', sessionId: 'session-1', eventType: 'result', source: 'sdk', recordedAtMs: 20, payload: { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['SDK stream failed'] } },
      { id: 1, projectId: 'project-1', sessionId: 'session-1', eventType: 'user', source: 'sdk', recordedAtMs: 10, payload: { type: 'user', uuid: 'user-1', session_id: 'session-1', message: { role: 'user', content: 'hello' } } },
    ]

    const once = mergePersistedLiveEvents([history], events)

    expect(mergePersistedLiveEvents(once, events)).toEqual(once)
    expect(once.find((turn) => turn.id === 'user-1')).toMatchObject({ rawStatus: 'error', displayStatus: 'error', completedAt: 20 })
  })
})
