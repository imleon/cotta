import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionTimelineResponse, TimelineBlock, TurnSummary } from '@cotta/shared'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function messageContent(message: SessionMessage): unknown {
  return isRecord(message.message) ? message.message.content : undefined
}

function isToolResultMessage(message: SessionMessage): boolean {
  const content = messageContent(message)
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === 'tool_result')
}

function isPrimaryUserMessage(message: SessionMessage): boolean {
  return message.type === 'user' && !isToolResultMessage(message)
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

function timelineBlocksForMessage(message: SessionMessage): TimelineBlock[] {
  if (message.type === 'user') {
    if (isToolResultMessage(message)) {
      return [{
        id: `${message.uuid}:tool_result`,
        kind: 'tool.result',
        sourceEventIds: [message.uuid],
        data: message.message,
      }]
    }
    return [{
      id: `${message.uuid}:user`,
      kind: 'user.message',
      sourceEventIds: [message.uuid],
      data: { text: userText(message), raw: message.message },
    }]
  }

  if (message.type === 'assistant') {
    const rawContent = messageContent(message)
    if (!Array.isArray(rawContent)) {
      return [{
        id: `${message.uuid}:assistant`,
        kind: 'assistant.message',
        sourceEventIds: [message.uuid],
        data: message.message,
      }]
    }
    return rawContent.map((block, index) => ({
      id: `${message.uuid}:assistant:${index}`,
      kind: blockKindForContentBlock(block),
      sourceEventIds: [message.uuid],
      data: block,
    }))
  }

  return [{
    id: `${message.uuid}:system`,
    kind: 'system.message',
    sourceEventIds: [message.uuid],
    data: message.message,
  }]
}

function turnTitleFromMessage(message: SessionMessage): string {
  const text = userText(message).trim().replace(/\s+/g, ' ')
  if (!text) return 'Untitled turn'
  return text.length > 80 ? `${text.slice(0, 77)}…` : text
}

function projectTurns(messages: SessionMessage[]): TurnSummary[] {
  const turns: TurnSummary[] = []
  let current: TurnSummary | null = null

  for (const message of messages) {
    if (isPrimaryUserMessage(message) || current === null) {
      current = {
        id: message.uuid,
        sessionId: message.session_id,
        title: isPrimaryUserMessage(message) ? turnTitleFromMessage(message) : 'Session events',
        rawStatus: 'complete',
        displayStatus: 'complete',
        blocks: [],
      }
      turns.push(current)
    }

    current.blocks.push(...timelineBlocksForMessage(message))
  }

  return turns
}

export function projectSessionTimeline(
  sessionId: string,
  messages: SessionMessage[],
  options: { limitTurns: number; cursor: string | null },
): SessionTimelineResponse {
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
