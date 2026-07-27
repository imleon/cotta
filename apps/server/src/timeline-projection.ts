import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { isPrimaryTimelineUserMessage, isTimelineTaskNotificationMessage, timelineToolUseId } from '@cotta/shared'
import type { SessionTimelineResponse, TimelineBlock, TurnSummary } from '@cotta/shared'

type ProjectedSessionTimeline = Omit<SessionTimelineResponse, 'state'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function jsonData(value: unknown): unknown {
  return value === undefined ? null : value
}

function hasMessageValue(message: SessionMessage): boolean {
  return message.message !== undefined && message.message !== null
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function messageTimestampMs(message: SessionMessage): number | undefined {
  return timestampMs('timestamp' in message ? message.timestamp : undefined)
}

function messageContent(message: SessionMessage): unknown {
  return isRecord(message.message) ? message.message.content : undefined
}

const taskNotificationStatuses = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

type TaskNotificationMetadata = {
  text: string
  taskId: string
  toolUseId: string
  outputFile: string
  status: string
  summary: string
  result?: string
}

function isToolResultMessage(message: SessionMessage): boolean {
  const content = messageContent(message)
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === 'tool_result')
}

function tagText(content: string, tagName: string): string | null {
  const match = content.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`))
  return match?.[1]?.trim() || null
}

function taskNotificationMetadata(message: SessionMessage): TaskNotificationMetadata | null {
  if (message.type !== 'user' || !isRecord(message.message) || message.message.role !== 'user') return null
  const content = messageContent(message)
  if (typeof content !== 'string') return null

  const text = content.trim()
  const wrapperMatch = text.match(/^<task-notification(?:\s[^>]*)?>([\s\S]*)<\/task-notification>$/)
  if (!wrapperMatch) return null

  const body = wrapperMatch[1] ?? ''
  const taskId = tagText(body, 'task-id')
  const toolUseId = tagText(body, 'tool-use-id')
  const outputFile = tagText(body, 'output-file')
  const status = tagText(body, 'status')
  const summary = tagText(body, 'summary')
  const result = tagText(body, 'result') ?? undefined
  if (!taskId || !toolUseId || !outputFile || !status || !summary) return null
  if (!taskNotificationStatuses.has(status)) return null

  return { text, taskId, toolUseId, outputFile, status, summary, ...(result ? { result } : {}) }
}

function isTaskNotificationMessage(message: SessionMessage): boolean {
  return isTimelineTaskNotificationMessage(message)
}

function textFromUnknownContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!isRecord(block)) return ''
      if (typeof block.text === 'string') return block.text
      if (typeof block.content === 'string') return block.content
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function userText(message: SessionMessage): string {
  return textFromUnknownContent(messageContent(message))
}

function blockKindForContentBlock(block: unknown): string {
  if (!isRecord(block) || typeof block.type !== 'string') return 'assistant.unknown_block'
  return `assistant.${block.type}`
}

function toolUseMetadata(message: SessionMessage, block: unknown): Pick<TimelineBlock, 'contentBlockId' | 'toolUseId'> {
  if (isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string') return { contentBlockId: block.id, toolUseId: block.id }
  const toolUseId = timelineToolUseId(message, block)
  return toolUseId ? { toolUseId } : {}
}

function messageApiMessageId(message: SessionMessage): string | undefined {
  return isRecord(message.message) && typeof message.message.id === 'string' ? message.message.id : undefined
}

function timelineBlocksForTaskNotificationMessage(message: SessionMessage): TimelineBlock[] {
  const metadata = taskNotificationMetadata(message)
  return [{
    id: `${message.uuid}:task_notification`,
    kind: 'assistant.task_notification',
    sourceEventIds: [message.uuid],
    data: metadata ? { ...metadata, raw: message.message } : { raw: message.message },
  }]
}

function timelineBlocksForToolResultMessage(message: SessionMessage): TimelineBlock[] {
  const content = messageContent(message)
  if (!Array.isArray(content)) {
    const toolUseId = timelineToolUseId(message, null)
    return [{
      id: `${message.uuid}:tool_result`,
      kind: 'tool.result',
      sourceEventIds: [message.uuid],
      ...(toolUseId ? { toolUseId } : {}),
      data: jsonData(message.message),
    }]
  }

  const blocks = content
    .map((block, index): TimelineBlock | null => {
      if (!isRecord(block) || block.type !== 'tool_result') return null
      return {
        id: `${message.uuid}:tool_result:${index}`,
        kind: 'tool.result',
        sourceEventIds: [message.uuid],
        ...toolUseMetadata(message, block),
        data: jsonData(block),
      }
    })
    .filter((block): block is TimelineBlock => block !== null)

  return blocks.length > 0 ? blocks : [{
    id: `${message.uuid}:tool_result`,
    kind: 'tool.result',
    sourceEventIds: [message.uuid],
    data: jsonData(message.message),
  }]
}

function timelineBlocksForMessage(message: SessionMessage): TimelineBlock[] {
  if (message.type === 'user') {
    if (isToolResultMessage(message)) return timelineBlocksForToolResultMessage(message)
    if (isTaskNotificationMessage(message)) return timelineBlocksForTaskNotificationMessage(message)
    return [{
      id: `${message.uuid}:user`,
      kind: 'user.message',
      sourceEventIds: [message.uuid],
      data: { text: userText(message), raw: message.message },
    }]
  }

  if (message.type === 'assistant') {
    const rawContent = messageContent(message)
    const apiMessageId = messageApiMessageId(message)
    if (!Array.isArray(rawContent)) {
      return [{
        id: `${message.uuid}:assistant`,
        kind: 'assistant.message',
        sourceEventIds: [message.uuid],
        ...(apiMessageId ? { apiMessageId } : {}),
        data: jsonData(message.message),
      }]
    }
    return rawContent.map((block, index) => ({
      id: `${message.uuid}:assistant:${index}`,
      kind: blockKindForContentBlock(block),
      sourceEventIds: [message.uuid],
      ...(apiMessageId ? { apiMessageId } : {}),
      ...toolUseMetadata(message, block),
      data: jsonData(block),
    }))
  }

  if (!hasMessageValue(message)) return []
  return [{
    id: `${message.uuid}:system`,
    kind: 'system.message',
    sourceEventIds: [message.uuid],
    data: jsonData(message.message),
  }]
}

function turnTitleFromMessage(message: SessionMessage): string {
  const text = userText(message).trim().replace(/\s+/g, ' ')
  if (!text) return 'Untitled turn'
  return text.length > 80 ? `${text.slice(0, 77)}…` : text
}

function projectTurns(messages: SessionMessage[]): TurnSummary[] {
  const turns: TurnSummary[] = []
  const turnsByToolUseId = new Map<string, TurnSummary>()
  let current: TurnSummary | null = null

  for (const message of messages) {
    const isPrimary = isPrimaryTimelineUserMessage(message)
    const timestamp = messageTimestampMs(message)
    if (isPrimary || current === null) {
      current = {
        id: message.uuid,
        sessionId: message.session_id,
        title: isPrimary ? turnTitleFromMessage(message) : 'Session events',
        startedAt: timestamp,
        rawStatus: 'complete',
        displayStatus: 'complete',
        blocks: [],
      }
      turns.push(current)
    }

    for (const block of timelineBlocksForMessage(message)) {
      const target = block.kind === 'tool.result' && block.toolUseId
        ? turnsByToolUseId.get(block.toolUseId) ?? current
        : current
      target.blocks.push(block)
      if (block.kind === 'assistant.tool_use' && block.toolUseId) turnsByToolUseId.set(block.toolUseId, target)
      if (!isPrimary && timestamp !== undefined) target.completedAt = timestamp
    }
  }

  return turns
}

export function projectSessionTimeline(
  sessionId: string,
  messages: SessionMessage[],
  options: { limitTurns: number; cursor: string | null },
): ProjectedSessionTimeline {
  const allTurns = projectTurns(messages)
  const endExclusive = options.cursor
    ? Math.max(0, allTurns.findIndex((turn) => turn.id === options.cursor))
    : allTurns.length
  const start = Math.max(0, endExclusive - options.limitTurns)
  const turns = allTurns.slice(start, endExclusive)
  return {
    sessionId,
    turns,
    hasMore: start > 0,
    nextCursor: start > 0 ? allTurns[start]?.id ?? null : null,
  }
}
