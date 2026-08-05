import { describe, expect, it } from 'vitest'
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { projectSessionTimeline, sessionMessagesForTurn } from './timeline-projection.js'

type TimestampedSessionMessage = SessionMessage & { timestamp?: string }

const messages: TimestampedSessionMessage[] = [
  {
    type: 'user',
    uuid: 'user-1',
    session_id: 'session-1',
    parent_tool_use_id: null,
    parent_agent_id: null,
    timestamp: '2026-07-14T08:00:00.000Z',
    message: { role: 'user', content: 'First prompt' },
  },
  {
    type: 'assistant',
    uuid: 'assistant-1',
    session_id: 'session-1',
    parent_tool_use_id: null,
    parent_agent_id: null,
    timestamp: '2026-07-14T08:00:10.000Z',
    message: {
      id: 'msg_assistant_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'First answer' }],
    },
  },
  {
    type: 'user',
    uuid: 'user-2',
    session_id: 'session-1',
    parent_tool_use_id: null,
    parent_agent_id: null,
    timestamp: '2026-07-14T08:01:00.000Z',
    message: { role: 'user', content: 'Second prompt' },
  },
  {
    type: 'assistant',
    uuid: 'assistant-2',
    session_id: 'session-1',
    parent_tool_use_id: null,
    parent_agent_id: null,
    timestamp: '2026-07-14T08:01:15.000Z',
    message: {
      id: 'msg_assistant_2',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Checking the file' },
        { type: 'tool_use', id: 'toolu_123', name: 'Read', input: { file_path: '/tmp/example.ts' } },
      ],
    },
  },
  {
    type: 'user',
    uuid: 'task-notification-1',
    session_id: 'session-1',
    parent_tool_use_id: null,
    parent_agent_id: null,
    promptSource: 'sdk',
    origin: { kind: 'task-notification' },
    timestamp: '2026-07-14T08:01:20.000Z',
    message: {
      role: 'user',
      content: '<task-notification>\n<task-id>task_123</task-id>\n<tool-use-id>call_123</tool-use-id>\n<output-file>/tmp/task.output</output-file>\n<status>completed</status>\n<summary>Agent finished</summary>\n<result>Done</result>\n</task-notification>',
    },
  } as unknown as TimestampedSessionMessage,
  {
    type: 'user',
    uuid: 'tool-result-1',
    session_id: 'session-1',
    parent_tool_use_id: 'toolu_123',
    parent_agent_id: null,
    timestamp: '2026-07-14T08:01:30.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_123', content: 'file contents' }],
    },
  },
]

describe('sessionMessagesForTurn', () => {
  it('returns the requested primary turn without crossing into the next turn', () => {
    expect(sessionMessagesForTurn(messages, 'user-1')?.map((message) => message.uuid)).toEqual(['user-1', 'assistant-1'])
    expect(sessionMessagesForTurn(messages, 'user-2')?.map((message) => message.uuid)).toEqual(['user-2', 'assistant-2', 'task-notification-1', 'tool-result-1'])
  })

  it('excludes non-message events from the selected turn', () => {
    const attachment = {
      type: 'attachment',
      uuid: 'attachment-1',
      session_id: 'session-1',
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: { role: 'system', content: 'listing' },
    } as unknown as TimestampedSessionMessage

    expect(sessionMessagesForTurn([messages[0]!, attachment, messages[1]!], 'user-1')?.map((message) => message.uuid)).toEqual(['user-1', 'assistant-1'])
  })

  it('reattaches a late tool result to the turn that started the tool call', () => {
    const lateResult = {
      ...messages[5]!,
      uuid: 'late-result',
    }
    const sequence = [messages[0]!, messages[3]!, messages[2]!, lateResult]

    expect(sessionMessagesForTurn(sequence, 'user-1')?.map((message) => message.uuid)).toEqual(['user-1', 'assistant-2', 'late-result'])
    expect(sessionMessagesForTurn(sequence, 'user-2')?.map((message) => message.uuid)).toEqual(['user-2'])
  })

  it('rejects unknown and non-frame message ids', () => {
    expect(sessionMessagesForTurn(messages, 'missing')).toBeNull()
    expect(sessionMessagesForTurn(messages, 'assistant-1')).toBeNull()
  })

  it('drops messages before the first primary user', () => {
    const sequence = [messages[1]!, messages[0]!]

    expect(sessionMessagesForTurn(sequence, 'assistant-1')).toBeNull()
    expect(sessionMessagesForTurn(sequence, 'user-1')?.map((message) => message.uuid)).toEqual(['user-1'])
  })
})

describe('projectSessionTimeline', () => {
  it('projects chronological session messages into turn blocks', () => {
    const timeline = projectSessionTimeline('session-1', messages, { limitTurns: 10, cursor: null })

    expect(timeline.turns.map((turn) => turn.primaryUserUuid)).toEqual(['user-1', 'user-2'])
    expect(timeline.turns[0]?.messages).toEqual(messages.slice(0, 2))
    expect(timeline.turns[1]?.messages).toEqual(messages.slice(2))
  })

  it('projects image user content with stable live-compatible ids', () => {
    const timeline = projectSessionTimeline('session-1', [{
      type: 'user',
      uuid: 'image-user',
      session_id: 'session-1',
      parent_tool_use_id: null,
      parent_agent_id: null,
      timestamp: '2026-07-14T08:00:00.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
        ],
      },
    } as TimestampedSessionMessage], { limitTurns: 10, cursor: null })

    expect(timeline.turns[0]).toEqual({
      primaryUserUuid: 'image-user',
      primaryUserTimestampMs: Date.parse('2026-07-14T08:00:00.000Z'),
      messages: [expect.objectContaining({ uuid: 'image-user' })],
    })
  })

  it('does not project a leading response-only frame', () => {
    const timeline = projectSessionTimeline('session-1', [messages[1]!, messages[0]!], { limitTurns: 10, cursor: null })

    expect(timeline.turns.map((turn) => turn.primaryUserUuid)).toEqual(['user-1'])
    expect(timeline.turns[0]?.messages.map((message) => (message as { uuid?: string }).uuid)).toEqual(['user-1'])
  })

  it.each<[string, Record<string, unknown>, string | null, Record<string, unknown>?]>([
    ['internal', { origin: 'internal' }, null],
    ['synthetic', {}, null, { isSynthetic: true }],
    ['non-query', {}, null, { shouldQuery: false }],
    ['meta', {}, null, { isMeta: true }],
    ['sidechain', {}, null, { isSidechain: true }],
    ['peer', {}, null, { origin: { kind: 'peer' } }],
    ['task notification origin', {}, null, { origin: { kind: 'task-notification' }, promptSource: 'sdk' }],
  ])('does not start a new turn for %s user messages', (_, metadata, parentAgentId, entryMetadata = {}) => {
    const timeline = projectSessionTimeline('session-1', [
      messages[0]!,
      {
        type: 'user',
        uuid: 'filtered-user',
        session_id: 'session-1',
        parent_tool_use_id: null,
        parent_agent_id: parentAgentId,
        timestamp: '2026-07-14T08:00:05.000Z',
        ...entryMetadata,
        message: { role: 'user', content: 'Internal note', ...metadata },
      } as TimestampedSessionMessage,
    ], { limitTurns: 10, cursor: null })

    expect(timeline.turns.map((turn) => turn.primaryUserUuid)).toEqual(['user-1'])
    if ('isSynthetic' in entryMetadata) expect(timeline.turns[0]?.messages.map((message) => (message as { uuid?: string }).uuid)).toEqual(['user-1'])
    else expect(timeline.turns[0]?.messages.at(-1)).toMatchObject({ uuid: 'filtered-user' })
  })

  it('ignores a leading synthetic user message without creating a session-events turn', () => {
    const synthetic = {
      type: 'user',
      uuid: 'synthetic',
      session_id: 'session-1',
      isSynthetic: true,
      message: { role: 'user', content: 'Internal note' },
    } as unknown as TimestampedSessionMessage

    expect(projectSessionTimeline('session-1', [synthetic], { limitTurns: 10, cursor: null }).turns).toEqual([])
  })

  it.each([
    ['parent ids', { parent_tool_use_id: 'call-1', parent_agent_id: 'agent-1' }, { role: 'user', content: 'Nested reply' }],
    ['nested flags', {}, { role: 'user', content: 'Nested reply', isSynthetic: true, shouldQuery: false }],
    ['incomplete task wrapper', {}, { role: 'user', content: '<task-notification><summary>Looks like one</summary></task-notification>' }],
  ])('starts a new turn for %s when the scheme A predicate matches', (_, entryMetadata, message) => {
    const timeline = projectSessionTimeline('session-1', [messages[0]!, {
      type: 'user',
      uuid: 'scheme-a-user',
      session_id: 'session-1',
      timestamp: '2026-07-14T08:00:05.000Z',
      ...entryMetadata,
      message,
    } as unknown as TimestampedSessionMessage], { limitTurns: 10, cursor: null })

    expect(timeline.turns.map((turn) => turn.primaryUserUuid)).toEqual(['user-1', 'scheme-a-user'])
  })

  it('keeps complete task notifications on the tool call turn', () => {
    const agentCall = {
      type: 'assistant',
      uuid: 'agent-call',
      session_id: 'session-1',
      timestamp: '2026-07-14T08:00:05.000Z',
      message: { id: 'msg-agent', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'call-agent', name: 'Agent', input: { prompt: 'Investigate' } }] },
    } as unknown as TimestampedSessionMessage
    const notification = {
      type: 'user',
      uuid: 'agent-done',
      session_id: 'session-1',
      timestamp: '2026-07-14T08:00:10.000Z',
      message: { role: 'user', content: '<task-notification><task-id>task-1</task-id><tool-use-id>call-agent</tool-use-id></task-notification>' },
    } as unknown as TimestampedSessionMessage
    const timeline = projectSessionTimeline('session-1', [messages[0]!, agentCall, notification], { limitTurns: 10, cursor: null })

    expect(timeline.turns.map((turn) => turn.primaryUserUuid)).toEqual(['user-1'])
    expect(timeline.turns[0]?.messages.map((message) => (message as { uuid?: string }).uuid)).toEqual(['user-1', 'agent-call', 'agent-done'])
    expect(sessionMessagesForTurn([messages[0]!, agentCall, notification], 'user-1')?.map((message) => message.uuid)).toEqual(['user-1', 'agent-call', 'agent-done'])
  })

  it('keeps late task notifications on the turn that started the tool call', () => {
    const agentCall = {
      type: 'assistant', uuid: 'agent-call', session_id: 'session-1',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-agent', name: 'Agent', input: {} }] },
    } as unknown as TimestampedSessionMessage
    const notification = {
      type: 'user', uuid: 'agent-done', session_id: 'session-1', promptSource: 'sdk', origin: { kind: 'task-notification' },
      message: { role: 'user', content: '<task-notification><task-id>task-1</task-id><tool-use-id>call-agent</tool-use-id></task-notification>' },
    } as unknown as TimestampedSessionMessage
    const timeline = projectSessionTimeline('session-1', [messages[0]!, agentCall, messages[2]!, notification], { limitTurns: 10, cursor: null })

    expect(timeline.turns[0]?.messages.map((message) => (message as { uuid?: string }).uuid)).toEqual(['user-1', 'agent-call', 'agent-done'])
    expect(timeline.turns[1]?.messages.map((message) => (message as { uuid?: string }).uuid)).toEqual(['user-2'])
  })

  it('renders origin task notifications without tool-use ids on the current turn', () => {
    const notification = {
      type: 'user',
      uuid: 'agent-stopped',
      session_id: 'session-1',
      parent_tool_use_id: null,
      parent_agent_id: null,
      promptSource: 'system',
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: '<task-notification><task-id>task-1</task-id><status>stopped</status><summary>Agent stopped</summary><result>Partial result</result></task-notification>' },
    } as unknown as TimestampedSessionMessage
    const timeline = projectSessionTimeline('session-1', [messages[0]!, notification], { limitTurns: 10, cursor: null })

    expect(timeline.turns.map((turn) => turn.primaryUserUuid)).toEqual(['user-1'])
    expect(timeline.turns[0]?.messages[1]).toBe(notification)
  })

  it('keeps human pasted task notifications as user messages', () => {
    const pasted = {
      type: 'user',
      uuid: 'pasted-notification',
      session_id: 'session-1',
      parent_tool_use_id: null,
      parent_agent_id: null,
      promptSource: 'typed',
      origin: { kind: 'human' },
      message: { role: 'user', content: '<task-notification><task-id>task-1</task-id><tool-use-id>call-agent</tool-use-id><summary>Pasted</summary></task-notification>' },
    } as unknown as TimestampedSessionMessage
    const timeline = projectSessionTimeline('session-1', [messages[0]!, pasted], { limitTurns: 10, cursor: null })

    expect(timeline.turns.map((turn) => turn.primaryUserUuid)).toEqual(['user-1', 'pasted-notification'])
    expect(timeline.turns[1]?.messages[0]).toBe(pasted)
  })

  it('starts turns for scheme A boundary messages, not task notifications', () => {
    const sdkUser = {
      type: 'user',
      uuid: 'sdk-user',
      session_id: 'session-1',
      parent_tool_use_id: null,
      parent_agent_id: null,
      promptSource: 'sdk',
      origin: { kind: 'sdk' },
      message: { role: 'user', content: 'SDK prompt' },
    } as unknown as TimestampedSessionMessage
    const legacyCommand = {
      type: 'user',
      uuid: 'legacy-command',
      session_id: 'session-1',
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: { role: 'user', content: '<command-name>/compact</command-name>' },
    } as unknown as TimestampedSessionMessage
    const timeline = projectSessionTimeline('session-1', [messages[0]!, messages[4]!, sdkUser, legacyCommand], { limitTurns: 10, cursor: null })

    expect(timeline.turns.map((turn) => turn.primaryUserUuid)).toEqual(['user-1', 'sdk-user', 'legacy-command'])
    expect(timeline.turns[0]?.messages[1]).toBe(messages[4])
  })

  it('projects the current task list from full history before turn pagination', () => {
    const taskMessages = [
      messages[0]!,
      {
        type: 'assistant', uuid: 'task-create', session_id: 'session-1', parent_tool_use_id: null, parent_agent_id: null,
        message: { id: 'msg-task-create', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'call-create', name: 'TaskCreate', input: { subject: 'Inspect history', description: 'Inspect it', activeForm: 'Inspecting history' } }] },
      },
      {
        type: 'user', uuid: 'task-created', session_id: 'session-1', parent_tool_use_id: 'call-create', parent_agent_id: null,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-create', content: 'Task #1 created successfully: Inspect history' }] },
      },
      messages[2]!,
      {
        type: 'assistant', uuid: 'task-update', session_id: 'session-1', parent_tool_use_id: null, parent_agent_id: null,
        message: { id: 'msg-task-update', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'call-update', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress', activeForm: 'Deeply inspecting history' } }] },
      },
      {
        type: 'user', uuid: 'task-updated', session_id: 'session-1', parent_tool_use_id: 'call-update', parent_agent_id: null,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-update', content: 'Updated task #1 status' }] },
      },
    ] as unknown as TimestampedSessionMessage[]

    const timeline = projectSessionTimeline('session-1', taskMessages, { limitTurns: 1, cursor: null })

    expect(timeline.turns.map((turn) => turn.primaryUserUuid)).toEqual(['user-2'])
    expect(timeline.tasks).toEqual([{ key: 'call-create', taskId: '1', subject: 'Inspect history', activeForm: 'Deeply inspecting history', status: 'in_progress', blockedBy: [] }])
  })

  it('projects task results linked by message-level parent tool use id', () => {
    const taskMessages = [
      messages[0]!,
      {
        type: 'assistant', uuid: 'task-create', session_id: 'session-1', parent_tool_use_id: null, parent_agent_id: null,
        message: { id: 'msg-task-create', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'call-create', name: 'TaskCreate', input: { subject: 'Inspect history', description: 'Inspect it' } }] },
      },
      {
        type: 'user', uuid: 'task-created', session_id: 'session-1', parent_tool_use_id: 'call-create', parent_agent_id: null,
        message: { role: 'user', content: [{ type: 'tool_result', content: 'Task #1 created successfully: Inspect history' }] },
      },
      {
        type: 'assistant', uuid: 'task-update', session_id: 'session-1', parent_tool_use_id: null, parent_agent_id: null,
        message: { id: 'msg-task-update', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'call-update', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } }] },
      },
      {
        type: 'user', uuid: 'task-updated', session_id: 'session-1', parent_tool_use_id: 'call-update', parent_agent_id: null,
        message: { role: 'user', content: [{ type: 'tool_result', content: 'Updated task #1 status' }] },
      },
    ] as unknown as TimestampedSessionMessage[]

    expect(projectSessionTimeline('session-1', taskMessages, { limitTurns: 10, cursor: null }).tasks).toEqual([
      { key: 'call-create', taskId: '1', subject: 'Inspect history', status: 'in_progress', blockedBy: [] },
    ])
  })

  it('keeps only current-turn completed tasks while retaining unfinished tasks', () => {
    const create = (uuid: string, id: string, taskId: string, subject: string) => [
      {
        type: 'assistant', uuid, session_id: 'session-1', parent_tool_use_id: null, parent_agent_id: null,
        message: { id: `msg-${uuid}`, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id, name: 'TaskCreate', input: { subject, description: subject, activeForm: `Doing ${subject}` } }] },
      },
      {
        type: 'user', uuid: `${uuid}-result`, session_id: 'session-1', parent_tool_use_id: id, parent_agent_id: null,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Task #${taskId} created successfully: ${subject}` }] },
      },
    ] as unknown as TimestampedSessionMessage[]
    const update = (uuid: string, taskId: string, status: string) => [{
      type: 'assistant', uuid, session_id: 'session-1', parent_tool_use_id: null, parent_agent_id: null,
      message: { id: `msg-${uuid}`, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: `call-${uuid}`, name: 'TaskUpdate', input: { taskId, status } }] },
    }, {
      type: 'user', uuid: `${uuid}-result`, session_id: 'session-1', parent_tool_use_id: `call-${uuid}`, parent_agent_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call-${uuid}`, content: `Updated task #${taskId} status` }] },
    }] as unknown as TimestampedSessionMessage[]
    const nextTurn = { ...messages[2]!, uuid: 'user-next' }
    const history = [messages[0]!, ...create('create-old', 'call-old', '1', 'Old done'), ...update('complete-old', '1', 'completed'), nextTurn, ...create('create-current', 'call-current', '2', 'Current done'), ...update('complete-current', '2', 'completed'), ...create('create-pending', 'call-pending', '3', 'Still pending')]

    expect(projectSessionTimeline('session-1', history, { limitTurns: 10, cursor: null }).tasks).toEqual([
      { key: 'call-current', taskId: '2', subject: 'Current done', activeForm: 'Doing Current done', status: 'completed', blockedBy: [] },
      { key: 'call-pending', taskId: '3', subject: 'Still pending', activeForm: 'Doing Still pending', status: 'pending', blockedBy: [] },
    ])
  })

  it('projects unresolved blockedBy dependencies from addBlockedBy and addBlocks', () => {
    const create = (uuid: string, id: string, taskId: string, subject: string) => [
      { type: 'assistant', uuid, session_id: 'session-1', parent_tool_use_id: null, parent_agent_id: null, message: { id: `msg-${uuid}`, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id, name: 'TaskCreate', input: { subject, description: subject } }] } },
      { type: 'user', uuid: `${uuid}-result`, session_id: 'session-1', parent_tool_use_id: id, parent_agent_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Task #${taskId} created successfully: ${subject}` }] } },
    ] as unknown as TimestampedSessionMessage[]
    const update = (uuid: string, input: Record<string, unknown>) => [{ type: 'assistant', uuid, session_id: 'session-1', parent_tool_use_id: null, parent_agent_id: null, message: { id: `msg-${uuid}`, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: `call-${uuid}`, name: 'TaskUpdate', input }] } }, { type: 'user', uuid: `${uuid}-result`, session_id: 'session-1', parent_tool_use_id: `call-${uuid}`, parent_agent_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call-${uuid}`, content: `Updated task #${input.taskId} status` }] } }] as unknown as TimestampedSessionMessage[]
    const history = [messages[0]!, ...create('blocker', 'call-blocker', '6', 'Blocker'), ...create('blocked', 'call-blocked', '8', 'Blocked'), ...update('depends-one', { taskId: '8', addBlockedBy: ['6'] }), ...update('depends-again', { taskId: '8', addBlockedBy: ['6'] })]

    expect(projectSessionTimeline('session-1', history, { limitTurns: 10, cursor: null }).tasks.find((task) => task.taskId === '8')?.blockedBy).toEqual(['6'])
    history.push(...create('blocked-by-add-blocks', 'call-blocked-by-add-blocks', '9', 'Blocked by addBlocks'), ...update('blocks-nine', { taskId: '6', addBlocks: ['9'] }))
    expect(projectSessionTimeline('session-1', history, { limitTurns: 10, cursor: null }).tasks.find((task) => task.taskId === '9')?.blockedBy).toEqual(['6'])
    history.push(...update('complete-blocker', { taskId: '6', status: 'completed' }))
    expect(projectSessionTimeline('session-1', history, { limitTurns: 10, cursor: null }).tasks.find((task) => task.taskId === '8')?.blockedBy).toEqual([])
  })

  it('applies task updates only after successful tool results', () => {
    const history = [messages[0]!, {
      type: 'assistant', uuid: 'task-create', session_id: 'session-1', parent_tool_use_id: null, parent_agent_id: null,
      message: { id: 'msg-task-create', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'call-create', name: 'TaskCreate', input: { subject: 'Pending task', description: 'Pending task' } }] },
    }, {
      type: 'user', uuid: 'task-created', session_id: 'session-1', parent_tool_use_id: 'call-create', parent_agent_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-create', content: 'Task #1 created successfully: Pending task' }] },
    }, {
      type: 'assistant', uuid: 'task-update-failed', session_id: 'session-1', parent_tool_use_id: null, parent_agent_id: null,
      message: { id: 'msg-task-update-failed', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'call-update-failed', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }] },
    }, {
      type: 'user', uuid: 'task-update-failed-result', session_id: 'session-1', parent_tool_use_id: 'call-update-failed', parent_agent_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-update-failed', content: 'Task not found' }] },
    }, {
      type: 'assistant', uuid: 'task-update-ok', session_id: 'session-1', parent_tool_use_id: null, parent_agent_id: null,
      message: { id: 'msg-task-update-ok', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'call-update-ok', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } }] },
    }, {
      type: 'user', uuid: 'task-update-ok-result', session_id: 'session-1', parent_tool_use_id: 'call-update-ok', parent_agent_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-update-ok', content: 'Updated task #1 status' }] },
    }] as unknown as TimestampedSessionMessage[]

    expect(projectSessionTimeline('session-1', history, { limitTurns: 10, cursor: null }).tasks).toEqual([
      { key: 'call-create', taskId: '1', subject: 'Pending task', status: 'in_progress', blockedBy: [] },
    ])
  })

  it('keeps reused task ids separate and updates the most recent task', () => {
    const taskCall = (uuid: string, id: string, subject: string) => ({
      type: 'assistant', uuid, session_id: 'session-1', parent_tool_use_id: null, parent_agent_id: null,
      message: { id: `msg-${uuid}`, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id, name: 'TaskCreate', input: { subject, description: subject, activeForm: `Doing ${subject}` } }] },
    }) as unknown as TimestampedSessionMessage
    const taskResult = (uuid: string, id: string) => ({
      type: 'user', uuid, session_id: 'session-1', parent_tool_use_id: id, parent_agent_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Task #1 created successfully: task' }] },
    }) as unknown as TimestampedSessionMessage
    const update = [{
      type: 'assistant', uuid: 'update-second', session_id: 'session-1', parent_tool_use_id: null, parent_agent_id: null,
      message: { id: 'msg-update-second', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'call-update-second', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }] },
    }, {
      type: 'user', uuid: 'update-second-result', session_id: 'session-1', parent_tool_use_id: 'call-update-second', parent_agent_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-update-second', content: 'Updated task #1 status' }] },
    }] as unknown as TimestampedSessionMessage[]

    const timeline = projectSessionTimeline('session-1', [messages[0]!, taskCall('create-first', 'call-first', 'First'), taskResult('result-first', 'call-first'), taskCall('create-second', 'call-second', 'Second'), taskResult('result-second', 'call-second'), ...update], { limitTurns: 10, cursor: null })

    expect(timeline.tasks).toEqual([
      { key: 'call-first', taskId: '1', subject: 'First', activeForm: 'Doing First', status: 'pending', blockedBy: [] },
      { key: 'call-second', taskId: '1', subject: 'Second', activeForm: 'Doing Second', status: 'completed', blockedBy: [] },
    ])
  })

  it('uses message-level parent_tool_use_id for tool results and reattaches late results', () => {
    const lateResult = {
      type: 'user',
      uuid: 'late-result',
      session_id: 'session-1',
      parent_tool_use_id: 'toolu_123',
      parent_agent_id: null,
      timestamp: '2026-07-14T08:02:00.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'late contents' }] },
    } as TimestampedSessionMessage
    const timeline = projectSessionTimeline('session-1', [messages[0]!, messages[3]!, messages[2]!, lateResult], { limitTurns: 10, cursor: null })

    expect(timeline.turns.map((turn) => turn.primaryUserUuid)).toEqual(['user-1', 'user-2'])
    expect(timeline.turns[0]?.messages.at(-1)).toBe(lateResult)
    expect(timeline.turns[1]?.messages.some((message) => (message as { uuid?: string }).uuid === 'late-result')).toBe(false)
  })
})
