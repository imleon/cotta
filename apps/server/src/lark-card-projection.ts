import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  approvalDescription,
  approvalTitle,
  effectiveActiveTurnId,
  formatTurnDuration,
  hasTerminalEvidence,
  type ProjectSessionsResponse,
  type ProjectSummary,
  type SessionSummary,
  type SessionTimelineResponse,
  stableTurnVerb,
  type ToolApprovalRequest,
  timelineInterruptMarker,
  timelineLocalCommandFeedback,
  timelineToolIsHidden,
  turnActiveTaskLabel,
  turnCookingLabel,
  turnDurationLabel,
  turnPendingAgentLabel,
} from '@cotta/shared'
import { encodeDetailToken } from './detail-token.js'
import { encodeLarkCardAction, type LarkCardAction } from './lark-card-action.js'

export const LARK_CARD_MAX_BYTES = 30_000
export const LARK_CARD_MAX_ELEMENTS = 200

const cardBudgetBytes = 28_000
const cardBudgetElements = 190
const turnUserBudgetBytes = 6_000
const textLimit = 1_200

type CardElement = Record<string, unknown>
export type LarkCard = { schema: '2.0'; config: { update_multi: true; streaming_mode?: boolean; summary?: { content: string }; style?: object }; header?: object; body: { elements: CardElement[] } }
export type CardIdentity = Pick<LarkCardAction, 'botId' | 'configVersion' | 'projectId' | 'createdAtMs'> & { secret: string; renderedAtMs?: number; detail?: { origin: string; key: Buffer } }

function shorten(value: string, limit = textLimit): string {
  const text = value.trim()
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

function wrappable(value: string): string {
  return value.trim().replace(/([/_.-])/g, '$1​')
}

function markdown(content: string, truncate = true): CardElement {
  return { tag: 'markdown', content: truncate ? shorten(content) : content.trim() }
}

function userMessage(content: string): CardElement {
  return {
    tag: 'column_set',
    background_style: 'turn-user-message',
    columns: [{ tag: 'column', width: 'weighted', weight: 1, padding: '8px 12px', elements: [markdown(`💬 ${content}`, false)] }],
  }
}

function text(content: string, textColor = 'default', textSize = 'normal', textAlign = 'left'): CardElement {
  return { tag: 'div', text: { tag: 'plain_text', content, text_color: textColor, text_size: textSize, text_align: textAlign, lines: 1 } }
}

function button(label: string, token: string, type = 'default', icon: string, size?: string): CardElement {
  return {
    tag: 'button',
    icon: { tag: 'standard_icon', token: icon },
    hover_tips: { tag: 'plain_text', content: label },
    ...(size ? { size } : {}),
    type,
    behaviors: [{ type: 'callback', value: { token } }],
  }
}

/** Button that opens a URL directly in the browser — no card action callback round-trip. */
function urlButton(label: string, url: string, type = 'default', icon: string, size?: string): CardElement {
  return {
    tag: 'button',
    icon: { tag: 'standard_icon', token: icon },
    hover_tips: { tag: 'plain_text', content: label },
    ...(size ? { size } : {}),
    type,
    behaviors: [{ type: 'open_url', default_url: url }],
  }
}

function footer(buttons: CardElement[], note?: string): CardElement[] {
  return [
    { tag: 'hr' },
    {
      tag: 'column_set',
      horizontal_align: 'right',
      columns: [
        ...(note ? [{ tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [text(note, 'grey', 'notation')] }] : []),
        ...buttons.map((item) => ({ tag: 'column', width: 'auto', elements: [item] })),
      ],
    },
  ]
}

function card(title: string, elements: CardElement[], tag?: string, subtitle?: string, includeUserStyle = true): LarkCard {
  return {
    schema: '2.0',
    config: { update_multi: true, ...(includeUserStyle ? { style: { color: { 'turn-user-message': { light_mode: 'rgba(248,249,250,1)', dark_mode: 'rgba(35,36,38,1)' } } } } : {}) },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: shorten(title, 120) },
      icon: { tag: 'standard_icon', token: 'submit-feedback_outlined' },
      ...(subtitle ? { subtitle: { tag: 'plain_text', content: shorten(subtitle, 120) } } : {}),
      ...(tag ? { text_tag_list: [{ tag: 'text_tag', text: { tag: 'plain_text', content: shorten(tag, 60) }, color: 'blue' }] } : {}),
    },
    body: { elements },
  }
}

function sessionListCard(project: ProjectSessionsResponse['project'], projects: ProjectSummary[], elements: CardElement[], identity: CardIdentity, branch?: string | null): LarkCard {
  const details = [project.worktreeName ? ['Worktree', project.worktreeName] : null, branch ? ['Branch', branch] : null, project.path ? ['Directory', project.path] : null].filter(
    (value): value is [string, string] => !!value,
  )
  const detailGrid = {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: 'small',
    columns: [
      { tag: 'column', width: '80px', vertical_spacing: '0px', elements: details.map(([label]) => text(label, 'grey', 'notation')) },
      { tag: 'column', width: 'weighted', weight: 1, vertical_spacing: '0px', elements: details.map(([, value]) => markdown(wrappable(value))) },
    ],
  }
  const selector = {
    tag: 'select_static',
    placeholder: { tag: 'plain_text', content: 'Select Project' },
    initial_option: shorten(`${project.name}${project.worktreeName ? ` (${project.worktreeName})` : ''}`, 80),
    behaviors: [{ type: 'callback', value: {} }],
    options: projects.map((item) => ({
      text: { tag: 'plain_text', content: shorten(`${item.name}${item.worktreeName ? ` (${item.worktreeName})` : ''}`, 80) },
      icon: { tag: 'standard_icon', token: 'folder_outlined' },
      value: action({ ...identity, projectId: item.id }, { card: 'sessions', operation: 'select_project' }),
    })),
  }
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      style: {
        color: {
          'session-item': { light_mode: 'rgba(248,249,250,1)', dark_mode: 'rgba(35,36,38,1)' },
          'session-item-selected': { light_mode: 'rgba(20,86,240,0.10)', dark_mode: 'rgba(64,128,255,0.18)' },
        },
      },
    },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: 'Browse Sessions' },
      subtitle: { tag: 'plain_text', content: 'Select a session or start a new one.' },
      icon: { tag: 'standard_icon', token: 'folder_outlined' },
    },
    body: {
      elements: [markdown('**Project**'), selector, ...(details.length ? [detailGrid] : []), markdown('**Sessions**'), ...elements],
    },
  }
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function elementCount(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((count, item) => count + elementCount(item), 0)
  if (!value || typeof value !== 'object') return 0
  const record = value as Record<string, unknown>
  return (typeof record.tag === 'string' ? 1 : 0) + Object.values(record).reduce<number>((count, item) => count + elementCount(item), 0)
}

function renderWithDebug(showDebugNav: boolean, render: (note?: string) => LarkCard): LarkCard {
  if (!showDebugNav) return render()
  let note = 'Card 0.0 / 30 kB · 0 / 200 elements'
  for (;;) {
    const value = render(note)
    const next = `Card ${(bytes(value) / 1_000).toFixed(1)} / 30 kB · ${elementCount(value)} / ${LARK_CARD_MAX_ELEMENTS} elements`
    if (next === note) return value
    note = next
  }
}

function fitsCard(value: LarkCard): boolean {
  return elementCount(value) <= cardBudgetElements && bytes(value) < cardBudgetBytes
}

function longestPrefix(content: string, accepts: (value: string) => boolean): string | null {
  const characters = Array.from(content.trim())
  let low = 0
  let high = characters.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (accepts(`${characters.slice(0, middle).join('')}…`)) low = middle
    else high = middle - 1
  }
  const value = `${characters.slice(0, low).join('')}…`
  return accepts(value) ? value : null
}

function joinNotes(...notes: Array<string | undefined>): string | undefined {
  const values = notes.filter((value): value is string => !!value)
  return values.length ? values.join(' · ') : undefined
}

function action(identity: CardIdentity, value: Omit<LarkCardAction, 'version' | 'botId' | 'configVersion' | 'projectId' | 'createdAtMs'>): string {
  return encodeLarkCardAction({ version: 1, botId: identity.botId, configVersion: identity.configVersion, projectId: identity.projectId, createdAtMs: identity.createdAtMs, ...value }, identity.secret)
}

function time(value: number | undefined, timeZone: string): string {
  if (value === undefined) return 'Unknown'
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(value).map(({ type, value }) => [type, value]),
  )
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`
}

function status(session: SessionSummary): { label: string; color: string } {
  if (session.occupiedBy === 'cotta' && session.occupiedStatus === 'idle') {
    if (session.lastTurnOutcome === 'success') return { label: 'Completed', color: 'green-400' }
    if (session.lastTurnOutcome === 'error') return { label: 'Failed', color: 'red-400' }
  }
  if (session.occupiedStatus === 'waiting') return { label: 'Waiting', color: 'blue-400' }
  if (session.occupiedStatus === 'busy' || session.occupiedStatus === 'background') return { label: session.occupiedStatus === 'busy' ? 'Running' : 'Background', color: 'orange-350' }
  return { label: 'Idle', color: session.occupiedBy === 'external' ? 'grey-600' : 'grey-300' }
}

function sessionTime(value: number | undefined, now: number): string {
  if (value === undefined) return 'Unknown'
  const date = new Date(value)
  const current = new Date(now)
  const pad = (part: number) => String(part).padStart(2, '0')
  return date.getFullYear() === current.getFullYear() && date.getMonth() === current.getMonth() && date.getDate() === current.getDate()
    ? `${pad(date.getHours())}:${pad(date.getMinutes())}`
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function sessionRow(session: SessionSummary, token: string, now: number, selected: boolean): CardElement {
  const state = status(session)
  return {
    tag: 'interactive_container',
    width: 'fill',
    padding: '8px 12px',
    background_style: selected ? 'session-item-selected' : 'session-item',
    has_border: true,
    border_color: 'grey',
    corner_radius: '6px',
    vertical_spacing: '0px',
    behaviors: [{ type: 'callback', value: { token } }],
    elements: [
      {
        tag: 'column_set',
        flex_mode: 'none',
        horizontal_spacing: 'small',
        columns: [
          { tag: 'column', width: 'auto', vertical_align: 'top', elements: [text('●', state.color, 'normal')] },
          {
            tag: 'column',
            width: 'weighted',
            weight: 1,
            vertical_align: 'center',
            vertical_spacing: '0px',
            elements: [text(shorten(session.title, 80)), ...(session.lastPrompt ? [text(shorten(session.lastPrompt, 160), 'grey', 'notation')] : [])],
          },
          { tag: 'column', width: 'auto', vertical_align: 'top', elements: [text(sessionTime(session.lastActivityAt, now), 'grey', 'normal', 'right')] },
        ],
      },
    ],
  }
}

function messageObject(message: SessionMessage): Record<string, unknown> | null {
  return typeof message.message === 'object' && message.message !== null ? (message.message as Record<string, unknown>) : null
}

function contentBlocks(message: SessionMessage): unknown[] {
  const content = messageObject(message)?.content
  return typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
}

export type LarkTurnReply = { kind: 'markdown' | 'text'; content: string }

type LarkActivity = { thinkingMs: number; hasThinking: boolean; searches: number; reads: Set<string>; codegraphs: number; tools: Map<string, number>; errors: number }

function timestampMs(message: SessionMessage): number | null {
  const value = (message as SessionMessage & { timestamp?: unknown }).timestamp
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function assistantMessageId(message: SessionMessage): string | null {
  const id = messageObject(message)?.id
  return typeof id === 'string' ? id : null
}

function toolErrors(messages: SessionMessage[]): Set<string> {
  const errors = new Set<string>()
  for (const message of messages) {
    for (const raw of contentBlocks(message)) {
      if (!raw || typeof raw !== 'object') continue
      const block = raw as Record<string, unknown>
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : message.parent_tool_use_id
      if (id && block.type === 'tool_result' && (block.is_error === true || block.is_err === true)) errors.add(id)
    }
  }
  return errors
}

function activitySummary(activity: LarkActivity, active: boolean): string {
  const parts: string[] = []
  if (activity.hasThinking) parts.push(activity.thinkingMs > 0 ? `${active ? 'thinking' : 'thought'} for ${formatTurnDuration(Math.max(1000, activity.thinkingMs))}` : active ? 'thinking' : 'thought')
  if (activity.searches) parts.push(`${active ? 'searching' : 'searched'} for ${activity.searches} ${activity.searches === 1 ? 'pattern' : 'patterns'}`)
  if (activity.reads.size) parts.push(`${active ? 'reading' : 'read'} ${activity.reads.size} ${activity.reads.size === 1 ? 'file' : 'files'}`)
  if (activity.codegraphs) parts.push(`${active ? 'calling' : 'called'} MCP Codegraph${activity.codegraphs > 1 ? ` ${activity.codegraphs} times` : ''}`)
  if (activity.tools.size) {
    const tools = [...activity.tools].map(([name, count]) => `${shorten(name, 80)}${count > 1 ? ` ${count} times` : ''}`).join(', ')
    parts.push(`${active ? 'calling' : 'called'} ${tools}`)
  }
  if (activity.errors) parts.push(`${activity.errors} ${activity.errors === 1 ? 'error' : 'errors'}`)
  const summary = parts.join(', ')
  return `> ${summary.charAt(0).toUpperCase()}${summary.slice(1)}`
}

/** Projects official Agent SDK SessionMessage transcript records into a compact, read-only summary. */
export function projectLarkTurnMessages(messages: SessionMessage[], primaryUserUuid: string, active = false): { primary: string[]; replies: LarkTurnReply[] } {
  const primary: string[] = []
  const replies: LarkTurnReply[] = []
  const errors = toolErrors(messages)
  const assistantMessages = messages.filter((message) => message.type === 'assistant')
  const thinkingDurations = new Map<SessionMessage, number>()
  for (let index = 0; index < assistantMessages.length - 1; index += 1) {
    const current = assistantMessages[index]
    const next = assistantMessages[index + 1]
    if (!current || !next) continue
    const start = timestampMs(current)
    const end = timestampMs(next)
    if (assistantMessageId(current) && assistantMessageId(current) === assistantMessageId(next) && start !== null && end !== null && end >= start) thinkingDurations.set(current, end - start)
  }

  let activity: LarkActivity | null = null
  const timedThinkingMessages = new Set<SessionMessage>()
  const flush = (isTail = false) => {
    if (!activity) return
    replies.push({ kind: 'text', content: activitySummary(activity, active && isTail) })
    activity = null
  }
  const addActivity = () => (activity ??= { thinkingMs: 0, hasThinking: false, searches: 0, reads: new Set<string>(), codegraphs: 0, tools: new Map<string, number>(), errors: 0 })

  for (const message of messages) {
    if (message.uuid === primaryUserUuid) {
      const interrupt = timelineInterruptMarker(message)
      if (interrupt) {
        primary.push(interrupt.text)
        continue
      }
    }
    if (timelineLocalCommandFeedback(message)) continue
    for (const raw of contentBlocks(message)) {
      if (!raw || typeof raw !== 'object') continue
      const block = raw as Record<string, unknown>
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        if (message.type === 'user' && message.uuid === primaryUserUuid) primary.push(block.text.trim())
        else if (message.type === 'assistant') {
          flush()
          replies.push({ kind: 'markdown', content: block.text.trim() })
        }
        continue
      }
      if (message.type !== 'assistant') continue
      if (block.type === 'thinking') {
        const item = addActivity()
        item.hasThinking = true
        if (!timedThinkingMessages.has(message)) {
          item.thinkingMs += thinkingDurations.get(message) ?? 0
          timedThinkingMessages.add(message)
        }
        continue
      }
      if (block.type !== 'tool_use' || typeof block.name !== 'string') continue
      const hasError = typeof block.id === 'string' && errors.has(block.id)
      if (timelineToolIsHidden(block.name, hasError)) continue
      const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : null
      const item = addActivity()
      if (block.name === 'Glob' || block.name === 'Grep') item.searches += 1
      else if (block.name === 'Read') {
        if (typeof input?.file_path === 'string' && input.file_path) item.reads.add(input.file_path)
      } else if (block.name === 'mcp__codegraph__codegraph_explore') item.codegraphs += 1
      else item.tools.set(block.name, (item.tools.get(block.name) ?? 0) + 1)
      if (hasError) item.errors += 1
    }
  }
  flush(true)
  return { primary, replies }
}

export function projectLarkSessionCard(
  response: ProjectSessionsResponse,
  projects: ProjectSummary[],
  identity: CardIdentity,
  branch?: string | null,
  showDebugNav = false,
  selectedSession?: SessionSummary,
  timeZone = 'UTC',
): { card: LarkCard; displayedCount: number; atLimit: boolean } {
  const now = identity.renderedAtMs ?? identity.createdAtMs
  const selectedSessionId = selectedSession?.id
  const dataAsOf = time(now, timeZone)
  const controls = (loadedCount: number, showMore: boolean, note?: string, debug?: string) => {
    const items: CardElement[] = [button('New', action(identity, { card: 'sessions', operation: 'new', loadedCount }), 'default', 'add_outlined', 'tiny')]
    if (showMore) items.push(button('Load more', action(identity, { card: 'sessions', operation: 'more', loadedCount }), 'default', 'expand-items_outlined', 'tiny'))
    items.push(button('Refresh', action(identity, { card: 'sessions', operation: 'refresh', loadedCount }), 'default', 'refresh_outlined', 'tiny'))
    return footer(items, joinNotes(note, dataAsOf, debug)).slice(1)
  }
  const fetchedCount = response.sessions.length
  const render = (sessions: SessionSummary[], displayedFetchedCount: number, atLimit: boolean, hasExtraSelected = false) => {
    const rows = sessions.map((session) =>
      sessionRow(session, action(identity, { card: 'sessions', operation: 'open', sessionId: session.id, loadedCount: fetchedCount }), now, session.id === selectedSessionId),
    )
    const note = atLimit
      ? hasExtraSelected
        ? `Showing latest ${displayedFetchedCount} sessions + selected session`
        : `Showing latest ${displayedFetchedCount} sessions only`
      : !response.hasMore
        ? 'All results loaded'
        : undefined
    return renderWithDebug(showDebugNav, (debug) => sessionListCard(response.project, projects, [...rows, ...controls(fetchedCount, response.hasMore && !atLimit, note, debug)], identity, branch))
  }

  const visible: SessionSummary[] = []
  let atLimit = false
  for (const session of response.sessions) {
    const candidate = [...visible, session]
    if (!fitsCard(render(candidate, candidate.length, candidate.length < fetchedCount))) {
      atLimit = true
      break
    }
    visible.push(session)
  }
  const selectedInFetched = Boolean(selectedSession && response.sessions.some(({ id }) => id === selectedSession.id))
  const hasExtraSelected = Boolean(selectedSession && !selectedInFetched)
  let displayedFetchedCount = visible.length
  if (selectedSession && !visible.some(({ id }) => id === selectedSession.id)) {
    visible.push(selectedSession)
    if (selectedInFetched) displayedFetchedCount += 1
    while (visible.length > 1 && !fitsCard(render(visible, displayedFetchedCount, atLimit, hasExtraSelected))) {
      visible.splice(-2, 1)
      displayedFetchedCount -= 1
      atLimit = true
    }
    if (!fitsCard(render(visible, displayedFetchedCount, atLimit, hasExtraSelected))) throw new Error('Selected session does not fit in Lark card')
  }

  const displayedCount = visible.length
  return { card: render(visible, displayedFetchedCount, atLimit, hasExtraSelected), displayedCount, atLimit }
}

type TurnRenderOptions = { result?: { replies: LarkTurnReply[]; streaming: boolean; turnId: string } }

function fitReplies(
  replies: LarkTurnReply[],
  replyElement: (reply: LarkTurnReply, content?: string, index?: number) => CardElement,
  prefix: CardElement[],
  emptyReply: CardElement,
  fits: (elements: CardElement[]) => boolean,
): { elements: CardElement[]; atLimit: boolean } {
  const completeReplies = replies.length ? replies.map((reply, index) => replyElement(reply, reply.content, index)) : [emptyReply]
  if (fits([...prefix, ...completeReplies])) return { elements: [...prefix, ...completeReplies], atLimit: false }

  const omitted = markdown('_Earlier Turn content omitted due to card display limit_')
  const renderedReplies: CardElement[] = []
  for (let index = replies.length - 1; index >= 0; index -= 1) {
    const reply = replies[index]
    if (!reply) continue
    const item = replyElement(reply, reply.content, index)
    const candidate = [...prefix, omitted, item, ...renderedReplies]
    if (fits(candidate)) {
      renderedReplies.unshift(item)
      continue
    }
    const truncated = longestPrefix(reply.content, (content) => fits([...prefix, omitted, replyElement(reply, content, index), ...renderedReplies]))
    if (truncated) renderedReplies.unshift(replyElement(reply, truncated, index))
    break
  }
  return { elements: [...prefix, omitted, ...(renderedReplies.length ? renderedReplies : [emptyReply])], atLimit: true }
}

function labeledButton(label: string, token: string, type = 'default', size?: string): CardElement {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: shorten(label, 120) },
    ...(size ? { size } : {}),
    type,
    behaviors: [{ type: 'callback', value: { token } }],
  }
}

type ParsedQuestion = { key: string; multiSelect: boolean; options: Array<{ label: string }> }

function parseQuestion(question: unknown): ParsedQuestion | null {
  if (!question || typeof question !== 'object') return null
  const record = question as Record<string, unknown>
  if (!Array.isArray(record.options)) return null
  const options = record.options.flatMap((option) => {
    const label = option && typeof option === 'object' ? (option as Record<string, unknown>).label : undefined
    return typeof label === 'string' && label ? [{ label }] : []
  })
  if (options.length === 0 || options.length !== record.options.length) return null
  return { key: typeof record.question === 'string' ? record.question : '', multiSelect: record.multiSelect === true, options }
}

/** One screen per question, toggle options, answered server-side; null if any question is invalid or keys are empty/collide (falls back to Web). */
export function askUserQuestionList(pending: ToolApprovalRequest): ParsedQuestion[] | null {
  const questions = Array.isArray(pending.input.questions) ? pending.input.questions : null
  if (!questions || questions.length === 0) return null
  const parsed: ParsedQuestion[] = []
  const keys = new Set<string>()
  for (const question of questions) {
    const entry = parseQuestion(question)
    if (!entry?.key || keys.has(entry.key)) return null
    keys.add(entry.key)
    parsed.push(entry)
  }
  return parsed
}

export type QuestionNav = { answers: Map<string, string[]> }

/** Renders in-card Permission / AskUserQuestion controls; unparseable questions fall back to Web. */
function decisionBlock(pending: ToolApprovalRequest, identity: CardIdentity, sessionId: string, turnId: string, questionNav?: QuestionNav): CardElement[] {
  const base = { card: 'permission' as const, sessionId, turnId, requestId: pending.requestId, toolUseID: pending.toolUseID }
  const buttons = (items: CardElement[]) => [{ tag: 'column_set', horizontal_align: 'left', columns: items.map((item) => ({ tag: 'column', width: 'auto', elements: [item] })) }]
  if (pending.toolName === 'AskUserQuestion') {
    const list = askUserQuestionList(pending)
    if (!list) return [{ tag: 'hr' }, markdown('**AskUserQuestion**'), markdown('_This question needs Cotta Web to answer._')]
    const answers = questionNav?.answers ?? new Map<string, string[]>()
    return [
      { tag: 'hr' },
      ...list.flatMap((question, questionIndex) => {
        const selected = answers.get(question.key) ?? []
        const heading = `**${shorten(question.key || 'AskUserQuestion', 200)}**${question.multiSelect ? ' · multi-select' : ''}`
        return [
          markdown(heading),
          ...buttons(
            question.options.map((option, optionIndex) =>
              labeledButton(option.label, action(identity, { ...base, operation: 'answer', questionIndex, optionIndex }), selected.includes(option.label) ? 'primary' : 'default', 'tiny'),
            ),
          ),
        ]
      }),
      ...buttons([
        labeledButton('Submit', action(identity, { ...base, operation: 'submit_answers' }), 'primary', 'tiny'),
        labeledButton('Cancel', action(identity, { ...base, operation: 'cancel' }), 'danger', 'tiny'),
      ]),
    ]
  }
  const title = approvalTitle(pending)
  const description = approvalDescription(pending, title)
  const primary =
    pending.toolName === 'ExitPlanMode'
      ? [labeledButton('Approve', action(identity, { ...base, operation: 'allow' }), 'primary')]
      : [labeledButton('Yes', action(identity, { ...base, operation: 'allow' }), 'primary'), labeledButton('No', action(identity, { ...base, operation: 'deny' }), 'danger')]
  return [{ tag: 'hr' }, markdown(`**${shorten(title, 200)}**`), ...(description ? [markdown(description)] : []), ...buttons(primary)]
}

export function projectLarkResultCard(
  title: string,
  projectName: string,
  sessionId: string,
  turnId: string,
  replies: LarkTurnReply[],
  identity: CardIdentity,
  streaming: boolean,
  settled?: { session: SessionSummary; response: SessionTimelineResponse; timeZone: string; showDebugNav: boolean },
  pending?: ToolApprovalRequest,
  questionNav?: QuestionNav,
): LarkCard {
  if (settled) return projectLarkTurnCard(settled.session, projectName, settled.response, identity, settled.timeZone, undefined, settled.showDebugNav, { result: { replies, streaming, turnId } }).card
  const refresh = button('Refresh', action(identity, { card: 'turn', operation: 'refresh_result', sessionId, turnId }), 'default', 'refresh_outlined', 'tiny')
  const decision = pending ? decisionBlock(pending, identity, sessionId, turnId, questionNav) : []
  const render = (elements: CardElement[]) => {
    const result = card(title, [...elements, ...decision, ...(streaming ? [] : footer([refresh]))], undefined, projectName)
    result.config.streaming_mode = streaming
    if (streaming) result.config.summary = { content: turnCookingLabel(turnId) }
    return result
  }
  const replyElement = (reply: LarkTurnReply, content = reply.content, index?: number) => ({
    ...(reply.kind === 'markdown' ? markdown(content || ' ', false) : text(content, 'grey')),
    ...(index !== undefined ? { element_id: `reply_${index}` } : {}),
  })
  return render(fitReplies(replies, replyElement, [], markdown(streaming ? turnCookingLabel(turnId) : '(No response yet)'), (elements) => fitsCard(render(elements))).elements)
}

export function projectLarkTurnCard(
  session: SessionSummary,
  projectName: string,
  response: SessionTimelineResponse,
  identity: CardIdentity,
  timeZone: string,
  navigation?: { firstTurnId: string; previousTurnId: string | null; nextTurnId: string | null; latestTurnId: string },
  showDebugNav = false,
  options: TurnRenderOptions = {},
): { card: LarkCard; atLimit: boolean } {
  const turn = response.turns.at(-1)
  const title = session.title
  const source = turn?.entrypoint === 'cli' ? 'CLI' : undefined
  const latest = navigation?.nextTurnId == null
  const active = latest && turn !== undefined && !hasTerminalEvidence(turn) && effectiveActiveTurnId(response.activity, turn) === turn.primaryUserUuid
  if (!turn) {
    const refreshButton = button('Refresh', action(identity, { card: 'turn', operation: 'refresh', sessionId: session.id }), 'default', 'refresh_outlined', 'tiny')
    const value = renderWithDebug(showDebugNav, (debug) => card(title, [markdown('(No Turn to display)'), ...footer([refreshButton], debug)], source, projectName))
    return { card: value, atLimit: false }
  }

  const buttons = options.result
    ? [button('Refresh', action(identity, { card: 'turn', operation: 'refresh_result', sessionId: session.id, turnId: options.result.turnId }), 'default', 'refresh_outlined', 'tiny')]
    : [
        button('First Turn', action(identity, { card: 'turn', operation: 'first_turn', sessionId: session.id, turnId: turn.primaryUserUuid }), 'default', 'reduce-indentation_outlined', 'tiny'),
        button('Previous Turn', action(identity, { card: 'turn', operation: 'previous_turn', sessionId: session.id, turnId: turn.primaryUserUuid }), 'default', 'left_outlined', 'tiny'),
        button('Next Turn', action(identity, { card: 'turn', operation: 'next_turn', sessionId: session.id, turnId: turn.primaryUserUuid }), 'default', 'right_outlined', 'tiny'),
        button('Latest Turn', action(identity, { card: 'turn', operation: 'latest_turn', sessionId: session.id, turnId: turn.primaryUserUuid }), 'default', 'increase-indentation_outlined', 'tiny'),
        button('Refresh', action(identity, { card: 'turn', operation: 'refresh', sessionId: session.id, turnId: turn.primaryUserUuid }), 'default', 'refresh_outlined', 'tiny'),
      ]
  if (identity.detail) {
    const token = encodeDetailToken({ projectId: identity.projectId, sessionId: session.id, turnId: turn.primaryUserUuid }, identity.detail.key)
    buttons.push(urlButton('View Detail', `${identity.detail.origin}/detail/${token}`, 'default', 'preview_outlined', 'tiny'))
  }
  const pendingBackgroundAgentCount = latest && response.liveBackgroundTasks !== null ? response.liveBackgroundTasks.length : turn.pendingBackgroundAgentCount
  const footerTurn = { ...turn, pendingBackgroundAgentCount }
  const note =
    turnPendingAgentLabel(footerTurn) ??
    (active ? turnActiveTaskLabel(response.tasks) : undefined) ??
    (active ? turnCookingLabel(turn.primaryUserUuid) : undefined) ??
    turnDurationLabel(footerTurn) ??
    stableTurnVerb(turn.primaryUserUuid)
  const contextLabel = latest && response.contextUsage ? `Ctx ${Math.round(response.contextUsage.percentage)}%` : undefined
  const footerNote = `✻ ${joinNotes(turn.durationTimestampMs === undefined ? note : `${note} · ${time(turn.durationTimestampMs, timeZone)}`, contextLabel)}`
  const turnFooter = (debug?: string) => [{ tag: 'hr' }, text(footerNote, 'grey', 'notation'), ...(debug ? [text(debug, 'grey', 'notation')] : []), ...footer(buttons).slice(1)]
  const render = (elements: CardElement[]) => {
    const value = renderWithDebug(showDebugNav, (debug) => card(title, [...elements, ...turnFooter(debug)], source, projectName, !options.result))
    if (options.result) {
      value.config.streaming_mode = options.result.streaming
      if (options.result.streaming) value.config.summary = { content: turnCookingLabel(options.result.turnId) }
    }
    return value
  }
  const fitsTurn = (elements: CardElement[]) => fitsCard(render(elements))
  const projected = projectLarkTurnMessages(turn.messages as SessionMessage[], turn.primaryUserUuid, active)
  const primary = options.result ? [] : projected.primary
  const replies = options.result?.replies ?? projected.replies
  const primaryContent = primary.join('\n\n')
  const replyElement = (reply: LarkTurnReply, content = reply.content, index?: number) => ({
    ...(reply.kind === 'markdown' ? markdown(content, false) : text(content, 'grey')),
    ...(options.result && index !== undefined ? { element_id: `reply_${index}` } : {}),
  })
  const allReplies = replies.map((reply, index) => replyElement(reply, reply.content, index))
  const emptyReply = markdown(options.result?.streaming || (!options.result && active) ? turnCookingLabel(turn.primaryUserUuid) : '(No response yet)')
  const completePrimary = primaryContent ? [userMessage(primaryContent)] : []
  const completeReplies = allReplies.length ? allReplies : [emptyReply]
  const completeElements = [...completePrimary, ...completeReplies]
  if (fitsTurn(completeElements)) return { card: render(completeElements), atLimit: false }

  const omitted = markdown('_Earlier Turn content omitted due to card display limit_')
  const latestReply = replies.at(-1)
  const reservedReply = latestReply ? replyElement(latestReply, '…') : emptyReply
  const reserved = [omitted, reservedReply]
  const baseBytes = bytes(render(reserved))
  let primaryElements = completePrimary
  let primaryTruncated = false
  if (primaryContent) {
    const completeContribution = bytes(render([...completePrimary, ...reserved])) - baseBytes
    if (completeContribution > turnUserBudgetBytes || !fitsTurn([...completePrimary, ...reserved])) {
      const truncated = longestPrefix(primaryContent, (content) => {
        const element = userMessage(content)
        return bytes(render([element, ...reserved])) - baseBytes <= turnUserBudgetBytes && fitsTurn([element, ...reserved])
      })
      primaryElements = truncated ? [userMessage(truncated)] : []
      primaryTruncated = true
    }
  }

  const fitted = fitReplies(replies, replyElement, primaryElements, emptyReply, fitsTurn)
  return { card: render(fitted.elements), atLimit: primaryTruncated || fitted.atLimit }
}
