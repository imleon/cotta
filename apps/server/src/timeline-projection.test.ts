import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { projectSessionTimeline } from './timeline-projection.js'

function message(type: 'user' | 'assistant', uuid: string, extra: Record<string, unknown> = {}): SessionMessage {
  return {
    type,
    uuid,
    session_id: 'session-1',
    parent_tool_use_id: null,
    parent_agent_id: null,
    ...extra,
    message: type === 'user' ? { role: 'user', content: uuid } : { id: `msg-${uuid}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: uuid }] },
  } as SessionMessage
}

describe('projectSessionTimeline', () => {
  it('prebuilds turns and distributes messages only by database owner', () => {
    const first = message('user', 'user-1')
    const second = message('user', 'user-2')
    const lateResult = message('user', 'late-result', {
      parent_tool_use_id: 'tool-1',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] },
    })
    const timeline = projectSessionTimeline(
      'session-1',
      [
        { uuid: 'user-1', timestamp: 100, userCwd: '/repo/start', responseCwd: '/repo/end' },
        { uuid: 'user-2', timestamp: null },
      ],
      [
        { ownerTurnId: 'user-1', message: first },
        { ownerTurnId: 'user-2', message: second },
        { ownerTurnId: 'user-1', message: lateResult },
      ],
    )

    expect(timeline.turns).toEqual([
      { primaryUserUuid: 'user-1', primaryUserTimestampMs: 100, userCwd: '/repo/start', responseCwd: '/repo/end', messages: [first, lateResult] },
      { primaryUserUuid: 'user-2', messages: [second] },
    ])
    expect(timeline).toMatchObject({ sessionId: 'session-1', hasMore: false, nextCursor: null })
  })

  it('preserves ordered assistant records that share an API message id', () => {
    const first = message('assistant', 'assistant-1', {
      message: { id: 'msg-shared', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'CronList', input: {} }] },
    })
    const second = message('assistant', 'assistant-2', {
      message: { id: 'msg-shared', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'call-2', name: 'Bash', input: { command: 'pwd' } }] },
    })

    const timeline = projectSessionTimeline(
      'session-1',
      [{ uuid: 'user-1', timestamp: 0 }],
      [
        { ownerTurnId: 'user-1', message: first },
        { ownerTurnId: 'user-1', message: second },
      ],
    )

    expect(timeline.turns[0]?.messages).toEqual([first, second])
  })

  it('filters synthetic users, non-messages, and unknown owners', () => {
    const assistant = message('assistant', 'assistant-1')
    const synthetic = message('user', 'synthetic', { isSynthetic: true })
    const attachment = { ...message('user', 'attachment'), type: 'attachment' } as unknown as SessionMessage
    const timeline = projectSessionTimeline(
      'session-1',
      [{ uuid: 'user-1', timestamp: 0 }],
      [
        { ownerTurnId: 'user-1', message: synthetic },
        { ownerTurnId: 'user-1', message: attachment },
        { ownerTurnId: 'missing', message: message('user', 'orphan') },
        { ownerTurnId: 'user-1', message: assistant },
      ],
    )

    expect(timeline.turns[0]?.messages).toEqual([assistant])
  })

  it('preserves only local-command system events', () => {
    const command = {
      type: 'system',
      subtype: 'local_command',
      uuid: 'command',
      session_id: 'session-1',
      parent_tool_use_id: null,
      parent_agent_id: null,
      content: '<command-name>/model</command-name><command-message>model</command-message>',
    } as unknown as SessionMessage
    const stdout = {
      type: 'system',
      subtype: 'local_command',
      uuid: 'stdout',
      session_id: 'session-1',
      parent_tool_use_id: null,
      parent_agent_id: null,
      parentUuid: 'command',
      content: '<local-command-stdout>Set model to Example</local-command-stdout>',
    } as unknown as SessionMessage
    const duration = { type: 'system', subtype: 'turn_duration', uuid: 'duration', session_id: 'session-1', parent_tool_use_id: null, parent_agent_id: null } as unknown as SessionMessage
    const timeline = projectSessionTimeline(
      'session-1',
      [{ uuid: 'command', timestamp: 0 }],
      [
        { ownerTurnId: 'command', message: command },
        { ownerTurnId: 'command', message: stdout },
        { ownerTurnId: 'command', message: duration },
      ],
    )

    expect(timeline.turns[0]?.messages).toEqual([command, stdout])
  })

  it('filters local-command caveats without filtering Skill meta', () => {
    const caveat = { ...message('user', 'caveat'), isMeta: true, message: { role: 'user', content: '<local-command-caveat>generated command context</local-command-caveat>' } }
    const skillMeta = {
      ...message('user', 'skill-meta'),
      isMeta: true,
      sourceToolUseID: 'call-skill',
      message: { role: 'user', content: '<local-command-caveat>Skill content</local-command-caveat>' },
    }
    const assistant = message('assistant', 'assistant-1')
    const timeline = projectSessionTimeline(
      'session-1',
      [{ uuid: 'user-1', timestamp: 0 }],
      [
        { ownerTurnId: 'user-1', message: caveat },
        { ownerTurnId: 'user-1', message: skillMeta },
        { ownerTurnId: 'user-1', message: assistant },
      ],
    )

    expect(timeline.turns[0]?.messages).toEqual([skillMeta, assistant])
  })
})
