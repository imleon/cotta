import { randomBytes } from 'node:crypto'
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { type ProjectSessionsResponse, type SessionTimelineResponse, turnCookingLabel } from '@cotta/shared'
import { describe, expect, it } from 'vitest'
import { decodeDetailToken } from './detail-token.js'
import { decodeLarkCardAction } from './lark-card-action.js'
import { LARK_CARD_MAX_BYTES, LARK_CARD_MAX_ELEMENTS, projectLarkResultCard, projectLarkSessionCard, projectLarkTurnCard, projectLarkTurnMessages } from './lark-card-projection.js'

const renderedAtMs = new Date(2026, 8, 30, 10, 30).getTime()
const identity = { botId: 'bot', configVersion: 1, projectId: 'project', createdAtMs: 1_000, renderedAtMs, secret: 'secret' }
const session = { id: 'session', title: '会话', projectId: 'project', lastActivityAt: new Date(2026, 8, 30, 9, 5).getTime(), occupiedBy: null, occupiedStatus: 'idle' as const, kind: null }

function sdkMessage(type: 'user' | 'assistant', uuid: string, content: unknown[]): SessionMessage {
  return { type, uuid, session_id: 'session', parent_tool_use_id: null, parent_agent_id: null, message: { role: type, content } }
}

function timeline(messages: SessionMessage[]): SessionTimelineResponse {
  return {
    sessionId: 'session',
    turns: [{ primaryUserUuid: 'turn', primaryUserTimestampMs: Date.parse('2026-09-29T17:06:00.000Z'), entrypoint: 'sdk-ts', messages }],
    runtimeTurnProjection: null,
    turnOptions: { permissionMode: null, model: null, effort: null },
    contextUsage: null,
    liveBackgroundTasks: null,
    runState: { phase: 'requires_action', activeUserMessageUuid: 'turn', pendingPermission: { requestId: 'request', toolUseID: 'tool', toolName: 'AskUserQuestion', input: {} } },
    activity: { owner: 'cotta', phase: 'waiting', activeTurnId: 'turn' },
    pendingPermission: { requestId: 'request', toolUseID: 'tool', toolName: 'AskUserQuestion', input: {} },
    hasMore: true,
    hasNewer: false,
    nextCursor: 'turn',
    snapshotFromTurnId: null,
    anchorTurnId: null,
    state: { sessionId: 'session', version: 'v1' },
    tasks: null,
  }
}

describe('Lark card projection', () => {
  it('projects official SessionMessage conversation, tool, permission, question, and run states', () => {
    const messages = [
      sdkMessage('user', 'turn', [
        { type: 'text', text: '你好' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'hidden-image' } },
      ]),
      sdkMessage('user', 'other-user', [{ type: 'text', text: 'hidden-user' }]),
      sdkMessage('assistant', 'a', [
        { type: 'text', text: '我来检查' },
        { type: 'tool_use', id: 'question', name: 'AskUserQuestion', input: { questions: [{ question: 'hidden-question' }] } },
        { type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'hidden-command' } },
      ]),
      sdkMessage('user', 'tool-result', [
        {
          type: 'tool_result',
          tool_use_id: 'tool',
          content: [
            { type: 'text', text: 'hidden-result' },
            { type: 'image', source: { type: 'url', url: 'https://example.com/hidden.png' } },
          ],
        },
      ]),
    ]
    const messagesProjection = projectLarkTurnMessages(messages, 'turn')
    expect(messagesProjection.primary).toEqual(['你好'])
    expect(messagesProjection.replies).toEqual([
      { kind: 'markdown', content: '我来检查' },
      { kind: 'text', content: '> Called AskUserQuestion, Bash' },
    ])
    expect(JSON.stringify(messagesProjection)).not.toMatch(/hidden-image|hidden-result|hidden-user|hidden-question|hidden-command/)

    const response = timeline(messages)
    response.turns.unshift({ primaryUserUuid: 'older', primaryUserTimestampMs: 0, messages: [sdkMessage('user', 'older', [{ type: 'text', text: 'hidden-older-turn' }])] })
    const projected = projectLarkTurnCard(session, '项目', response, identity, 'Asia/Shanghai')
    const json = JSON.stringify(projected.card)
    const divider = projected.card.body.elements.at(-3)
    const note = projected.card.body.elements.at(-2)
    const footer = projected.card.body.elements.at(-1) as {
      columns: Array<{ elements: Array<{ icon: { token: string }; hover_tips: { content: string }; size: string; behaviors: Array<{ value: { token: string } }> }> }>
    }
    const refresh = footer.columns.at(-1)?.elements[0]

    expect(projected.card.header).toEqual({
      template: 'blue',
      title: { tag: 'plain_text', content: '会话' },
      icon: { tag: 'standard_icon', token: 'submit-feedback_outlined' },
      subtitle: { tag: 'plain_text', content: '项目' },
    })
    expect(json).not.toContain('**Status**')
    expect(json).not.toContain('**Updated**')
    expect(json).not.toContain('**Data as of**')
    expect(json).not.toMatch(/\*\*(?:User|Assistant|Turn ·)/)
    const user = projected.card.body.elements.find((element) => element.background_style === 'turn-user-message') as {
      columns: Array<{ elements: Array<{ content: string }> }>
      behaviors?: unknown
    }
    expect(user).toMatchObject({ tag: 'column_set', background_style: 'turn-user-message', columns: [{ elements: [{ tag: 'markdown', content: '💬 你好' }] }] })
    expect(user.behaviors).toBeUndefined()
    expect(json).toContain('我来检查')
    expect(json).toContain('> Calling AskUserQuestion, Bash')
    expect(json).not.toContain('Tool ·')
    expect(projected.card.config.style).toEqual({ color: { 'turn-user-message': { light_mode: 'rgba(248,249,250,1)', dark_mode: 'rgba(35,36,38,1)' } } })
    expect(note).toMatchObject({ text: { text_color: 'grey', text_size: 'notation', text_align: 'left' } })
    expect(json).not.toContain('hidden-older-turn')
    expect(json).not.toContain('Load more')
    expect(divider).toEqual({ tag: 'hr' })
    expect(footer).toMatchObject({ tag: 'column_set', horizontal_align: 'right' })
    expect(footer.columns).toHaveLength(5)
    expect(refresh).toMatchObject({ icon: { token: 'refresh_outlined' }, hover_tips: { content: 'Refresh' }, size: 'tiny' })
    expect(refresh).not.toHaveProperty('text')
    expect(decodeLarkCardAction(refresh?.behaviors[0]?.value.token as string, identity.secret, identity.createdAtMs)).toMatchObject({
      card: 'turn',
      operation: 'refresh',
      sessionId: 'session',
    })
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(LARK_CARD_MAX_BYTES)
    expect((json.match(/"tag":/g) ?? []).length).toBeLessThanOrEqual(LARK_CARD_MAX_ELEMENTS)

    response.turns[response.turns.length - 1] = { primaryUserUuid: 'turn', messages }
    expect(projectLarkTurnCard(session, '项目', response, identity, 'Asia/Shanghai').card.header).not.toHaveProperty('text_tag_list')

    response.turns[response.turns.length - 1] = { primaryUserUuid: 'turn', entrypoint: 'cli', messages }
    expect(projectLarkTurnCard(session, '项目', response, identity, 'Asia/Shanghai').card.header).toMatchObject({ text_tag_list: [{ text: { content: 'CLI' } }] })
  })

  it('aggregates consecutive Lark activity with reliable thinking duration and literal text quotes', () => {
    const timed = (uuid: string, timestamp: string, messageId: string, content: unknown[]) =>
      ({ ...sdkMessage('assistant', uuid, content), timestamp, message: { id: messageId, role: 'assistant', content } }) as unknown as SessionMessage
    const messages = [
      timed('thinking', '2026-09-30T02:00:00.000Z', 'msg-1', [{ type: 'thinking', thinking: 'hidden thought' }]),
      sdkMessage('user', 'result-between', [{ type: 'tool_result', tool_use_id: 'unrelated', content: 'ok' }]),
      timed('tools', '2026-09-30T02:00:02.000Z', 'msg-1', [
        { type: 'tool_use', id: 'glob', name: 'Glob', input: { pattern: '*.ts' } },
        { type: 'tool_use', id: 'grep', name: 'Grep', input: { pattern: 'foo' } },
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/tmp/a.ts' } },
        { type: 'tool_use', id: 'read-2', name: 'Read', input: { file_path: '/tmp/a.ts' } },
        { type: 'tool_use', id: 'codegraph', name: 'mcp__codegraph__codegraph_explore', input: { query: 'foo' } },
      ]),
      sdkMessage('user', 'errors', [{ type: 'tool_result', tool_use_id: 'grep', content: 'failed', is_error: true }]),
      sdkMessage('assistant', 'boundary', [
        { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'pwd' } },
        { type: 'tool_use', id: 'bash-2', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: 'agent', name: 'Agent', input: {} },
      ]),
      sdkMessage('assistant', 'answer', [{ type: 'text', text: '**Done**' }]),
      sdkMessage('assistant', 'other-mcp', [{ type: 'tool_use', id: 'other', name: 'mcp__other__inspect', input: {} }]),
      sdkMessage('assistant', 'tail', [
        { type: 'thinking', thinking: 'still hidden' },
        { type: 'tool_use', id: 'tail-read', name: 'Read', input: { file_path: '/tmp/b.ts' } },
        { type: 'tool_use', id: 'tail-bash', name: 'Bash', input: { command: 'pwd' } },
      ]),
    ]

    expect(projectLarkTurnMessages(messages, 'turn', true).replies).toEqual([
      { kind: 'text', content: '> Thought for 2s, searched for 2 patterns, read 1 file, called MCP Codegraph, called Bash 2 times, Agent, 1 error' },
      { kind: 'markdown', content: '**Done**' },
      { kind: 'text', content: '> Thinking, reading 1 file, calling mcp__other__inspect, Bash' },
    ])

    const projected = projectLarkTurnCard(session, '项目', { ...timeline(messages), activity: { owner: 'cotta', phase: 'busy', activeTurnId: 'turn' } }, identity, 'UTC')
    const body = projected.card.body.elements
    expect(body.find((element) => element.tag === 'div' && JSON.stringify(element).includes('Thought for 2s'))).toMatchObject({ text: { tag: 'plain_text', text_color: 'grey' } })
    expect(body.find((element) => element.tag === 'markdown' && element.content === '**Done**')).toBeTruthy()
    expect(body.find((element) => element.tag === 'markdown' && String(element.content).startsWith('>'))).toBeUndefined()
  })

  it('projects a streaming result without user or navigation and settles with fixed Refresh', () => {
    const replies = [
      { kind: 'text' as const, content: '> Read 1 file' },
      { kind: 'markdown' as const, content: '**Done**' },
    ]
    const streaming = projectLarkResultCard('Result', '项目', 'session', 'turn', replies, identity, true)
    expect(streaming.config.streaming_mode).toBe(true)
    expect(streaming.config.summary).toEqual({ content: turnCookingLabel('turn') })
    expect(JSON.stringify(projectLarkResultCard('Result', '项目', 'session', 'turn', [], identity, true))).toContain(turnCookingLabel('turn'))
    expect(JSON.stringify(projectLarkResultCard('Result', '项目', 'session', 'turn', [], identity, false))).toContain('(No response yet)')
    expect(streaming.body.elements.map((element) => element.element_id)).toEqual(['reply_0', 'reply_1'])
    expect(streaming.body.elements.every((element) => typeof element.element_id === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(element.element_id))).toBe(true)
    expect(JSON.stringify(streaming.body.elements)).not.toMatch(/turn-user-message|First Turn|Previous Turn|Refresh/)

    const response = timeline([])
    response.turns[0]!.durationMs = 65_000
    response.turns[0]!.durationTimestampMs = Date.parse('2026-09-30T02:20:00.000Z')
    response.activity = { owner: null, phase: 'idle', activeTurnId: null }
    response.runState = { phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'turn', outcome: 'success' } }
    const settled = projectLarkResultCard('Result', '项目', 'session', 'turn', replies, identity, false, { session, response, timeZone: 'Asia/Shanghai', showDebugNav: true })
    const settledJson = JSON.stringify(settled)
    expect(settled.config.streaming_mode).toBe(false)
    expect(settled.config.summary).toBeUndefined()
    expect(JSON.stringify(projectLarkResultCard('Result', '项目', 'session', 'turn', [], identity, false, { session, response, timeZone: 'Asia/Shanghai', showDebugNav: true }))).toContain(
      '(No response yet)',
    )
    expect(settledJson).toContain('Refresh')
    expect(settledJson).toMatch(/Card \d+\.\d+ \/ 30 kB · \d+ \/ 200 elements/)
    expect(settledJson).toMatch(/for 1m 5s · 09\/30 10:20/)
    expect(settled.body.elements.some((element) => element.background_style === 'turn-user-message')).toBe(false)
    expect(settledJson).not.toMatch(/First Turn|Previous Turn|Next Turn|Latest Turn/)
  })

  it('budgets unsettled result cards while retaining the latest reply', () => {
    const replies = Array.from({ length: 220 }, (_, index) => ({ kind: 'markdown' as const, content: `${index}-${'界😀'.repeat(index === 219 ? 12_000 : 20)}` }))

    for (const streaming of [true, false]) {
      const projected = projectLarkResultCard('Result', '项目', 'session', 'turn', replies, identity, streaming)
      const json = JSON.stringify(projected)
      expect(projected.config.streaming_mode).toBe(streaming)
      expect(json).toContain('Earlier Turn content omitted due to card display limit')
      expect(json).toContain('219-')
      expect(json).not.toContain('�')
      expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(28_000)
      expect((json.match(/"tag":/g) ?? []).length).toBeLessThanOrEqual(190)
    }
  })

  it('keeps complete Turn content when it fits and budgets overflowing user and replies', () => {
    const longUser = `question-${'界😀"\\\n'.repeat(1_100)}`
    const shortReply = `answer-${'a'.repeat(2_000)}`
    const complete = projectLarkTurnCard(
      session,
      '项目',
      timeline([sdkMessage('user', 'turn', [{ type: 'text', text: longUser }]), sdkMessage('assistant', 'reply', [{ type: 'text', text: shortReply }])]),
      identity,
      'UTC',
    )
    const completeUser = complete.card.body.elements.find((element) => element.background_style === 'turn-user-message') as { columns: Array<{ elements: Array<{ content: string }> }> }
    expect(completeUser.columns[0]?.elements[0]?.content).toBe(`💬 ${longUser.trim()}`)
    expect(complete.card.body.elements.some((element) => element.content === shortReply)).toBe(true)
    expect(complete.atLimit).toBe(false)

    const olderReply = `older-${'旧😀'.repeat(8_000)}`
    const latestReply = `latest-${'新😀'.repeat(8_000)}`
    const projected = projectLarkTurnCard(
      session,
      '项目',
      timeline([
        sdkMessage('user', 'turn', [{ type: 'text', text: longUser }]),
        sdkMessage('assistant', 'older', [{ type: 'text', text: olderReply }]),
        sdkMessage('assistant', 'latest', [{ type: 'text', text: latestReply }]),
      ]),
      identity,
      'UTC',
    )
    const json = JSON.stringify(projected.card)
    const user = projected.card.body.elements.find((element) => element.background_style === 'turn-user-message') as { columns: Array<{ elements: Array<{ content: string }> }> }
    const userContent = user.columns[0]?.elements[0]?.content ?? ''
    const withoutUser = { ...projected.card, body: { elements: projected.card.body.elements.filter((element) => element !== user) } }
    expect(Buffer.byteLength(JSON.stringify(projected.card), 'utf8') - Buffer.byteLength(JSON.stringify(withoutUser), 'utf8')).toBeLessThanOrEqual(6_000)
    expect(userContent).toMatch(/…$/)
    expect([...userContent].some((character) => character === '�')).toBe(false)
    expect(json).toContain('latest-')
    expect(json).toContain('…')
    expect(json).toContain('Earlier Turn content omitted due to card display limit')
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(28_000)
    expect((json.match(/"tag":/g) ?? []).length).toBeLessThanOrEqual(190)
    expect(projected.atLimit).toBe(true)
  })

  it('shares Timeline hidden-tool semantics without splitting Lark activity', () => {
    const messages = [
      sdkMessage('assistant', 'activity', [
        { type: 'thinking', thinking: 'hidden' },
        { type: 'tool_use', id: 'task-create', name: 'TaskCreate', input: {} },
        { type: 'tool_use', id: 'todo', name: 'TodoWrite', input: {} },
        { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/tmp/a.ts' } },
        { type: 'tool_use', id: 'todo-error', name: 'TodoWrite', input: {} },
        { type: 'tool_use', id: 'list-error', name: 'ListAgents', input: {} },
        { type: 'tool_use', id: 'task-error', name: 'TaskUpdate', input: {} },
      ]),
      sdkMessage('user', 'results', [
        { type: 'tool_result', tool_use_id: 'todo-error', content: 'failed', is_error: true },
        { type: 'tool_result', tool_use_id: 'list-error', content: 'failed', is_error: true },
        { type: 'tool_result', tool_use_id: 'task-error', content: 'failed', is_error: true },
      ]),
    ]

    expect(projectLarkTurnMessages(messages, 'turn').replies).toEqual([{ kind: 'text', content: '> Thought, read 1 file, called TodoWrite, ListAgents, 2 errors' }])
  })

  it('does not infer thinking duration across assistant message ids or invalid timestamps', () => {
    const thinking = (uuid: string, timestamp: string, id: string) =>
      ({
        ...sdkMessage('assistant', uuid, [{ type: 'thinking', thinking: 'hidden' }]),
        timestamp,
        message: { id, role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }] },
      }) as unknown as SessionMessage
    const boundary = (uuid: string, timestamp: string, id: string) =>
      ({ ...sdkMessage('assistant', uuid, []), timestamp, message: { id, role: 'assistant', content: [] } }) as unknown as SessionMessage

    expect(projectLarkTurnMessages([thinking('a', '2026-09-30T02:00:00Z', 'one'), boundary('b', '2026-09-30T02:00:02Z', 'two')], 'turn').replies).toEqual([{ kind: 'text', content: '> Thought' }])
    expect(projectLarkTurnMessages([thinking('a', 'invalid', 'one'), boundary('b', '2026-09-30T02:00:02Z', 'one')], 'turn').replies).toEqual([{ kind: 'text', content: '> Thought' }])
    expect(projectLarkTurnMessages([thinking('a', '2026-09-30T02:00:03Z', 'one'), boundary('b', '2026-09-30T02:00:02Z', 'one')], 'turn').replies).toEqual([{ kind: 'text', content: '> Thought' }])
  })

  it.each([
    ['In progress', { activity: { owner: 'cotta', phase: 'busy', activeTurnId: 'turn' } }],
    ['Waiting', {}],
    ['Completed', { activity: { owner: null, phase: 'idle', activeTurnId: null }, runState: { phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'turn', outcome: 'success' } } }],
    ['Failed', { activity: { owner: null, phase: 'idle', activeTurnId: null }, runState: { phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'turn', outcome: 'error' } } }],
  ] as const)('renders %s Turn header and footer', (expected, overrides) => {
    const response = { ...timeline([]), ...overrides }
    const turn = response.turns[0]!
    Object.assign(turn, {
      durationMs: expected === 'Completed' || expected === 'Failed' ? 65_000 : undefined,
      durationTimestampMs: expected === 'Completed' ? Date.parse('2026-09-30T02:20:00.000Z') : undefined,
    })
    response.tasks = expected === 'In progress' || expected === 'Completed' ? [{ id: '1', subject: 'Build', activeForm: 'Building…', status: 'in_progress', blockedBy: [] }] : null
    response.liveBackgroundTasks = expected === 'Waiting' ? [{ taskId: 'live', taskType: 'agent' }] : []

    const projected = projectLarkTurnCard(session, '项目', response, identity, 'Asia/Shanghai')
    const json = JSON.stringify(projected.card)
    const footer = projected.card.body.elements.at(-1) as { columns: Array<{ elements: Array<{ text?: { content: string }; icon?: { token: string } }> }> }

    expect(projected.card.header).not.toHaveProperty('text_tag_list')
    expect(footer.columns.at(-1)?.elements[0]).toMatchObject({ icon: { token: 'refresh_outlined' }, hover_tips: { content: 'Refresh' } })
    const footerText = (projected.card.body.elements.at(-2) as { text: { content: string } }).text.content
    if (expected === 'Waiting') expect(footerText).toBe('✻ Waiting for 1 background task to finish')
    else if (expected === 'In progress') expect(footerText).toBe('✻ Building…')
    else expect(footerText).toMatch(expected === 'Completed' ? /^✻ .* for 1m 5s · 09\/30 10:20$/ : /^✻ .* for 1m 5s$/)
    if (expected === 'Completed') expect(footerText).not.toContain('Building')
    expect(json).not.toContain('spark')
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(LARK_CARD_MAX_BYTES)
    expect((json.match(/"tag":/g) ?? []).length).toBeLessThanOrEqual(LARK_CARD_MAX_ELEMENTS)
  })

  it('shows context usage in the latest Turn footer only', () => {
    const contextUsage = { model: 'claude', categories: [], totalTokens: 1000, autoCompactThreshold: null, maxTokens: 2000, percentage: 42.6, updatedAtMs: 1 }
    const response = { ...timeline([]), contextUsage }
    const latestText = (projectLarkTurnCard(session, '项目', response, identity, 'UTC').card.body.elements.at(-2) as { text: { content: string } }).text.content
    expect(latestText).toContain('Ctx 43%')

    const historical = projectLarkTurnCard(session, '项目', response, identity, 'UTC', { firstTurnId: 'first', previousTurnId: 'older', nextTurnId: 'newer', latestTurnId: 'latest' })
    expect(JSON.stringify(historical.card)).not.toContain('Ctx')

    const noUsage = (projectLarkTurnCard(session, '项目', timeline([]), identity, 'UTC').card.body.elements.at(-2) as { text: { content: string } }).text.content
    expect(noUsage).not.toContain('Ctx')
  })

  it('navigates adjacent Turns and keeps historical Turns static', () => {
    const response = timeline([])
    response.tasks = [{ id: '1', subject: 'Build', activeForm: 'Building…', status: 'in_progress', blockedBy: [] }]
    const projected = projectLarkTurnCard(session, '项目', response, identity, 'UTC', { firstTurnId: 'first', previousTurnId: 'older', nextTurnId: 'newer', latestTurnId: 'latest' })
    const footer = projected.card.body.elements.at(-1) as {
      columns: Array<{ elements: Array<{ icon: { token: string }; hover_tips: { content: string }; text?: unknown; behaviors?: Array<{ value: { token: string } }> }> }>
    }
    const buttons = footer.columns.map((column) => column.elements[0]!)

    expect(buttons.map((item) => item.icon.token)).toEqual(['reduce-indentation_outlined', 'left_outlined', 'right_outlined', 'increase-indentation_outlined', 'refresh_outlined'])
    expect(buttons.map((item) => item.hover_tips.content)).toEqual(['First Turn', 'Previous Turn', 'Next Turn', 'Latest Turn', 'Refresh'])
    expect(buttons.every((item) => !('text' in item))).toBe(true)
    expect(buttons.map((item) => decodeLarkCardAction(item.behaviors?.[0]?.value.token ?? '', identity.secret, identity.createdAtMs))).toMatchObject([
      { operation: 'first_turn', turnId: 'turn' },
      { operation: 'previous_turn', turnId: 'turn' },
      { operation: 'next_turn', turnId: 'turn' },
      { operation: 'latest_turn', turnId: 'turn' },
      { operation: 'refresh', turnId: 'turn' },
    ])
    expect(JSON.stringify(footer)).not.toContain('Building')
  })

  it('infers only an unterminated external busy Turn as active', () => {
    const response = timeline([
      sdkMessage('assistant', 'tail', [
        { type: 'thinking', thinking: 'hidden' },
        { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/tmp/a.ts' } },
      ]),
    ])
    response.activity = { owner: 'external', phase: 'busy', activeTurnId: null }
    const activeCard = JSON.stringify(projectLarkTurnCard(session, '项目', response, identity, 'UTC').card)
    expect(activeCard).toContain('> Thinking, reading 1 file')
    expect(activeCard).toContain(`✻ ${turnCookingLabel('turn')}`)

    response.activity.phase = 'waiting'
    expect(JSON.stringify(projectLarkTurnCard(session, '项目', response, identity, 'UTC').card)).toContain('> Thought, read 1 file')

    response.activity.phase = 'busy'
    response.turns[0]!.durationMs = 1
    expect(JSON.stringify(projectLarkTurnCard(session, '项目', response, identity, 'UTC').card)).toContain('> Thought, read 1 file')
  })

  it('prefers historical background waiting only when live data is unavailable, then cooking and stable done verb', () => {
    const response = timeline([])
    const turn = response.turns[0]!
    turn.pendingBackgroundAgentCount = 2
    response.liveBackgroundTasks = []
    response.tasks = null
    expect(JSON.stringify(projectLarkTurnCard(session, '项目', response, identity, 'UTC').card)).not.toContain('Waiting for 2 background tasks')

    response.liveBackgroundTasks = null
    expect(JSON.stringify(projectLarkTurnCard(session, '项目', response, identity, 'UTC').card)).toContain('Waiting for 2 background tasks')
    turn.pendingBackgroundAgentCount = 0
    response.activity = { owner: 'cotta', phase: 'busy', activeTurnId: 'turn' }
    expect(JSON.stringify(projectLarkTurnCard(session, '项目', response, identity, 'UTC').card)).toContain(`✻ ${turnCookingLabel('turn')}`)

    response.activity = { owner: null, phase: 'idle', activeTurnId: null }
    expect(JSON.stringify(projectLarkTurnCard(session, '项目', response, identity, 'UTC').card)).toMatch(/Thought|Baked|Brewed|Churned|Cogitated|Cooked|Crunched|Sautéed|Worked/)
  })

  it('emits signed actions and stays below UTF-8 and element limits', () => {
    const response: ProjectSessionsResponse = {
      project: { id: 'project', name: '项目', path: '/tmp/project', lastActivityAt: 1, worktreeName: 'feature/card-header' },
      sessions: Array.from({ length: 200 }, (_, index) => ({ ...session, id: `session-${index}`, title: `会话${'界'.repeat(500)}`, lastPrompt: `最新问题${'文'.repeat(300)}` })),
      defaultSessionId: null,
      hasMore: true,
      nextCursor: 'next',
    }
    const projected = projectLarkSessionCard(response, [response.project], identity, 'main', false, response.sessions[0], 'UTC')
    const json = JSON.stringify(projected.card)
    expect(json).toMatch(/\d\d\/\d\d \d\d:\d\d/)
    const rows = projected.card.body.elements.filter((element) => element.tag === 'interactive_container') as Array<{
      tag: string
      background_style: string
      behaviors: Array<{ value: { token: string } }>
      elements: Array<{ columns: Array<{ vertical_align?: string; width?: string; elements: Array<{ text: { content: string; text_color: string } }> }> }>
    }>
    const row = rows[0] as {
      tag: string
      background_style: string
      behaviors: Array<{ value: { token: string } }>
      elements: Array<{ columns: Array<{ vertical_align?: string; width?: string; elements: Array<{ text: { content: string; text_color: string } }> }> }>
    }
    const openToken = row.behaviors[0]?.value.token as string
    const footer = projected.card.body.elements.at(-1) as {
      horizontal_align: string
      columns: Array<{ elements: Array<{ text?: { content: string }; icon: { token: string }; hover_tips?: { content: string }; size: string; behaviors: Array<{ value: { token: string } }> }> }>
    }
    const note = footer.columns[0]?.elements[0]
    const refresh = footer.columns.at(-1)?.elements[0]

    expect(projected.card.config).toEqual({
      update_multi: true,
      style: {
        color: {
          'session-item': { light_mode: 'rgba(248,249,250,1)', dark_mode: 'rgba(35,36,38,1)' },
          'session-item-selected': { light_mode: 'rgba(20,86,240,0.10)', dark_mode: 'rgba(64,128,255,0.18)' },
        },
      },
    })
    expect(projected.card.header).toEqual({
      template: 'blue',
      title: { tag: 'plain_text', content: 'Browse Sessions' },
      subtitle: { tag: 'plain_text', content: 'Select a session or start a new one.' },
      icon: { tag: 'standard_icon', token: 'folder_outlined' },
    })
    expect(projected.card.body.elements[0]).toEqual({ tag: 'markdown', content: '**Project**' })
    expect(projected.card.body.elements[1]).toMatchObject({
      tag: 'select_static',
      initial_option: '项目 (feature/card-header)',
      behaviors: [{ type: 'callback', value: {} }],
      options: [{ text: { content: '项目 (feature/card-header)' }, icon: { tag: 'standard_icon', token: 'folder_outlined' } }],
    })
    const selector = projected.card.body.elements[1] as { options: Array<{ value: string }> }
    expect(new Set(selector.options.map(({ value }) => value)).size).toBe(selector.options.length)
    expect(selector.options.map(({ value }) => decodeLarkCardAction(value, identity.secret, identity.createdAtMs))).toMatchObject([
      { operation: 'select_project', projectId: 'project', configVersion: identity.configVersion },
    ])
    expect(projected.card.body.elements[1]).not.toHaveProperty('option')
    expect(projected.card.body.elements[2]).toEqual({
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_spacing: 'small',
      columns: [
        {
          tag: 'column',
          width: '80px',
          vertical_spacing: '0px',
          elements: [
            { tag: 'div', text: { tag: 'plain_text', content: 'Worktree', text_color: 'grey', text_size: 'notation', text_align: 'left', lines: 1 } },
            { tag: 'div', text: { tag: 'plain_text', content: 'Branch', text_color: 'grey', text_size: 'notation', text_align: 'left', lines: 1 } },
            { tag: 'div', text: { tag: 'plain_text', content: 'Directory', text_color: 'grey', text_size: 'notation', text_align: 'left', lines: 1 } },
          ],
        },
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          vertical_spacing: '0px',
          elements: [
            { tag: 'markdown', content: 'feature/​card-​header' },
            { tag: 'markdown', content: 'main' },
            { tag: 'markdown', content: '/​tmp/​project' },
          ],
        },
      ],
    })
    expect(projected.card.body.elements[3]).toEqual({ tag: 'markdown', content: '**Sessions**' })
    expect(row.tag).toBe('interactive_container')
    expect(row).toMatchObject({ vertical_spacing: '0px', background_style: 'session-item-selected', has_border: true, border_color: 'grey' })
    expect(rows[1]?.background_style).toBe('session-item')
    expect(row.elements[0]?.columns.map((column) => column.vertical_align)).toEqual(['top', 'center', 'top'])
    expect(row.elements[0]?.columns[0]?.elements[0]?.text).toMatchObject({ content: '●', text_color: 'grey-300' })
    expect(row.elements).toHaveLength(1)
    expect(row.elements[0]?.columns[1]).toMatchObject({ vertical_spacing: '0px' })
    expect(row.elements[0]?.columns[1]?.elements.map(({ text }) => text.content)).toEqual([`会话${'界'.repeat(77)}…`, `最新问题${'文'.repeat(155)}…`])
    expect(row.elements[0]?.columns[2]?.elements[0]?.text.content).toBe('09:05')
    expect((JSON.stringify(row).match(/"tag":/g) ?? []).length).toBe(13)
    expect(projected.card.body.elements.at(-2)?.tag).not.toBe('hr')
    expect(footer).toMatchObject({ tag: 'column_set', horizontal_align: 'right' })
    expect(note?.text).toMatchObject({ text_color: 'grey', text_size: 'notation' })
    expect(note?.text?.content).toMatch(new RegExp(`^Showing latest ${projected.displayedCount} sessions only · \\d\\d/\\d\\d \\d\\d:\\d\\d$`))
    expect(refresh).toMatchObject({ icon: { tag: 'standard_icon', token: 'refresh_outlined' }, hover_tips: { content: 'Refresh' }, size: 'tiny' })
    expect(refresh).not.toHaveProperty('text')
    expect(decodeLarkCardAction(refresh?.behaviors[0]?.value.token as string, identity.secret, identity.createdAtMs)).toMatchObject({
      operation: 'refresh',
      projectId: 'project',
      loadedCount: response.sessions.length,
    })
    expect(JSON.stringify(footer)).not.toContain('Load more')
    expect(projected.card.body.elements.some((element) => element.tag === 'action')).toBe(false)
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(LARK_CARD_MAX_BYTES)
    expect((json.match(/"tag":/g) ?? []).length).toBeLessThanOrEqual(LARK_CARD_MAX_ELEMENTS)
    expect(projected.atLimit).toBe(true)
    expect(decodeLarkCardAction(openToken, identity.secret, identity.createdAtMs)).toMatchObject({ operation: 'open', projectId: 'project', loadedCount: response.sessions.length })
  })

  it('shows final card size only when debug navigation is enabled', () => {
    const response: ProjectSessionsResponse = {
      project: { id: 'project', name: '项目', path: '/tmp/project', lastActivityAt: 1 },
      sessions: [session],
      defaultSessionId: null,
      hasMore: false,
      nextCursor: null,
    }
    const assertDebug = (card: object) => {
      const json = JSON.stringify(card)
      const match = json.match(/Card ([\d.]+) \/ 30 kB · (\d+) \/ 200 elements/)
      expect(match?.[1]).toBe((Buffer.byteLength(json, 'utf8') / 1_000).toFixed(1))
      expect(match?.[2]).toBe(String((json.match(/"tag":/g) ?? []).length))
    }

    const sessionCard = projectLarkSessionCard(response, [response.project], identity, null, true).card
    const turnCard = projectLarkTurnCard(session, '项目', timeline([]), identity, 'UTC', undefined, true).card
    assertDebug(sessionCard)
    assertDebug(turnCard)
    expect(JSON.stringify(projectLarkSessionCard(response, [response.project], identity).card)).not.toContain(' / 30 kB')
    expect(JSON.stringify(projectLarkTurnCard(session, '项目', timeline([]), identity, 'UTC').card)).not.toContain(' / 30 kB')
  })

  it('maps session ownership, phase, and terminal outcome colors', () => {
    const response: ProjectSessionsResponse = {
      project: { id: 'project', name: '项目', path: '/tmp/project', lastActivityAt: 1 },
      sessions: [
        { ...session, id: 'success', occupiedBy: 'cotta' as const, lastTurnOutcome: 'success' as const },
        { ...session, id: 'error', occupiedBy: 'cotta' as const, lastTurnOutcome: 'error' as const, lastActivityAt: new Date(2026, 8, 29, 23, 59).getTime() },
        { ...session, id: 'busy', occupiedBy: 'external' as const, occupiedStatus: 'busy' as const, lastTurnOutcome: 'success' as const },
        { ...session, id: 'waiting', occupiedBy: 'cotta' as const, occupiedStatus: 'waiting' as const },
        { ...session, id: 'background', occupiedBy: 'cotta' as const, occupiedStatus: 'background' as const },
        { ...session, id: 'cotta-idle', occupiedBy: 'cotta' as const },
        { ...session, id: 'external-idle', occupiedBy: 'external' as const },
      ],
      defaultSessionId: null,
      hasMore: false,
      nextCursor: null,
    }
    const rows = projectLarkSessionCard(response, [response.project], identity).card.body.elements.filter((element) => element.tag === 'interactive_container') as Array<{
      elements: Array<{ columns: Array<{ vertical_align?: string; width?: string; elements: Array<{ text: { content: string; text_color: string } }> }> }>
    }>
    const colors = rows.map((row) => row.elements[0]?.columns[0]?.elements[0]?.text.text_color)

    expect(colors).toEqual(['green-400', 'red-400', 'orange-350', 'blue-400', 'orange-350', 'grey-300', 'grey-600'])
    expect(rows[1]?.elements[0]?.columns[2]?.elements[0]?.text.content).toBe('09-29')
  })

  it('adds an out-of-window selection without changing the fetched window', () => {
    const response: ProjectSessionsResponse = {
      project: { id: 'project', name: '项目', path: '/tmp/project', lastActivityAt: 1 },
      sessions: [
        { ...session, id: 'latest' },
        { ...session, id: 'second' },
      ],
      defaultSessionId: null,
      hasMore: true,
      nextCursor: 'next',
    }
    const selected = { ...session, id: 'selected-old' }
    const projected = projectLarkSessionCard(response, [response.project], identity, undefined, false, selected)
    const json = JSON.stringify(projected.card)
    const rows = projected.card.body.elements.filter(({ tag }) => tag === 'interactive_container') as Array<{ background_style: string; behaviors: Array<{ value: { token: string } }> }>
    const actions = rows.map((row) => decodeLarkCardAction(row.behaviors[0]?.value.token as string, identity.secret, identity.createdAtMs))

    expect(actions.map((action) => action?.sessionId)).toEqual(['latest', 'second', selected.id])
    expect(actions.every((action) => action?.loadedCount === response.sessions.length)).toBe(true)
    expect(rows.at(-1)?.background_style).toBe('session-item-selected')
    expect(projected.displayedCount).toBe(3)
    expect(projected.atLimit).toBe(false)
    expect(json).toContain('Load more')
    expect(json).not.toContain('Showing latest')
  })

  it('keeps an out-of-window selected session within the card budget', () => {
    const response: ProjectSessionsResponse = {
      project: { id: 'project', name: '项目', path: '/tmp/project', lastActivityAt: 1 },
      sessions: Array.from({ length: 200 }, (_, index) => ({ ...session, id: `session-${index}`, title: `会话 ${index}`, lastPrompt: `问题 ${index}` })),
      defaultSessionId: null,
      hasMore: true,
      nextCursor: 'next',
    }
    const selected = { ...session, id: 'selected-old', title: '旧会话', lastPrompt: '旧问题' }
    const projected = projectLarkSessionCard(response, [response.project], identity, undefined, false, selected)
    const rows = projected.card.body.elements.filter(({ tag }) => tag === 'interactive_container') as Array<{
      background_style: string
      behaviors: Array<{ value: { token: string } }>
    }>
    const actions = rows.map((row) => decodeLarkCardAction(row.behaviors[0]?.value.token as string, identity.secret, identity.createdAtMs))
    const json = JSON.stringify(projected.card)

    expect(rows.at(-1)?.background_style).toBe('session-item-selected')
    expect(actions.filter((action) => action?.sessionId === selected.id)).toHaveLength(1)
    expect(actions.every((action) => action?.loadedCount === response.sessions.length)).toBe(true)
    expect(projected.displayedCount).toBe(rows.length)
    expect(json).toContain(`Showing latest ${rows.length - 1} sessions + selected session`)
    expect((json.match(/"tag":/g) ?? []).length).toBeLessThanOrEqual(LARK_CARD_MAX_ELEMENTS)
    expect(projected.atLimit).toBe(true)
  })

  it('shows Load more before Refresh when more sessions fit', () => {
    const response: ProjectSessionsResponse = {
      project: { id: 'project', name: '项目', path: '/tmp/project', lastActivityAt: 1 },
      sessions: [session],
      defaultSessionId: null,
      hasMore: true,
      nextCursor: 'next',
    }
    const projected = projectLarkSessionCard(response, [response.project], identity, undefined, false, session)
    const footer = projected.card.body.elements.at(-1) as {
      columns: Array<{ elements: Array<{ icon: { token: string }; hover_tips: { content: string }; size: string; behaviors: Array<{ value: { token: string } }> }> }>
    }
    const buttons = footer.columns.map((column) => column.elements[0]).filter((item) => item?.behaviors)

    expect(buttons.map((item) => item?.hover_tips.content)).toEqual(['New', 'Load more', 'Refresh'])
    expect(buttons.map((item) => item?.icon.token)).toEqual(['add_outlined', 'expand-items_outlined', 'refresh_outlined'])
    expect(buttons.map((item) => item?.size)).toEqual(['tiny', 'tiny', 'tiny'])
    expect(decodeLarkCardAction(buttons[0]?.behaviors[0]?.value.token as string, identity.secret, identity.createdAtMs)).toMatchObject({ operation: 'new' })
    expect(decodeLarkCardAction(buttons[1]?.behaviors[0]?.value.token as string, identity.secret, identity.createdAtMs)).toMatchObject({ operation: 'more' })
    expect(decodeLarkCardAction(buttons[2]?.behaviors[0]?.value.token as string, identity.secret, identity.createdAtMs)).toMatchObject({ operation: 'refresh' })
  })

  it('renders Permission decision controls while streaming', () => {
    const pending = { requestId: 'req', toolUseID: 'tool', toolName: 'Bash', input: { command: 'ls' } }
    const card = projectLarkResultCard('Result', '项目', 'session', 'turn', [], identity, true, undefined, pending)
    expect(card.config.streaming_mode).toBe(true)
    const json = JSON.stringify(card)
    expect(json).toContain('Do you want to run this command?')
    const tokens = collectButtonTokens(card).map((token) => decodeLarkCardAction(token, identity.secret, identity.createdAtMs))
    expect(tokens.map((action) => action?.operation)).toEqual(expect.arrayContaining(['allow', 'deny']))
    expect(tokens.every((action) => action?.card === 'permission' && action.requestId === 'req' && action.toolUseID === 'tool')).toBe(true)
  })

  it('renders single-question AskUserQuestion as a toggle card with Submit', () => {
    const pending = {
      requestId: 'req',
      toolUseID: 'tool',
      toolName: 'AskUserQuestion',
      input: { questions: [{ question: 'Ship?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
    }
    const card = projectLarkResultCard('Result', '项目', 'session', 'turn', [], identity, true, undefined, pending, { answers: new Map() })
    expect(collectButtonLabels(card)).toEqual(['Yes', 'No', 'Submit', 'Cancel'])
    const tokens = collectButtonTokens(card).map((token) => decodeLarkCardAction(token, identity.secret, identity.createdAtMs))
    expect(tokens.map((action) => action?.operation)).toEqual(['answer', 'answer', 'submit_answers', 'cancel'])
    expect(tokens.filter((action) => action?.operation === 'answer').map((action) => action?.optionIndex)).toEqual([0, 1])
  })

  it('renders multi-select AskUserQuestion as a toggle card', () => {
    const pending = {
      requestId: 'req',
      toolUseID: 'tool',
      toolName: 'AskUserQuestion',
      input: { questions: [{ question: 'Pick', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }] },
    }
    const card = projectLarkResultCard('Result', '项目', 'session', 'turn', [], identity, true, undefined, pending, { answers: new Map([['Pick', ['A', 'B']]]) })
    expect(collectMarkdown(card).join('\n')).toContain('multi-select')
    expect(collectButtonLabels(card)).toEqual(['A', 'B', 'Submit', 'Cancel'])
    // both options already selected render as primary
    const optionTypes = collectButtons(card)
      .filter((button) => button.text && (button.text as Record<string, unknown>).content !== undefined && ['A', 'B'].includes((button.text as Record<string, unknown>).content as string))
      .map((button) => button.type)
    expect(optionTypes).toEqual(['primary', 'primary'])
  })

  it('lists every question on one card for multi-question AskUserQuestion', () => {
    const pending = {
      requestId: 'req',
      toolUseID: 'tool',
      toolName: 'AskUserQuestion',
      input: {
        questions: [
          { question: 'Q1', options: [{ label: 'A' }, { label: 'B' }] },
          { question: 'Q2', options: [{ label: 'C' }, { label: 'D' }] },
        ],
      },
    }
    const card = projectLarkResultCard('Result', '项目', 'session', 'turn', [], identity, true, undefined, pending, {
      answers: new Map([
        ['Q1', ['A']],
        ['Q2', ['C']],
      ]),
    })
    const markdownText = collectMarkdown(card).join('\n')
    expect(markdownText).toContain('Q1')
    expect(markdownText).toContain('Q2')
    expect(collectButtonLabels(card)).toEqual(['A', 'B', 'C', 'D', 'Submit', 'Cancel'])
    const ops = collectButtonTokens(card).map((token) => decodeLarkCardAction(token, identity.secret, identity.createdAtMs)?.operation)
    expect(ops).toEqual(['answer', 'answer', 'answer', 'answer', 'submit_answers', 'cancel'])
    const answerActions = collectButtonTokens(card)
      .map((token) => decodeLarkCardAction(token, identity.secret, identity.createdAtMs))
      .filter((action) => action?.operation === 'answer')
    expect(answerActions.map((action) => action?.questionIndex)).toEqual([0, 0, 1, 1])
    // selected options highlight as primary across both questions
    const selectedLabels = collectButtons(card)
      .filter((button) => button.type === 'primary' && button.text)
      .map((button) => (button.text as Record<string, unknown>).content)
    expect(selectedLabels).toEqual(['A', 'C', 'Submit'])
  })

  it('falls back to Web when a question has no parseable options', () => {
    const pending = {
      requestId: 'req',
      toolUseID: 'tool',
      toolName: 'AskUserQuestion',
      input: {
        questions: [
          { question: 'Q1', options: [{ label: 'A' }] },
          { question: 'Q2', options: [] },
        ],
      },
    }
    const card = projectLarkResultCard('Result', '项目', 'session', 'turn', [], identity, true, undefined, pending, { answers: new Map() })
    expect(JSON.stringify(card)).toContain('This question needs Cotta Web to answer.')
    expect(collectButtonTokens(card)).toHaveLength(0)
  })

  it('renders a URL-type View Detail button when a Detail origin is configured', () => {
    const key = randomBytes(32)
    const detailIdentity = { ...identity, detail: { origin: 'https://cotta.example.com', key } }
    const detailMessages = [sdkMessage('user', 'turn', [{ type: 'text', text: 'hello' }]), sdkMessage('assistant', 'a', [{ type: 'text', text: 'hi' }])]
    const projected = projectLarkTurnCard(session, '项目', timeline(detailMessages), detailIdentity, 'Asia/Shanghai')
    const footer = projected.card.body.elements.at(-1) as {
      columns: Array<{ elements: Array<{ hover_tips: { content: string }; behaviors: Array<{ type: string; default_url?: string }> }> }>
    }
    const viewDetail = footer.columns.flatMap((column) => column.elements).find((element) => element.hover_tips?.content === 'View Detail')
    expect(viewDetail).toBeDefined()
    const behavior = viewDetail?.behaviors[0]
    expect(behavior?.type).toBe('open_url')
    const url = behavior?.default_url ?? ''
    expect(url.startsWith('https://cotta.example.com/detail/')).toBe(true)
    expect(decodeDetailToken(url.slice('https://cotta.example.com/detail/'.length), key)).toEqual({ projectId: identity.projectId, sessionId: session.id, turnId: 'turn' })
  })

  it('omits View Detail when no Detail origin is configured', () => {
    const detailMessages = [sdkMessage('user', 'turn', [{ type: 'text', text: 'hello' }]), sdkMessage('assistant', 'a', [{ type: 'text', text: 'hi' }])]
    const json = JSON.stringify(projectLarkTurnCard(session, '项目', timeline(detailMessages), identity, 'Asia/Shanghai').card)
    expect(json).not.toContain('View Detail')
    expect(json).not.toContain('open_url')
  })
})

function collectButtons(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(collectButtons)
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const self = record.tag === 'button' ? [record] : []
  return [...self, ...Object.values(record).flatMap(collectButtons)]
}

function collectButtonTokens(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectButtonTokens)
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const token = record.tag === 'button' && Array.isArray(record.behaviors) ? ((record.behaviors[0] as Record<string, unknown>)?.value as Record<string, unknown>)?.token : undefined
  return [...(typeof token === 'string' ? [token] : []), ...Object.values(record).flatMap(collectButtonTokens)]
}

function collectButtonLabels(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectButtonLabels)
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const label = record.tag === 'button' ? ((record.text as Record<string, unknown> | undefined)?.content ?? (record.hover_tips as Record<string, unknown> | undefined)?.content) : undefined
  return [...(typeof label === 'string' ? [label] : []), ...Object.values(record).flatMap(collectButtonLabels)]
}

function collectMarkdown(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectMarkdown)
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const content = record.tag === 'markdown' && typeof record.content === 'string' ? [record.content] : []
  return [...content, ...Object.values(record).flatMap(collectMarkdown)]
}
