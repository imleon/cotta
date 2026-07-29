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

  it('returns a leading response-only frame', () => {
    const sequence = [messages[1]!, messages[0]!]

    expect(sessionMessagesForTurn(sequence, 'assistant-1')?.map((message) => message.uuid)).toEqual(['assistant-1'])
  })
})

describe('projectSessionTimeline', () => {
  it('projects chronological session messages into turn blocks', () => {
    const timeline = projectSessionTimeline('session-1', messages, { limitTurns: 10, cursor: null })

    expect(timeline.turns.map((turn) => turn.id)).toEqual(['user-1', 'user-2'])
    expect(timeline.turns[0]?.blocks.map((block) => block.kind)).toEqual(['user.message', 'assistant.text'])
    expect(timeline.turns[0]?.blocks[0]?.data).toEqual(expect.objectContaining({ primaryTimelineUserMessage: true }))
    expect(timeline.turns[1]?.blocks.map((block) => block.kind)).toEqual([
      'user.message',
      'assistant.text',
      'assistant.tool_use',
      'assistant.task_notification',
      'tool.result',
    ])
    expect(timeline.turns[1]?.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'assistant-2:assistant:1',
        kind: 'assistant.tool_use',
        apiMessageId: 'msg_assistant_2',
        contentBlockId: 'toolu_123',
        toolUseId: 'toolu_123',
      }),
      expect.objectContaining({
        id: 'task-notification-1:task_notification',
        kind: 'assistant.task_notification',
        data: expect.objectContaining({ taskId: 'task_123', status: 'completed' }),
      }),
      expect.objectContaining({
        id: 'tool-result-1:tool_result:0',
        kind: 'tool.result',
        toolUseId: 'toolu_123',
      }),
    ]))
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

    expect(timeline.turns[0]).toMatchObject({
      id: 'image-user',
      title: 'Describe this',
      blocks: [
        { id: 'image-user:user:0', kind: 'user.message' },
        { id: 'image-user:image:1', kind: 'user.image' },
      ],
    })
  })

  it('uses an image title for image-only turns', () => {
    const timeline = projectSessionTimeline('session-1', [{
      type: 'user',
      uuid: 'image-user',
      session_id: 'session-1',
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] },
    } as TimestampedSessionMessage], { limitTurns: 10, cursor: null })

    expect(timeline.turns[0]?.title).toBe('Image')
  })

  it('projects a leading response-only frame', () => {
    const timeline = projectSessionTimeline('session-1', [messages[1]!, messages[0]!], { limitTurns: 10, cursor: null })

    expect(timeline.turns.map((turn) => turn.id)).toEqual(['assistant-1', 'user-1'])
    expect(timeline.turns[0]).toMatchObject({ title: 'Session events', blocks: [{ kind: 'assistant.text' }] })
  })

  it.each<[string, Record<string, unknown>, string | null, Record<string, unknown>?]>([
    ['internal', { origin: 'internal' }, null],
    ['synthetic', {}, null, { isSynthetic: true }],
    ['non-query', {}, null, { shouldQuery: false }],
    ['meta', {}, null, { isMeta: true }],
    ['sidechain', {}, null, { isSidechain: true }],
    ['peer', {}, null, { origin: { kind: 'peer' } }],
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

    expect(timeline.turns.map((turn) => turn.id)).toEqual(['user-1'])
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

    expect(timeline.turns.map((turn) => turn.id)).toEqual(['user-1', 'scheme-a-user'])
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

    expect(timeline.turns.map((turn) => turn.id)).toEqual(['user-1'])
    expect(timeline.turns[0]?.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'agent-call:assistant:0', kind: 'assistant.tool_use', toolUseId: 'call-agent' }),
      expect.objectContaining({
        id: 'agent-done:task_notification',
        kind: 'assistant.task_notification',
        data: expect.objectContaining({
          taskId: 'task-1',
          toolUseId: 'call-agent',
          originalToolUse: { id: 'call-agent', name: 'Agent', input: { prompt: 'Investigate' } },
        }),
      }),
    ]))
    expect(sessionMessagesForTurn([messages[0]!, agentCall, notification], 'user-1')?.map((message) => message.uuid)).toEqual(['user-1', 'agent-call', 'agent-done'])
  })

  it('starts turns for scheme A boundary messages, not task notifications with task origin', () => {
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

    expect(timeline.turns.map((turn) => turn.id)).toEqual(['user-1', 'sdk-user', 'legacy-command'])
    expect(timeline.turns[0]?.blocks[1]).toEqual(expect.objectContaining({
      kind: 'assistant.task_notification',
      data: expect.objectContaining({ taskId: 'task_123', toolUseId: 'call_123', outputFile: '/tmp/task.output', status: 'completed', summary: 'Agent finished', result: 'Done' }),
    }))
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

    expect(timeline.turns.map((turn) => turn.id)).toEqual(['user-1', 'user-2'])
    expect(timeline.turns[0]?.blocks.at(-1)).toEqual(expect.objectContaining({ id: 'late-result:tool_result:0', kind: 'tool.result', toolUseId: 'toolu_123' }))
    expect(timeline.turns[1]?.blocks.some((block) => block.id === 'late-result:tool_result:0')).toBe(false)
  })
})
