import { isPrimaryTimelineUserMessage, isTimelineLocalCommandCaveatMessage, isTimelineTaskNotificationMessage } from '@cotta/shared'
import { describe, expect, it } from 'vitest'
import { materializeTranscriptTurnOwnership, seedTranscriptTurnOwnershipState } from './transcript-turn-ownership.js'

function line(byte_offset: number, value: Record<string, unknown>, session_id = 'session') {
  return { session_id, byte_offset, raw_json: JSON.stringify({ sessionId: session_id, ...value }) }
}

function user(uuid: string, extra: Record<string, unknown> = {}) {
  return { type: 'user', uuid, message: { role: 'user', content: 'prompt' }, ...extra }
}

function assistant(uuid: string, parentUuid: string, toolUseId?: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    message: { role: 'assistant', content: toolUseId ? [{ type: 'tool_use', id: toolUseId }] : [] },
    ...extra,
  }
}

function result(uuid: string, ids: string[], parentUuid?: string) {
  return {
    type: 'user',
    uuid,
    ...(parentUuid ? { parentUuid } : {}),
    message: { role: 'user', content: ids.map((tool_use_id) => ({ type: 'tool_result', tool_use_id })) },
  }
}

describe('timeline user message classification', () => {
  it('classifies only strict explicit and legacy task notification envelopes', () => {
    const legacy = user('legacy', {
      message: { role: 'user', content: '<task-notification><task-id>task</task-id><tool-use-id>tool</tool-use-id></task-notification>' },
    })
    const explicitInvalid = user('invalid', {
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: '<task-notification><task-id>task</task-id>' },
    })
    const blank = user('blank', {
      message: { role: 'user', content: '<task-notification><task-id> </task-id><tool-use-id>tool</tool-use-id></task-notification>' },
    })
    const nested = user('nested', {
      message: { role: 'user', content: '<task-notification><note><task-id>task</task-id><tool-use-id>tool</tool-use-id></note></task-notification>' },
    })

    expect(isTimelineTaskNotificationMessage(legacy)).toBe(true)
    expect(isPrimaryTimelineUserMessage(legacy)).toBe(false)
    expect(isTimelineTaskNotificationMessage(explicitInvalid)).toBe(true)
    expect(isPrimaryTimelineUserMessage(explicitInvalid)).toBe(false)
    expect(isTimelineTaskNotificationMessage(blank)).toBe(false)
    expect(isPrimaryTimelineUserMessage(blank)).toBe(true)
    expect(isTimelineTaskNotificationMessage(nested)).toBe(false)
    expect(isPrimaryTimelineUserMessage(nested)).toBe(true)
  })

  it('recognizes only non-Skill local-command caveat envelopes', () => {
    const caveat = user('caveat', { isMeta: true, message: { role: 'user', content: '  <local-command-caveat>任意内容</local-command-caveat>  ' } })

    expect(isTimelineLocalCommandCaveatMessage(caveat)).toBe(true)
    expect(isTimelineLocalCommandCaveatMessage({ ...caveat, sourceToolUseID: 'call-skill' })).toBe(false)
    expect(isTimelineLocalCommandCaveatMessage({ ...caveat, isMeta: false })).toBe(false)
    expect(isTimelineLocalCommandCaveatMessage({ ...caveat, message: { role: 'assistant', content: caveat.message.content } })).toBe(false)
    expect(isTimelineLocalCommandCaveatMessage({ ...caveat, message: { role: 'user', content: '<local-command-caveat>partial' } })).toBe(false)
    expect(
      isTimelineLocalCommandCaveatMessage({ ...caveat, message: { role: 'user', content: '<local-command-caveat>one</local-command-caveat><local-command-caveat>two</local-command-caveat>' } }),
    ).toBe(false)
    expect(isTimelineLocalCommandCaveatMessage({ ...caveat, message: { role: 'user', content: [{ type: 'text', text: 'caveat' }] } })).toBe(false)
  })
})

describe('materializeTranscriptTurnOwnership', () => {
  it('materializes primary, tool, parent, fallback, sidechain, and replay ownership in byte order', () => {
    const rows = materializeTranscriptTurnOwnership([
      line(90, result('conflict', ['tool-a', 'tool-b'])),
      line(10, user('turn-a')),
      line(20, assistant('assistant-a', 'turn-a', 'tool-a')),
      line(30, user('sidechain', { parentUuid: 'assistant-a', isSidechain: true })),
      line(40, user('turn-b')),
      line(50, assistant('assistant-b', 'turn-b', 'tool-b')),
      line(60, result('late-a', ['tool-a'])),
      line(70, { type: 'system', uuid: 'child', parentUuid: 'sidechain' }),
      line(80, { type: 'system', uuid: 'fallback' }),
      line(100, assistant('assistant-a', 'turn-b', 'tool-a')),
      line(110, result('replayed-a', ['tool-a'])),
      line(0, { type: 'system', uuid: 'orphan' }),
    ])

    expect(rows.map(({ byte_offset, owner_turn_id }) => [byte_offset, owner_turn_id])).toEqual([
      [0, null],
      [10, 'turn-a'],
      [20, 'turn-a'],
      [30, 'turn-a'],
      [40, 'turn-b'],
      [50, 'turn-b'],
      [60, 'turn-a'],
      [70, 'turn-a'],
      [80, 'turn-b'],
      [90, null],
      [100, 'turn-b'],
      [110, 'turn-b'],
    ])
  })

  it('keeps sourced tagged user input as a normal Turn while preserving legacy commands', () => {
    const content = '<command-name>/model</command-name><command-message>model</command-message>'
    const rows = materializeTranscriptTurnOwnership([
      line(0, user('typed', { userType: 'external', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content } })),
      line(1, assistant('typed-answer', 'typed')),
      line(2, user('legacy', { userType: 'external', message: { role: 'user', content } })),
    ])

    expect(rows.map(({ owner_turn_id }) => owner_turn_id)).toEqual(['typed', 'typed', 'legacy'])
  })

  it('keeps strictly linked local command feedback with its command root', () => {
    const command = (uuid: string, content: string, extra: Record<string, unknown> = {}) => ({ type: 'user', uuid, message: { role: 'user', content }, ...extra })
    const systemCommand = (uuid: string, content: string, parentUuid?: string) => ({ type: 'system', uuid, subtype: 'local_command', content, ...(parentUuid ? { parentUuid } : {}) })

    const rows = materializeTranscriptTurnOwnership([
      line(0, command('caveat', '<local-command-caveat>ignore</local-command-caveat>', { isMeta: true })),
      line(1, command('legacy-command', '<command-name>/model</command-name><command-message>model</command-message>', { parentUuid: 'caveat' })),
      line(2, command('legacy-output', '<local-command-stdout>Set model to Example</local-command-stdout>', { parentUuid: 'legacy-command', userType: 'external' })),
      line(3, user('ordinary')),
      line(4, systemCommand('system-command', '<command-name>/status</command-name><command-message>status</command-message>', 'ordinary')),
      line(5, systemCommand('system-output', '<local-command-stdout>Settings dialog dismissed</local-command-stdout>', 'system-command')),
      line(6, command('compact-command', '<command-name>/compact</command-name><command-message>compact</command-message>')),
      line(7, systemCommand('compact-error', '<local-command-stderr>Error during compaction</local-command-stderr>', 'compact-command')),
      line(8, systemCommand('help', '/help')),
      line(9, systemCommand('help-output', '<local-command-stdout>Help unavailable</local-command-stdout>', 'help')),
      line(10, { type: 'system', uuid: 'duration', subtype: 'turn_duration', parentUuid: 'help' }),
    ])

    expect(rows.map(({ owner_turn_id }) => owner_turn_id)).toEqual([
      null,
      'legacy-command',
      'legacy-command',
      'ordinary',
      'system-command',
      'system-command',
      'compact-command',
      'compact-command',
      'help',
      'help',
      'help',
    ])
  })

  it('does not link nested notification tool IDs to an owner', () => {
    const nested = user('nested', {
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: '<task-notification><task-id>task</task-id><note><tool-use-id>tool</tool-use-id></note></task-notification>' },
    })
    const rows = materializeTranscriptTurnOwnership([line(0, user('turn-a')), line(1, assistant('assistant-a', 'turn-a', 'tool')), line(2, user('turn-b')), line(3, nested)])

    expect(rows.map((row) => row.owner_turn_id)).toEqual(['turn-a', 'turn-a', 'turn-b', 'turn-b'])
  })

  it('uses a resolved tool owner and rejects conflicting tool owners', () => {
    const rows = materializeTranscriptTurnOwnership([
      line(0, user('turn')),
      line(1, assistant('assistant', 'turn', 'known')),
      line(2, result('partly-known', ['known', 'missing'])),
      line(3, result('same-owner', ['known', 'known'])),
    ])
    expect(rows.map((row) => row.owner_turn_id)).toEqual(['turn', 'turn', 'turn', 'turn'])
  })
})

describe('seedTranscriptTurnOwnershipState', () => {
  it('retains local command roots across incremental ownership state', () => {
    const command = {
      type: 'system',
      subtype: 'local_command',
      uuid: 'command',
      content: '<command-name>/model</command-name><command-message>model</command-message>',
    }
    const states = seedTranscriptTurnOwnershipState([{ ...line(0, command), uuid: 'command', owner_turn_id: 'command' }])
    const feedback = { type: 'system', subtype: 'local_command', uuid: 'stdout', parentUuid: 'command', content: '<local-command-stdout>Set model to Example</local-command-stdout>' }

    expect(materializeTranscriptTurnOwnership([line(1, feedback)], states)[0]?.owner_turn_id).toBe('command')
  })

  it('does not let stale null owners overwrite existing tool ownership', () => {
    const states = seedTranscriptTurnOwnershipState([
      { ...line(0, user('turn')), uuid: 'turn', owner_turn_id: 'turn' },
      { ...line(1, assistant('assistant', 'turn', 'tool')), uuid: 'assistant', owner_turn_id: 'turn' },
      { ...line(2, assistant('stale', 'turn', 'tool')), uuid: 'stale', owner_turn_id: null },
    ])

    const rows = materializeTranscriptTurnOwnership([line(3, result('tool-result', ['tool']))], states)

    expect(rows[0]!.owner_turn_id).toBe('turn')
  })
})
