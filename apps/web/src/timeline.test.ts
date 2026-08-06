import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PersistedLiveEvent, TimelineBlock, TurnSummary } from '@cotta/shared'
import { activeTimelineTurnId, applySdkMessage, AssistantResponseFrameSkeleton, assistantResponseFrameForkMessageId, belongsToTimelineSession, cliCookingLabel, cliCookingTurnId, CLI_COOKING_VERBS, groupAssistantResponseFrames, groupTimelineBlocks, isPrimaryUserMessage, LiveAssistantStreamAccumulator, LiveEventsTable, liveEventsForTurn, projectTimelineTurn, rawMessageWaterfallRows, RawMessagesDialog, reconcileTimelineTurns, SessionAwaySummary, SessionTaskList, shouldRefetchTimelineVersion, shouldResetSessionTimeline, shouldShowAssistantResponseSkeleton, TimelineBlockView, timelineTurnIndex, turnDurationLabel, turnFooterState } from './timeline'

describe('session task list', () => {
  it('hides empty lists and shows task statuses without active form', () => {
    expect(renderToStaticMarkup(createElement(SessionTaskList, { tasks: [] }))).toBe('')
    const html = renderToStaticMarkup(createElement(SessionTaskList, { tasks: [
      { key: 'one', taskId: '1', subject: 'Inspect history', activeForm: 'Inspecting history', status: 'in_progress', blockedBy: ['6'] },
      { key: 'two', taskId: '2', subject: 'Write summary', status: 'completed', blockedBy: [] },
    ] }))

    expect(html).not.toContain('Inspecting history')
    expect(html).toContain('Inspect history')
    expect(html).toContain('aria-label="In progress"')
    expect(html).toContain('aria-label="Completed"')
    expect(html).toContain('› blocked by #6')
    expect(html).not.toContain('session-task-label')
  })
})

function userMessage(id: string, text = id): unknown {
  return { type: 'user', uuid: id, timestamp: '1970-01-01T00:00:00.001Z', message: { role: 'user', content: text } }
}

function messageFromBlock(block: TimelineBlock): unknown {
  const uuid = block.sourceEventIds[0] ?? block.id
  if (block.kind === 'user.message') return userMessage(uuid, typeof block.data === 'object' && block.data !== null && 'text' in block.data ? String(block.data.text) : uuid)
  if (block.kind === 'tool.result') return { type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: block.toolUseId, ...(typeof block.data === 'object' && block.data !== null ? block.data : {}) }] } }
  if (block.kind.startsWith('assistant.')) return { type: 'assistant', uuid, message: { id: block.apiMessageId ?? `msg:${uuid}`, role: 'assistant', content: [{ type: block.kind.slice('assistant.'.length), ...(typeof block.data === 'object' && block.data !== null ? block.data : {}) }] } }
  return { type: block.kind.replace(/^raw\./, ''), uuid, ...(typeof block.data === 'object' && block.data !== null ? block.data : {}) }
}

function userTurn(id: string, blocks: TimelineBlock[] = []): TurnSummary {
  return {
    primaryUserUuid: id,
    primaryUserTimestampMs: 1,
    messages: blocks.length > 0 ? blocks.map(messageFromBlock) : [userMessage(id)],
  }
}

function projected(turn: TurnSummary): TimelineBlock[] {
  return projectTimelineTurn(turn)
}

describe('away summary recap', () => {
  it('renders recap markdown', () => {
    const html = renderToStaticMarkup(createElement(SessionAwaySummary, { value: '**While away:** done' }))

    expect(html).toContain('aria-label="Away recap"')
    expect(html).toContain('Recap')
    expect(html).toContain('<strong>While away:</strong>')
    expect(html).toContain('session-away-summary')
  })
})

describe('assistant response skeleton', () => {
  it('uses the response frame shape while a primary-only turn is cooking', () => {
    const html = renderToStaticMarkup(createElement(AssistantResponseFrameSkeleton, { activeLabel: 'Cooking...' }))

    expect(html).toContain('assistant-response')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('timeline-skeleton-line')
    expect(html).toContain('Cooking...')
  })

  it('shows pending background agents on primary-only skeletons before cooking', () => {
    const html = renderToStaticMarkup(createElement(AssistantResponseFrameSkeleton, { activeLabel: 'Writing tests...', footerState: { kind: 'waiting', label: 'Waiting for 2 background agents to finish' } }))

    expect(html).toContain('Waiting for 2 background agents to finish')
    expect(html).not.toContain('Writing tests...')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
  })

  it('keeps Claude Code cooking verb spelling', () => {
    expect(CLI_COOKING_VERBS).toContain('Dilly-dallying')
    expect(CLI_COOKING_VERBS).toContain('Flambéing')
    expect(CLI_COOKING_VERBS).toContain('Sautéing')
    expect(CLI_COOKING_VERBS).toContain('Sock-hopping')
    expect(cliCookingLabel('turn-1')).toMatch(/…$/)
  })
})

describe('timeline version refresh', () => {
  it('refetches only idle mismatched timeline versions', () => {
    expect(shouldRefetchTimelineVersion({ appliedVersion: 'v1', observedVersion: 'v2', live: false, fetching: false })).toBe(true)
    expect(shouldRefetchTimelineVersion({ appliedVersion: 'v1', observedVersion: 'v2', live: true, fetching: false })).toBe(false)
    expect(shouldRefetchTimelineVersion({ appliedVersion: 'v1', observedVersion: 'v1', live: false, fetching: false })).toBe(false)
    expect(shouldRefetchTimelineVersion({ appliedVersion: null, observedVersion: 'v2', live: false, fetching: false })).toBe(false)
    expect(shouldRefetchTimelineVersion({ appliedVersion: 'v1', observedVersion: 'v2', live: false, fetching: true })).toBe(false)
  })
})

describe('timeline scope reset', () => {
  it('accepts timeline writes only for the selected session', () => {
    expect(belongsToTimelineSession('session-1', 'session-1')).toBe(true)
    expect(belongsToTimelineSession('session-2', 'session-1')).toBe(false)
    expect(belongsToTimelineSession(null, 'session-1')).toBe(false)
  })

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

  it('renders the raw-message action for a live turn', () => {
    const html = renderToStaticMarkup(createElement(TimelineBlockView, {
      block: projected(userTurn('turn-1'))[0],
      timestamp: 1,
      source: 'live',
      onViewRaw: () => {},
    }))

    expect(html).toContain('aria-label="View raw user message"')
    expect(html).toContain('>live</span>')
  })

  it('defers user message payloads until the card is expanded', () => {
    const html = renderToStaticMarkup(createElement(TimelineBlockView, {
      block: {
        id: 'internal:user_message',
        kind: 'assistant.user_message',
        sourceEventIds: ['internal'],
        data: { privateMarker: 'deferred-payload' },
      },
    }))

    expect(html).toContain('<details')
    expect(html).toContain('<summary')
    expect(html).toContain('User message')
    expect(html).not.toContain('Payload')
    expect(html).not.toContain('deferred-payload')
  })

  it('renders thinking cards through the shared disclosure shell', () => {
    const html = renderToStaticMarkup(createElement(TimelineBlockView, {
      block: { id: 'thinking', kind: 'assistant.thinking', sourceEventIds: ['assistant'], data: { thinking: 'Consider the edge case' } },
    }))

    expect(html).toContain('aria-label="Assistant thinking"')
    expect(html).toContain('<summary')
    expect(html).toContain('Thinking')
    expect(html).toContain('Consider the edge case')
  })

  it('renders task notification completions with the original tool input and latest result', () => {
    const html = renderToStaticMarkup(createElement(TimelineBlockView, {
      block: {
        id: 'task-1:task_notification',
        kind: 'assistant.task_notification',
        sourceEventIds: ['task-1'],
        data: {
          taskId: 'task-1',
          toolUseId: 'call-agent',
          status: 'completed',
          summary: 'Agent finished',
          result: 'Final answer',
          originalToolUse: { id: 'call-agent', name: 'Agent', input: { prompt: 'Investigate this' } },
        },
      },
    }))

    expect(html).toContain('Agent completed')
    expect(html).toContain('Input')
    expect(html).toContain('Investigate this')
    expect(html).toContain('Result')
    expect(html).toContain('Final answer')
    expect(html).not.toContain('Task ID')
    expect(html).not.toContain('Tool use ID')
    expect(html).not.toContain('Output file')
  })

  it('renders result-only task notification cards without input', () => {
    const html = renderToStaticMarkup(createElement(TimelineBlockView, {
      block: {
        id: 'task-1:task_notification',
        kind: 'assistant.task_notification',
        sourceEventIds: ['task-1'],
        data: {
          taskId: 'task-1',
          status: 'stopped',
          summary: 'Agent stopped',
          result: 'Partial answer',
        },
      },
    }))

    expect(html).toContain('Task Notification')
    expect(html).not.toContain('Input')
    expect(html).toContain('Result')
    expect(html).toContain('Partial answer')
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

  it('drops leading response events until the first primary', () => {
    const events = [
      event(1, { type: 'assistant', uuid: 'leading-assistant', message: { content: [{ type: 'text', text: 'continued' }] } }, 'assistant'),
      event(2, { type: 'status', uuid: 'leading-status', state: 'running' }, 'status'),
      event(3, user('turn-1'), 'user'),
    ]

    expect(liveEventsForTurn(events, 'leading-assistant')).toEqual([])
    expect(liveEventsForTurn(events, 'turn-1').map(({ id }) => id)).toEqual([3])
  })

  it('routes late tool results and task notifications to the tool-use owner across primary boundaries', () => {
    const events = [
      event(1, user('turn-1'), 'user'),
      event(2, { type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: {} }] } }, 'assistant'),
      event(3, user('turn-2'), 'user'),
      event(4, { type: 'user', uuid: 'result-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }] } }, 'user'),
      event(5, { type: 'user', uuid: 'task-1', message: { role: 'user', content: '<task-notification><task-id>task-1</task-id><tool-use-id>call-1</tool-use-id></task-notification>' } }, 'user'),
    ]

    expect(liveEventsForTurn(events, 'turn-1').map(({ id }) => id)).toEqual([1, 2, 4, 5])
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

  it('drops scalar payloads before the first primary', () => {
    const events = [
      event(1, 'unscoped scalar', 'unknown'),
      event(2, { type: 'assistant', uuid: 'leading-assistant', message: { content: [] } }, 'assistant'),
      event(3, 'scoped scalar', 'unknown'),
      event(4, user('turn-1'), 'user'),
    ]

    expect(liveEventsForTurn(events, 'leading-assistant')).toEqual([])
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
  it('renders streaming assistant text without the trailing dot animation', () => {
    const block: TimelineBlock = { id: 'assistant-1', kind: 'assistant.text', sourceEventIds: ['stream-1'], data: { type: 'text', text: 'hello', streaming: true } }
    const html = renderToStaticMarkup(createElement(TimelineBlockView, { block }))

    expect(html).toContain('hello')
    expect(html).not.toContain('loading-dots')
    expect(html).not.toContain('Assistant is streaming')
  })

  it('formats stable Claude Code-style turn duration labels', () => {
    expect(turnDurationLabel({ primaryUserUuid: 'turn-1', durationMs: 21_000 })).toMatch(/^(Thought|Baked|Brewed|Churned|Cogitated|Cooked|Crunched|Sauted|Worked) for 21s$/)
    expect(turnDurationLabel({ primaryUserUuid: 'turn-1', durationMs: 415_000 })).toBe(`${turnDurationLabel({ primaryUserUuid: 'turn-1', durationMs: 21_000 })?.split(' for ')[0]} for 6m 55s`)
    expect(turnDurationLabel({ primaryUserUuid: 'turn-1', durationMs: 21_000, pendingBackgroundAgentCount: 1 })).toBe('Waiting for 1 background agent to finish')
    expect(turnDurationLabel({ primaryUserUuid: 'turn-1', durationMs: 21_000, pendingBackgroundAgentCount: 2 })).toBe('Waiting for 2 background agents to finish')
    expect(turnDurationLabel({ primaryUserUuid: 'turn-1', durationMs: 21_000, pendingBackgroundAgentCount: 0 })).toMatch(/ for 21s$/)
    expect(turnDurationLabel({ primaryUserUuid: 'turn-1' })).toBeNull()
  })

  it('prioritizes pending agents before cooking and cooked duration', () => {
    expect(turnFooterState({ turn: { primaryUserUuid: 'turn-1', durationMs: 21_000, pendingBackgroundAgentCount: 2 }, cooking: true, activeLabel: 'Writing tests...' })).toEqual({ kind: 'waiting', label: 'Waiting for 2 background agents to finish' })
    expect(turnFooterState({ turn: { primaryUserUuid: 'turn-1' }, cooking: true, activeLabel: 'Writing tests...' })).toEqual({ kind: 'cooking', label: 'Writing tests...' })
    expect(turnFooterState({ turn: { primaryUserUuid: 'turn-1' }, cooking: true })).toEqual({ kind: 'cooking', label: undefined })
    expect(turnFooterState({ turn: { primaryUserUuid: 'turn-1', durationMs: 21_000 }, cooking: false })?.kind).toBe('duration')
  })

  it('selects the latest unfinished primary turn for active CLI phases', () => {
    const turns = [userTurn('turn-1'), userTurn('turn-2')]
    for (const phase of ['cli_busy', 'cli_shell', 'cli_waiting'] as const) {
      expect(cliCookingTurnId(turns, { phase, activeUserMessageUuid: null })).toBe('turn-2')
    }
    expect(cliCookingTurnId(turns, { phase: 'idle', activeUserMessageUuid: null })).toBeNull()
    expect(cliCookingTurnId(turns, { phase: 'running', activeUserMessageUuid: 'turn-2', lastTurn: null })).toBeNull()
    expect(cliCookingTurnId([{ ...turns[1]!, durationMs: 1000 }], { phase: 'cli_busy', activeUserMessageUuid: null })).toBeNull()
    expect(cliCookingTurnId([userTurn('turn-2', [{ id: 'assistant-only', kind: 'assistant.text', sourceEventIds: ['assistant'], data: { text: 'hello' } }])], { phase: 'cli_busy', activeUserMessageUuid: null })).toBeNull()
    expect(cliCookingTurnId([], { phase: 'cli_busy', activeUserMessageUuid: null })).toBeNull()
  })

  it('selects only the active turn for task progress text', () => {
    const turns = [userTurn('turn-1'), userTurn('turn-2')]
    expect(activeTimelineTurnId(turns, { phase: 'running', activeUserMessageUuid: 'turn-2', lastTurn: null })).toBe('turn-2')
    expect(activeTimelineTurnId(turns, { phase: 'requires_action', activeUserMessageUuid: 'turn-2', lastTurn: null })).toBe('turn-2')
    expect(activeTimelineTurnId(turns, { phase: 'cli_busy', activeUserMessageUuid: null })).toBe('turn-2')
    expect(activeTimelineTurnId(turns, { phase: 'idle', activeUserMessageUuid: null })).toBeNull()
    expect(activeTimelineTurnId(turns, { phase: 'running', activeUserMessageUuid: 'missing', lastTurn: null })).toBeNull()
  })

  it('keeps the assistant skeleton until a just-finished response frame arrives', () => {
    const turn = userTurn('turn-1')
    expect(shouldShowAssistantResponseSkeleton({ turn, cooking: true, runState: { phase: 'cli_busy', activeUserMessageUuid: null } })).toBe(true)
    expect(shouldShowAssistantResponseSkeleton({ turn, cooking: true, lastAssistantFrameId: 'frame-1', runState: { phase: 'cli_busy', activeUserMessageUuid: null } })).toBe(false)
    expect(shouldShowAssistantResponseSkeleton({ turn, cooking: false, runState: { phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'turn-1', outcome: 'success' } } })).toBe(true)
    expect(shouldShowAssistantResponseSkeleton({ turn, cooking: false, fallbackTurnId: 'turn-1', runState: { phase: 'idle', activeUserMessageUuid: null } })).toBe(true)
    expect(shouldShowAssistantResponseSkeleton({ turn, cooking: false, runState: { phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'turn-1', outcome: 'error' } } })).toBe(false)
    expect(shouldShowAssistantResponseSkeleton({ turn: { ...turn, durationMs: 1000 }, cooking: false, runState: { phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'turn-1', outcome: 'success' } } })).toBe(false)
  })

  it('hides Task management tool cards without leaving empty response frames', () => {
    const taskOnly = groupAssistantResponseFrames(groupTimelineBlocks([
      { id: 'task-create', kind: 'assistant.tool_use', sourceEventIds: ['assistant'], toolUseId: 'call-task', data: { name: 'TaskCreate', input: { subject: 'Task' } } },
      { id: 'task-result', kind: 'tool.result', sourceEventIds: ['result'], toolUseId: 'call-task', data: { content: 'Task #1 created successfully' } },
    ]))
    const mixed = groupAssistantResponseFrames(groupTimelineBlocks([
      { id: 'assistant:text', kind: 'assistant.text', sourceEventIds: ['assistant'], data: { text: 'Working' } },
      { id: 'task-update', kind: 'assistant.tool_use', sourceEventIds: ['assistant'], toolUseId: 'call-update', data: { name: 'TaskUpdate', input: { taskId: '1' } } },
      { id: 'task-update-result', kind: 'tool.result', sourceEventIds: ['result'], toolUseId: 'call-update', data: { content: 'Updated' } },
    ]))

    expect(taskOnly).toEqual([])
    expect(mixed).toHaveLength(1)
    expect(mixed[0]).toMatchObject({ type: 'assistant-response-frame', items: [{ type: 'block', block: { id: 'assistant:text' } }] })
  })

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

  it('uses the last response frame source event as fork target', () => {
    const display = groupAssistantResponseFrames(groupTimelineBlocks([
      { id: 'primary:user', kind: 'user.message', sourceEventIds: ['primary'], data: { text: 'prompt', primaryTimelineUserMessage: true } },
      { id: 'assistant:text', kind: 'assistant.text', sourceEventIds: ['assistant'], data: { text: 'answer' } },
      { id: 'tool:result', kind: 'tool.result', toolUseId: 'tool-1', sourceEventIds: ['result-1', 'result-2'], data: { content: 'done' } },
    ]))
    const frame = display.find((item) => item.type === 'assistant-response-frame')

    expect(frame?.type === 'assistant-response-frame' ? assistantResponseFrameForkMessageId(frame) : null).toBe('result-2')
  })
})

describe('timeline raw-message protocol', () => {
  it('projects history and live messages through one block pipeline', () => {
    const turn: TurnSummary = {
      primaryUserUuid: 'user-1',
      primaryUserTimestampMs: 1,
      messages: [
        userMessage('user-1', 'hello'),
        { type: 'stream_event', uuid: 'start', event: { type: 'message_start', message: { id: 'msg-1' } } },
        { type: 'stream_event', uuid: 'block', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'draft' } } },
        { type: 'assistant', uuid: 'assistant-1', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'final' }] } },
      ],
    }

    expect(projectTimelineTurn(turn)).toEqual([
      expect.objectContaining({ kind: 'user.message', data: expect.objectContaining({ text: 'hello', primaryTimelineUserMessage: true }) }),
      expect.objectContaining({ kind: 'assistant.text', apiMessageId: 'msg-1', sourceEventIds: ['assistant-1'], data: expect.objectContaining({ text: 'final' }) }),
    ])
  })

  it('keeps separate assistant records that share an API message id', () => {
    const turn: TurnSummary = {
      primaryUserUuid: 'user-1',
      messages: [
        userMessage('user-1', 'hello'),
        { type: 'assistant', uuid: 'assistant-text', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'Need mark task complete.' }] } },
        { type: 'assistant', uuid: 'assistant-tool', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'TaskUpdate', input: { taskId: '5' } }] } },
      ],
    }

    expect(projectTimelineTurn(turn)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'assistant.text', sourceEventIds: ['assistant-text'], data: expect.objectContaining({ text: 'Need mark task complete.' }) }),
      expect.objectContaining({ kind: 'assistant.tool_use', sourceEventIds: ['assistant-tool'], toolUseId: 'call-1' }),
    ]))
  })

  it('stores SDK messages canonically and confirms a pending raw user message', () => {
    const pending = userTurn('user-1')
    const raw = { type: 'user', uuid: 'user-1', session_id: 'session-1', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hello' } }

    const result = applySdkMessage([pending], raw, timelineTurnIndex([]), 'user-1', null)

    expect(result.turns).toHaveLength(1)
    expect(result.turns[0]?.messages).toEqual([raw])
    expect(projectTimelineTurn(result.turns[0]!)[0]?.data).toMatchObject({ text: 'hello', primaryTimelineUserMessage: true })
  })

  it('treats Cotta live failures as terminal control events without rendering them', () => {
    const turn = userTurn('user-1')
    const failure = { type: 'cotta_live_turn_failed', error: 'boom', session_id: 'session-1' }

    const result = applySdkMessage([turn], failure, timelineTurnIndex([]), 'user-1', null)

    expect(result.terminal).toBe(true)
    expect(result.turns).toEqual([turn])
    expect(projectTimelineTurn({ ...turn, messages: [...turn.messages, failure] })).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'raw.cotta_live_turn_failed' }),
    ]))
  })

  it('keeps SDK result messages as terminal events', () => {
    const turn = userTurn('user-1')
    const success = applySdkMessage([turn], { type: 'result', subtype: 'success' }, timelineTurnIndex([]), 'user-1', null)
    const failure = applySdkMessage([turn], { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] }, timelineTurnIndex([]), 'user-1', null)

    expect(success.terminal).toBe(true)
    expect(failure.terminal).toBe(true)
  })

  it('stales live-only messages before the newest history turn', () => {
    const firstUser = userMessage('user-1', 'first')
    const staleUser = userMessage('stale-user')
    const staleAssistant = { type: 'assistant', uuid: 'stale-assistant', message: { id: 'stale-msg', role: 'assistant', content: [{ type: 'text', text: 'stale' }] } }
    const secondUser = userMessage('user-2', 'second')
    const liveAssistant = { type: 'assistant', uuid: 'live-assistant', message: { id: 'live-msg', role: 'assistant', content: [{ type: 'text', text: 'live' }] } }
    const current: TurnSummary[] = [
      { primaryUserUuid: 'user-1', primaryUserTimestampMs: 1, messages: [firstUser, staleUser, staleAssistant] },
      { primaryUserUuid: 'user-2', primaryUserTimestampMs: 2, messages: [secondUser, liveAssistant] },
    ]
    const history: TurnSummary[] = [
      { primaryUserUuid: 'user-1', primaryUserTimestampMs: 1, durationMs: 10, messages: [firstUser] },
      { primaryUserUuid: 'user-2', primaryUserTimestampMs: 2, messages: [secondUser] },
    ]

    const merged = reconcileTimelineTurns(current, history)

    expect(merged[0]).toMatchObject({ durationMs: 10, messages: [firstUser] })
    expect(merged[1]?.messages).toEqual([secondUser, liveAssistant])
  })

  it('stales live turns inside the history page before the watermark', () => {
    const current: TurnSummary[] = [
      { primaryUserUuid: 'older-page', primaryUserTimestampMs: 5, messages: [] },
      { primaryUserUuid: 'stale-live', primaryUserTimestampMs: 15, messages: [] },
      { primaryUserUuid: 'equal-live', primaryUserTimestampMs: 20, messages: [] },
      { primaryUserUuid: 'newer-live', primaryUserTimestampMs: 25, messages: [] },
    ]
    const history: TurnSummary[] = [
      { primaryUserUuid: 'history-1', primaryUserTimestampMs: 10, messages: [] },
      { primaryUserUuid: 'history-2', primaryUserTimestampMs: 20, messages: [] },
    ]

    expect(reconcileTimelineTurns(current, history).map((turn) => turn.primaryUserUuid)).toEqual([
      'older-page',
      'history-1',
      'history-2',
      'equal-live',
      'newer-live',
    ])
  })

  it('keeps unorderable live data when the history watermark has no timestamp', () => {
    const historyUser = userMessage('user-2')
    const liveAssistant = { type: 'assistant', uuid: 'live-assistant', message: { id: 'live-msg', role: 'assistant', content: [] } }
    const current: TurnSummary[] = [
      { primaryUserUuid: 'unknown-live', messages: [] },
      { primaryUserUuid: 'user-2', messages: [historyUser, liveAssistant] },
    ]
    const history: TurnSummary[] = [{ primaryUserUuid: 'user-2', messages: [historyUser] }]

    const merged = reconcileTimelineTurns(current, history)

    expect(merged[0]?.messages).toEqual([historyUser, liveAssistant])
    expect(merged[1]?.primaryUserUuid).toBe('unknown-live')
  })

  it('routes late tool results and task notifications to the tool-use owner turn', () => {
    const toolUse = { type: 'assistant', uuid: 'assistant-1', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Agent', input: { prompt: 'Investigate' } }] } }
    let turns: TurnSummary[] = [
      { primaryUserUuid: 'user-1', messages: [userMessage('user-1'), toolUse] },
      { primaryUserUuid: 'user-2', messages: [userMessage('user-2')] },
    ]
    const result = { type: 'user', uuid: 'result-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }] } }
    const notification = { type: 'user', uuid: 'task-1', message: { role: 'user', content: '<task-notification><task-id>task-1</task-id><tool-use-id>call-1</tool-use-id><status>completed</status><result>done</result></task-notification>' } }

    turns = applySdkMessage(turns, result, timelineTurnIndex([]), 'user-2', null).turns
    turns = applySdkMessage(turns, notification, timelineTurnIndex([]), 'user-2', null).turns

    expect(projectTimelineTurn(turns[0]!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool.result', toolUseId: 'call-1' }),
      expect.objectContaining({ kind: 'assistant.task_notification', data: expect.objectContaining({ originalToolUse: { id: 'call-1', name: 'Agent', input: { prompt: 'Investigate' } } }) }),
    ]))
    expect(turns[1]?.messages).toHaveLength(1)
  })

  it('preserves live stream drafts until the final assistant message replaces them', () => {
    let turns = [userTurn('user-1')]
    const index = timelineTurnIndex([])
    turns = applySdkMessage(turns, { type: 'stream_event', uuid: 'start', event: { type: 'message_start', message: { id: 'msg-1' } } }, index, 'user-1', null).turns
    turns = applySdkMessage(turns, { type: 'stream_event', uuid: 'block', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'draft' } } }, index, 'user-1', null).turns
    expect(projectTimelineTurn(turns[0]!)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'assistant.text', data: expect.objectContaining({ text: 'draft', streaming: true }) })]))

    turns = applySdkMessage(turns, { type: 'assistant', uuid: 'assistant-1', message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'final' }] } }, index, 'user-1', null).turns
    const assistantBlocks = projectTimelineTurn(turns[0]!).filter((block) => block.kind === 'assistant.text')
    expect(assistantBlocks).toHaveLength(1)
    expect(assistantBlocks[0]?.data).toMatchObject({ text: 'final' })
  })

  it('indexes canonical message identities rather than projected blocks', () => {
    const turn: TurnSummary = { primaryUserUuid: 'user-1', messages: [userMessage('user-1'), { type: 'assistant', uuid: 'assistant-1', message: { id: 'msg-1', content: [] } }] }
    expect(timelineTurnIndex([turn])).toEqual({
      primaryUserUuids: new Set(['user-1']),
      messageIds: new Set(['uuid:user-1', 'uuid:assistant-1']),
      finalizedApiMessageIds: new Set(['msg-1']),
    })
  })
})
