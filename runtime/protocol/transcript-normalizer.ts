import type { SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  StreamAnimationCursor,
  StreamAnimationCursorBlock,
  StreamRenderedPreviewBlock,
  StreamRenderedPreviewState,
  SessionStreamEvent,
  StreamPreviewBlock,
  StreamPreviewState,
} from './message-types.js'

export function reduceStreamPreviewEvent(
  current: StreamPreviewState | null,
  event: SessionStreamEvent,
): StreamPreviewState {
  const currentState: StreamPreviewState = current ?? {
    scope: event.scope,
    phase: 'idle',
    status: 'active',
    active: false,
    blocks: [],
  }

  if (
    currentState.sequence !== undefined
    && event.sequence <= currentState.sequence
  ) {
    return currentState
  }

  const nextScope = {
    ...currentState.scope,
    ...event.scope,
    scopeKey: event.scope.scopeKey,
    anchorKind: event.scope.anchorKind,
    anchorId: event.scope.anchorId,
    ...(event.scope.messageId ? { messageId: event.scope.messageId } : {}),
    ...(event.scope.parentToolUseId !== undefined ? { parentToolUseId: event.scope.parentToolUseId } : {}),
    ...(event.scope.index !== undefined ? { index: event.scope.index } : {}),
  }

  const next: StreamPreviewState = {
    ...currentState,
    scope: nextScope,
    receivedAt: event.receivedAt,
    sequence: event.sequence,
  }

  const upsertBlock = (nextBlock: StreamPreviewBlock) => {
    const index = next.blocks.findIndex((block) => block.index === nextBlock.index && block.kind === nextBlock.kind)
    next.blocks = index === -1
      ? [...next.blocks, nextBlock].sort((left, right) => left.index - right.index)
      : next.blocks.map((block, blockIndex) => (blockIndex === index ? nextBlock : block))
  }

  switch (event.event.type) {
    case 'message_start':
      next.phase = 'responding'
      next.status = 'active'
      next.active = true
      return next
    case 'message_delta':
      next.phase = 'responding'
      next.status = 'active'
      next.active = true
      return next
    case 'message_stop':
      return {
        ...next,
        phase: 'complete',
        status: 'awaiting-materialization',
        active: false,
      }
    case 'content_block_start': {
      next.active = true
      next.status = 'active'
      if (event.normalized?.blockKind === 'text') {
        next.phase = 'responding'
        upsertBlock({ kind: 'text', index: event.scope.index ?? 0, text: event.normalized.text ?? '' })
      } else if (event.normalized?.blockKind === 'thinking') {
        next.phase = 'thinking'
        upsertBlock({ kind: 'thinking', index: event.scope.index ?? 0, text: event.normalized.thinking ?? '', redacted: event.normalized.redacted })
      } else if (event.normalized?.blockKind === 'tool_use') {
        next.phase = 'tool-input'
        upsertBlock({
          kind: 'tool_use',
          index: event.scope.index ?? 0,
          name: event.normalized.toolName ?? 'unknown_tool',
          toolUseId: event.normalized.toolUseId,
          inputText: event.normalized.partialJson ?? '',
        })
      }
      return next
    }
    case 'content_block_delta': {
      next.active = true
      const index = event.scope.index ?? 0
      if (event.normalized?.deltaKind === 'text_delta') {
        next.phase = 'responding'
        const existing = next.blocks.find((block) => block.kind === 'text' && block.index === index)
        upsertBlock({ kind: 'text', index, text: `${existing && existing.kind === 'text' ? existing.text : ''}${event.normalized.text ?? ''}` })
      } else if (event.normalized?.deltaKind === 'thinking_delta') {
        next.phase = 'thinking'
        const existing = next.blocks.find((block) => block.kind === 'thinking' && block.index === index)
        upsertBlock({ kind: 'thinking', index, text: `${existing && existing.kind === 'thinking' ? existing.text : ''}${event.normalized.thinking ?? ''}`, redacted: false })
      } else if (event.normalized?.deltaKind === 'input_json_delta') {
        next.phase = 'tool-input'
        const existing = next.blocks.find((block) => block.kind === 'tool_use' && block.index === index)
        upsertBlock({
          kind: 'tool_use',
          index,
          name: existing && existing.kind === 'tool_use' ? existing.name : (event.normalized.toolName ?? 'unknown_tool'),
          toolUseId: existing && existing.kind === 'tool_use' ? existing.toolUseId : event.normalized.toolUseId,
          inputText: `${existing && existing.kind === 'tool_use' ? existing.inputText : ''}${event.normalized.partialJson ?? ''}`,
        })
      }
      return next
    }
    case 'content_block_stop':
    default:
      return next
  }
}

function getStreamPreviewBlockText(block: StreamPreviewBlock): string {
  if (block.kind === 'text') return block.text
  if (block.kind === 'thinking') return block.redacted ? '' : block.text
  return block.inputText
}

function getStreamAnimationStep(block: StreamPreviewBlock, remaining: number): number {
  if (block.kind === 'text') return Math.max(1, Math.ceil(remaining / 6))
  if (block.kind === 'thinking') return Math.max(1, Math.ceil(remaining / 8))
  return Math.max(1, Math.ceil(remaining / 4))
}

function renderStreamPreviewBlock(
  block: StreamPreviewBlock,
  visibleChars: number,
): StreamRenderedPreviewBlock {
  const target = getStreamPreviewBlockText(block)
  const clampedVisibleChars = Math.max(0, Math.min(visibleChars, target.length))
  if (block.kind === 'text') {
    return {
      kind: 'text',
      index: block.index,
      shownText: target.slice(0, clampedVisibleChars),
    }
  }
  if (block.kind === 'thinking') {
    return {
      kind: 'thinking',
      index: block.index,
      shownText: target.slice(0, clampedVisibleChars),
      redacted: block.redacted,
    }
  }
  return {
    kind: 'tool_use',
    index: block.index,
    name: block.name,
    toolUseId: block.toolUseId,
    shownInput: target.slice(0, clampedVisibleChars),
  }
}

export function createStreamAnimationCursor(preview: StreamPreviewState): StreamAnimationCursor {
  const blocks: StreamAnimationCursorBlock[] = preview.blocks.map((block) => ({
    kind: block.kind,
    index: block.index,
    visibleChars: preview.active ? 0 : getStreamPreviewBlockText(block).length,
  }))

  return {
    scope: preview.scope,
    phase: preview.phase,
    status: preview.status,
    active: preview.active,
    blocks,
  }
}

export function advanceStreamAnimationCursor(
  current: StreamAnimationCursor | null,
  preview: StreamPreviewState,
): { cursor: StreamAnimationCursor; changed: boolean; done: boolean } {
  const currentCursor = current ?? createStreamAnimationCursor(preview)
  let changed = false
  let done = true

  const blocks: StreamAnimationCursorBlock[] = preview.blocks.map((block) => {
    const existing = currentCursor.blocks.find((item) => item.kind === block.kind && item.index === block.index)
    const targetLength = getStreamPreviewBlockText(block).length
    const currentVisible = existing?.visibleChars ?? (preview.active ? 0 : targetLength)

    if (!preview.active) {
      if (currentVisible !== targetLength) changed = true
      return {
        kind: block.kind,
        index: block.index,
        visibleChars: targetLength,
      }
    }

    if (currentVisible < targetLength) {
      const nextVisible = Math.min(targetLength, currentVisible + getStreamAnimationStep(block, targetLength - currentVisible))
      if (nextVisible !== currentVisible) changed = true
      if (nextVisible < targetLength) done = false
      return {
        kind: block.kind,
        index: block.index,
        visibleChars: nextVisible,
      }
    }

    return {
      kind: block.kind,
      index: block.index,
      visibleChars: currentVisible,
    }
  })

  if (!preview.active) done = true

  return {
    cursor: {
      scope: preview.scope,
      phase: preview.phase,
      status: preview.status,
      active: preview.active,
      blocks,
    },
    changed,
    done,
  }
}

export function renderStreamPreviewState(
  preview: StreamPreviewState,
  cursor: StreamAnimationCursor | null,
): StreamRenderedPreviewState {
  const currentCursor = cursor ?? createStreamAnimationCursor(preview)
  return {
    scope: preview.scope,
    phase: preview.phase,
    status: preview.status,
    active: preview.active,
    blocks: preview.blocks.map((block) => {
      const cursorBlock = currentCursor.blocks.find((item) => item.kind === block.kind && item.index === block.index)
      return renderStreamPreviewBlock(block, cursorBlock?.visibleChars ?? 0)
    }),
  }
}

export function renderStreamPreviewText(preview: StreamPreviewState): string {
  return preview.blocks
    .slice()
    .sort((left, right) => left.index - right.index)
    .flatMap((block) => {
      if (block.kind === 'text') {
        const text = block.text.trim()
        return text ? [text] : []
      }
      if (block.kind === 'tool_use') {
        const text = `[Tool call] ${block.name}`.trim()
        return text ? [text] : []
      }
      return []
    })
    .join('\n\n')
    .trim()
}

export interface TranscriptBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'unknown'
  text?: string
  name?: string
  toolUseId?: string
  input?: unknown
  output?: unknown
  raw?: unknown
}

export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp?: number
  blocks?: TranscriptBlock[]
  raw?: unknown
}

export interface TranscriptStructuredContent {
  answerText: string
  thinkingText: string
  toolCalls: Array<{ name: string; toolUseId?: string }>
  toolResults: Array<{ toolUseId?: string; output: string }>
}

export function stringifyStructuredValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value.map(stringifyStructuredValue).filter(Boolean).join('\n').trim()
  }
  if (!value || typeof value !== 'object') return ''

  const record = value as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  if (typeof record.content === 'string') return record.content

  if (Array.isArray(record.content)) {
    const nested = record.content.map(stringifyStructuredValue).filter(Boolean).join('\n').trim()
    if (nested) return nested
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function normalizeContentBlocks(message: unknown): TranscriptBlock[] {
  if (typeof message === 'string') {
    return [{ type: 'text', text: message, raw: message }]
  }

  if (Array.isArray(message)) {
    return message.flatMap((item) => normalizeContentBlocks(item))
  }

  if (!message || typeof message !== 'object') {
    return []
  }

  const record = message as Record<string, unknown>

  if (record.message && typeof record.message === 'object') {
    const nestedBlocks = normalizeContentBlocks(record.message)
    if (nestedBlocks.length > 0) return nestedBlocks
  }

  if (typeof record.content === 'string') {
    return [{ type: 'text', text: record.content, raw: message }]
  }

  if (Array.isArray(record.content)) {
    const blocks: TranscriptBlock[] = []

    for (const item of record.content) {
      if (!item || typeof item !== 'object') continue

      const block = item as Record<string, unknown>
      const type = typeof block.type === 'string' ? block.type : 'unknown'

      if (type === 'text') {
        blocks.push({
          type: 'text',
          text: typeof block.text === 'string' ? block.text : stringifyStructuredValue(block),
          raw: item,
        })
        continue
      }

      if (type === 'tool_use') {
        blocks.push({
          type: 'tool_use',
          name: typeof block.name === 'string' ? block.name : 'unknown_tool',
          toolUseId: typeof block.id === 'string'
            ? block.id
            : typeof block.toolUseId === 'string'
              ? block.toolUseId
              : undefined,
          input: block.input,
          raw: item,
        })
        continue
      }

      if (type === 'tool_result') {
        blocks.push({
          type: 'tool_result',
          toolUseId: typeof block.tool_use_id === 'string'
            ? block.tool_use_id
            : typeof block.toolUseId === 'string'
              ? block.toolUseId
              : undefined,
          output: block.content ?? block.result ?? block.output,
          raw: item,
        })
        continue
      }

      if (type === 'thinking') {
        blocks.push({
          type: 'thinking',
          text: typeof block.thinking === 'string'
            ? block.thinking
            : typeof block.text === 'string'
              ? block.text
              : undefined,
          raw: item,
        })
        continue
      }

      blocks.push({
        type: 'unknown',
        raw: item,
      })
    }

    if (blocks.length > 0) return blocks
  }

  if (typeof record.text === 'string') {
    return [{ type: 'text', text: record.text, raw: message }]
  }

  return [{ type: 'unknown', raw: message }]
}

export function extractStructuredContentFromBlocks(blocks: TranscriptBlock[]): TranscriptStructuredContent {
  const answerParts: string[] = []
  const thinkingParts: string[] = []
  const toolCalls: Array<{ name: string; toolUseId?: string }> = []
  const toolResults: Array<{ toolUseId?: string; output: string }> = []

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text) answerParts.push(block.text)
        break
      case 'thinking':
        if (block.text) thinkingParts.push(block.text)
        break
      case 'tool_use':
        toolCalls.push({
          name: block.name || 'unknown_tool',
          ...(block.toolUseId ? { toolUseId: block.toolUseId } : {}),
        })
        break
      case 'tool_result': {
        const output = stringifyStructuredValue(block.output)
        toolResults.push({
          ...(block.toolUseId ? { toolUseId: block.toolUseId } : {}),
          output,
        })
        break
      }
      default:
        break
    }
  }

  return {
    answerText: answerParts.join('\n\n').trim(),
    thinkingText: thinkingParts.join('\n\n').trim(),
    toolCalls,
    toolResults,
  }
}

export function hasRenderableTranscriptContent(blocks: TranscriptBlock[]): boolean {
  const structured = extractStructuredContentFromBlocks(blocks)
  return Boolean(
    structured.answerText
      || structured.thinkingText
      || structured.toolCalls.length > 0
      || structured.toolResults.some((item) => item.output)
  )
}

export function buildContentFromBlocks(blocks: TranscriptBlock[]): string {
  const structured = extractStructuredContentFromBlocks(blocks)
  return [
    structured.thinkingText ? `Thinking:\n${structured.thinkingText}` : '',
    structured.answerText,
    ...structured.toolCalls.map((block) => `[Tool call] ${block.name}`),
    ...structured.toolResults.map((block) => block.output ? `[Tool result]\n${block.output}` : '[Tool result]'),
  ]
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

export function stringifyMessageContent(message: unknown, blocks: TranscriptBlock[]): string {
  const fromBlocks = buildContentFromBlocks(blocks)
  if (fromBlocks) return fromBlocks
  return stringifyStructuredValue(message)
}

export function extractTimestamp(message: unknown): number | undefined {
  if (!message || typeof message !== 'object') return undefined

  const record = message as Record<string, unknown>
  const candidate = record.timestamp ?? record.createdAt ?? record.created_at ?? record.time

  if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
  if (typeof candidate === 'string') {
    const parsed = Date.parse(candidate)
    return Number.isNaN(parsed) ? undefined : parsed
  }

  return undefined
}

export function normalizeTranscriptMessage(
  role: TranscriptMessage['role'],
  message: unknown,
  raw?: unknown,
  timestamp?: number,
): TranscriptMessage {
  const blocks = normalizeContentBlocks(message)
  return {
    role,
    content: stringifyMessageContent(message, blocks),
    timestamp: timestamp ?? extractTimestamp(message),
    blocks,
    raw: raw ?? message,
  }
}

export function normalizeStoredTranscriptBlocks(payload: unknown): TranscriptBlock[] | undefined {
  if (!Array.isArray(payload)) return undefined

  const blocks: TranscriptBlock[] = []

  for (const item of payload) {
    if (!item || typeof item !== 'object') continue

    const record = item as Record<string, unknown>
    const type = typeof record.type === 'string' ? record.type : 'unknown'
    const raw = 'raw' in record ? record.raw : item

    if (type === 'text') {
      blocks.push({
        type: 'text',
        text: typeof record.text === 'string' ? record.text : stringifyStructuredValue(record.text),
        raw,
      })
      continue
    }

    if (type === 'tool_use') {
      blocks.push({
        type: 'tool_use',
        name: typeof record.name === 'string' ? record.name : 'unknown_tool',
        toolUseId: typeof record.toolUseId === 'string'
          ? record.toolUseId
          : typeof record.tool_use_id === 'string'
            ? record.tool_use_id
            : undefined,
        input: record.input,
        raw,
      })
      continue
    }

    if (type === 'tool_result') {
      blocks.push({
        type: 'tool_result',
        toolUseId: typeof record.toolUseId === 'string'
          ? record.toolUseId
          : typeof record.tool_use_id === 'string'
            ? record.tool_use_id
            : undefined,
        output: record.output,
        raw,
      })
      continue
    }

    if (type === 'thinking') {
      blocks.push({
        type: 'thinking',
        text: typeof record.text === 'string' ? record.text : undefined,
        raw,
      })
      continue
    }

    blocks.push({
      type: 'unknown',
      raw,
    })
  }

  return blocks
}

export function normalizeStoredTranscriptMessage(payload: unknown): TranscriptMessage {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const role = record.role === 'user' || record.role === 'assistant' || record.role === 'system'
    ? record.role
    : 'assistant'
  const raw = 'raw' in record && record.raw !== undefined ? record.raw : payload
  const explicitContent = typeof record.content === 'string' ? record.content : undefined
  const blocks = normalizeStoredTranscriptBlocks(record.blocks)
  const timestamp = typeof record.timestamp === 'number'
    ? record.timestamp
    : extractTimestamp(raw)

  if (explicitContent !== undefined || blocks !== undefined || ('raw' in record && record.raw !== undefined)) {
    return {
      role,
      content: explicitContent ?? buildContentFromBlocks(blocks ?? []),
      ...(timestamp !== undefined ? { timestamp } : {}),
      ...(blocks !== undefined ? { blocks } : {}),
      raw,
    }
  }

  return normalizeTranscriptMessage(role, payload, raw, timestamp)
}

export function normalizeSdkEnvelopeMessage(payload: unknown): TranscriptMessage | null {
  if (!payload || typeof payload !== 'object') return null

  const record = payload as Record<string, unknown>
  if (record.type !== 'assistant' && record.type !== 'user') return null
  if (!('message' in record)) return null

  return normalizeTranscriptMessage(record.type, record.message, record, Date.now())
}

export function normalizeAssistantMessage(message: SDKAssistantMessage): TranscriptMessage {
  return normalizeTranscriptMessage('assistant', message.message, message)
}

export type TranscriptSemanticKind = 'user' | 'assistant' | 'tool_result' | 'thinking' | 'meta' | 'unknown'

export interface TranscriptAssistantUsage {
  inputTokens?: number | null
  outputTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
}

export function getTranscriptRawRecord(message: TranscriptMessage | null | undefined): Record<string, unknown> | null {
  const raw = message?.raw
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
}

export function getTranscriptRawMessage(message: TranscriptMessage | null | undefined): Record<string, unknown> | null {
  const raw = getTranscriptRawRecord(message)
  if (!raw) return null
  const rawMessage = raw.message
  return rawMessage && typeof rawMessage === 'object' ? rawMessage as Record<string, unknown> : null
}

export function getTranscriptMessageId(message: TranscriptMessage | null | undefined): string | null {
  const raw = getTranscriptRawRecord(message)
  if (!raw) return null
  return typeof raw.uuid === 'string' && raw.uuid ? raw.uuid : null
}

export function getTranscriptResponseId(message: TranscriptMessage | null | undefined): string | null {
  const rawMessage = getTranscriptRawMessage(message)
  if (!rawMessage) return null
  return typeof rawMessage.id === 'string' && rawMessage.id ? rawMessage.id : null
}

export function getTranscriptStopReason(message: TranscriptMessage | null | undefined): string | null {
  const rawMessage = getTranscriptRawMessage(message)
  if (!rawMessage) return null
  return typeof rawMessage.stop_reason === 'string' && rawMessage.stop_reason ? rawMessage.stop_reason : null
}

export function isTranscriptMetaMessage(message: TranscriptMessage | null | undefined): boolean {
  const raw = getTranscriptRawRecord(message)
  return raw?.isMeta === true
}

export function isTranscriptSummaryMessage(_message: TranscriptMessage | null | undefined): boolean {
  return false
}

export function isTranscriptRedactedThinkingMessage(message: TranscriptMessage | null | undefined): boolean {
  const rawMessage = getTranscriptRawMessage(message)
  if (!rawMessage) return false
  const content = rawMessage.content
  if (Array.isArray(content)) {
    return content.length === 1
      && Boolean(content[0])
      && typeof content[0] === 'object'
      && (content[0] as Record<string, unknown>).type === 'redacted_thinking'
  }

  return Boolean(content && typeof content === 'object' && (content as Record<string, unknown>).type === 'redacted_thinking')
}

export function getTranscriptToolUseIds(message: TranscriptMessage | null | undefined): string[] {
  if (!message?.blocks?.length) return []
  return message.blocks
    .flatMap((block) => block.type === 'tool_use' && typeof block.toolUseId === 'string' ? [block.toolUseId] : [])
}

export function getTranscriptToolResultIds(message: TranscriptMessage | null | undefined): string[] {
  if (!message?.blocks?.length) return []
  return message.blocks
    .flatMap((block) => block.type === 'tool_result' && typeof block.toolUseId === 'string' ? [block.toolUseId] : [])
}

export function getTranscriptAssistantModel(message: TranscriptMessage | null | undefined): string | null {
  const rawMessage = getTranscriptRawMessage(message)
  if (!rawMessage) return null
  return typeof rawMessage.model === 'string' && rawMessage.model ? rawMessage.model : null
}

export function getTranscriptAssistantUsage(message: TranscriptMessage | null | undefined): TranscriptAssistantUsage | null {
  const rawMessage = getTranscriptRawMessage(message)
  if (!rawMessage) return null
  const usage = rawMessage.usage
  if (!usage || typeof usage !== 'object') return null
  const record = usage as Record<string, unknown>
  return {
    inputTokens: typeof record.input_tokens === 'number' ? record.input_tokens : null,
    outputTokens: typeof record.output_tokens === 'number' ? record.output_tokens : null,
    cacheReadTokens: typeof record.cache_read_input_tokens === 'number' ? record.cache_read_input_tokens : null,
    cacheWriteTokens: typeof record.cache_creation_input_tokens === 'number' ? record.cache_creation_input_tokens : null,
  }
}

export function getTranscriptSemanticKind(message: TranscriptMessage | null | undefined): TranscriptSemanticKind {
  if (!message) return 'unknown'
  if (isTranscriptMetaMessage(message)) return 'meta'
  if (isTranscriptRedactedThinkingMessage(message)) return 'thinking'
  if (message.blocks?.some((block) => block.type === 'thinking')) return 'thinking'
  if (message.blocks?.some((block) => block.type === 'tool_result')) return 'tool_result'

  const rawMessage = getTranscriptRawMessage(message)
  const content = rawMessage?.content
  if (Array.isArray(content)) {
    if (content.some((item) => Boolean(item) && typeof item === 'object' && (item as Record<string, unknown>).type === 'tool_result')) {
      return 'tool_result'
    }
    if (content.some((item) => Boolean(item) && typeof item === 'object' && (item as Record<string, unknown>).type === 'thinking')) {
      return 'thinking'
    }
    if (content.some((item) => Boolean(item) && typeof item === 'object' && (item as Record<string, unknown>).type === 'user')) {
      return 'user'
    }
  }

  if (message.role === 'user') return 'user'
  if (message.role === 'assistant') return 'assistant'
  return 'unknown'
}
