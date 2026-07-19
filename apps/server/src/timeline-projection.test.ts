import { describe, expect, it } from 'vitest'
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { projectSessionTimeline } from './timeline-projection.js'

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
    timestamp: '2026-07-14T08:01:20.000Z',
    message: {
      role: 'user',
      content: '<task-notification>\n<task-id>task_123</task-id>\n<tool-use-id>call_123</tool-use-id>\n<output-file>/tmp/task.output</output-file>\n<status>completed</status>\n<summary>Agent finished</summary>\n<result>Done</result>\n</task-notification>',
    },
  },
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

describe('projectSessionTimeline', () => {
  it('projects chronological session messages into turn blocks', () => {
    const timeline = projectSessionTimeline('session-1', messages, { limitTurns: 10, cursor: null })

    expect(timeline.turns.map((turn) => turn.id)).toEqual(['user-1', 'user-2'])
    expect(timeline.turns[0]?.blocks.map((block) => block.kind)).toEqual(['user.message', 'assistant.text'])
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

  it('does not start a new turn for non-query user messages', () => {
    const timeline = projectSessionTimeline('session-1', [
      messages[0]!,
      {
        type: 'user',
        uuid: 'internal-user',
        session_id: 'session-1',
        parent_tool_use_id: null,
        parent_agent_id: null,
        timestamp: '2026-07-14T08:00:05.000Z',
        message: { role: 'user', content: 'Internal note', shouldQuery: false },
      } as TimestampedSessionMessage,
    ], { limitTurns: 10, cursor: null })

    expect(timeline.turns.map((turn) => turn.id)).toEqual(['user-1'])
    expect(timeline.turns[0]?.blocks.map((block) => block.id)).toEqual(['user-1:user', 'internal-user:user'])
  })
})
