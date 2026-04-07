import type { SDKAssistantMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

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

export type TranscriptLivePreviewPhase = 'idle' | 'thinking' | 'responding' | 'tool-input' | 'complete'

export interface TranscriptLivePreviewTextBlock {
  kind: 'text'
  index: number
  text: string
}

export interface TranscriptLivePreviewThinkingBlock {
  kind: 'thinking'
  index: number
  text: string
  redacted?: boolean
}

export interface TranscriptLivePreviewToolUseBlock {
  kind: 'tool_use'
  index: number
  name: string
  toolUseId?: string
  inputText: string
}

export type TranscriptLivePreviewBlock =
  | TranscriptLivePreviewTextBlock
  | TranscriptLivePreviewThinkingBlock
  | TranscriptLivePreviewToolUseBlock

export interface TranscriptLivePreviewState {
  phase: TranscriptLivePreviewPhase
  active: boolean
  scopeKey?: string
  receivedAt?: number
  sequence?: number
  sessionId?: string
  parentToolUseId?: string | null
  messageId?: string
  blocks: TranscriptLivePreviewBlock[]
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

export function isRenderableSystemTranscriptMessage(payload: unknown): boolean {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const subtype = typeof record.subtype === 'string' ? record.subtype : ''
  const rawMessage = record.message

  if (subtype && subtype !== 'init') return true
  if (typeof rawMessage === 'string' && rawMessage.trim().length > 0) return true
  if (rawMessage && typeof rawMessage === 'object') {
    const blocks = normalizeContentBlocks(rawMessage)
    return blocks.some((block) => block.type !== 'unknown')
  }
  return false
}

export function normalizeSystemTranscriptMessage(payload: unknown): TranscriptMessage {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const rawMessage = record.message
  const blocks = normalizeContentBlocks(rawMessage)
  const explicitSubtype = typeof record.subtype === 'string' && record.subtype ? record.subtype : 'system'
  const fallbackContent = stringifyStructuredValue(rawMessage ?? payload) || `[system] ${explicitSubtype}`
  const content = blocks.length > 0
    ? stringifyMessageContent(rawMessage, blocks)
    : fallbackContent
  const timestamp = extractTimestamp(payload) ?? extractTimestamp(rawMessage)

  return {
    role: 'system',
    content,
    ...(timestamp !== undefined ? { timestamp } : {}),
    blocks,
    raw: payload,
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function getStreamEvent(payload: unknown): Record<string, unknown> | null {
  const record = asRecord(payload)
  const event = record?.event
  return asRecord(event)
}

function getStreamEventIndex(payload: unknown): number | null {
  const event = getStreamEvent(payload)
  return typeof event?.index === 'number' ? event.index : null
}

function getLivePreviewScopeKey(payload: unknown): string {
  const record = asRecord(payload)
  const sessionId = typeof record?.sessionId === 'string'
    ? record.sessionId
    : typeof record?.session_id === 'string'
      ? record.session_id
      : 'unknown-session'
  const parentToolUseId = typeof record?.parent_tool_use_id === 'string'
    ? record.parent_tool_use_id
    : record?.parent_tool_use_id === null
      ? 'root'
      : 'root'
  return `${sessionId}:${parentToolUseId}`
}

function getScopeMessageId(payload: unknown): string | undefined {
  const event = getStreamEvent(payload)
  const message = asRecord(event?.message)
  return typeof message?.id === 'string' ? message.id : undefined
}

function upsertLivePreviewBlock(
  blocks: TranscriptLivePreviewBlock[],
  nextBlock: TranscriptLivePreviewBlock,
): TranscriptLivePreviewBlock[] {
  const index = blocks.findIndex((block) => block.index === nextBlock.index && block.kind === nextBlock.kind)
  if (index === -1) return [...blocks, nextBlock].sort((left, right) => left.index - right.index)
  return blocks.map((block, blockIndex) => (blockIndex === index ? nextBlock : block))
}

function getToolUseIdFromBlock(block: Record<string, unknown> | null): string | undefined {
  if (!block) return undefined
  if (typeof block.id === 'string' && block.id) return block.id
  if (typeof block.tool_use_id === 'string' && block.tool_use_id) return block.tool_use_id
  if (typeof block.toolUseId === 'string' && block.toolUseId) return block.toolUseId
  return undefined
}

function getToolUseNameFromBlock(block: Record<string, unknown> | null): string {
  if (!block) return 'unknown_tool'
  return typeof block.name === 'string' && block.name ? block.name : 'unknown_tool'
}

export function createTranscriptLivePreviewState(): TranscriptLivePreviewState {
  return {
    phase: 'idle',
    active: false,
    blocks: [],
  }
}

export function normalizeStreamEventSnapshot(payload: unknown): TranscriptLivePreviewState | null {
  const record = asRecord(payload)
  if (!record || record.type !== 'stream_event') return null

  const event = getStreamEvent(record)
  if (!event || typeof event.type !== 'string') return null

  const base: TranscriptLivePreviewState = {
    phase: 'idle',
    active: true,
    scopeKey: getLivePreviewScopeKey(record),
    ...(typeof record.receivedAt === 'number' ? { receivedAt: record.receivedAt } : {}),
    ...(typeof record.sequence === 'number' ? { sequence: record.sequence } : {}),
    ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
    ...(typeof record.parent_tool_use_id === 'string' || record.parent_tool_use_id === null ? { parentToolUseId: record.parent_tool_use_id as string | null } : {}),
    blocks: [],
  }

  if (event.type === 'message_start') {
    const message = asRecord(event.message)
    return {
      ...base,
      phase: 'responding',
      ...(typeof message?.id === 'string' ? { messageId: message.id } : {}),
    }
  }

  if (event.type === 'message_stop') {
    return {
      ...base,
      phase: 'complete',
      active: false,
    }
  }

  if (event.type === 'message_delta') {
    return {
      ...base,
      phase: 'responding',
    }
  }

  if (event.type === 'content_block_stop') {
    return base
  }

  if (event.type === 'content_block_start') {
    const block = asRecord(event.content_block)
    const index = getStreamEventIndex(record)
    if (index == null || !block || typeof block.type !== 'string') return base

    if (block.type === 'text') {
      return {
        ...base,
        phase: 'responding',
        blocks: [{ kind: 'text', index, text: typeof block.text === 'string' ? block.text : '' }],
      }
    }

    if (block.type === 'thinking') {
      return {
        ...base,
        phase: 'thinking',
        blocks: [{ kind: 'thinking', index, text: typeof block.thinking === 'string' ? block.thinking : '', redacted: false }],
      }
    }

    if (block.type === 'redacted_thinking') {
      return {
        ...base,
        phase: 'thinking',
        blocks: [{ kind: 'thinking', index, text: '', redacted: true }],
      }
    }

    if (block.type === 'tool_use') {
      return {
        ...base,
        phase: 'tool-input',
        blocks: [{
          kind: 'tool_use',
          index,
          name: getToolUseNameFromBlock(block),
          toolUseId: getToolUseIdFromBlock(block),
          inputText: typeof block.input === 'string' ? block.input : stringifyStructuredValue(block.input),
        }],
      }
    }

    return base
  }

  if (event.type === 'content_block_delta') {
    const delta = asRecord(event.delta)
    const index = getStreamEventIndex(record)
    if (index == null || !delta || typeof delta.type !== 'string') return base

    if (delta.type === 'text_delta') {
      return {
        ...base,
        phase: 'responding',
        blocks: [{ kind: 'text', index, text: typeof delta.text === 'string' ? delta.text : '' }],
      }
    }

    if (delta.type === 'thinking_delta') {
      return {
        ...base,
        phase: 'thinking',
        blocks: [{ kind: 'thinking', index, text: typeof delta.thinking === 'string' ? delta.thinking : '', redacted: false }],
      }
    }

    if (delta.type === 'input_json_delta') {
      return {
        ...base,
        phase: 'tool-input',
        blocks: [{ kind: 'tool_use', index, name: 'unknown_tool', inputText: typeof delta.partial_json === 'string' ? delta.partial_json : '' }],
      }
    }
  }

  return base
}

export function reduceTranscriptLivePreviewState(
  current: TranscriptLivePreviewState,
  payload: unknown,
): TranscriptLivePreviewState {
  const snapshot = normalizeStreamEventSnapshot(payload)
  if (!snapshot) return current

  const currentScopeKey = current.scopeKey
  const snapshotScopeKey = snapshot.scopeKey
  const shouldResetForScope = Boolean(
    current.active
      && currentScopeKey
      && snapshotScopeKey
      && currentScopeKey !== snapshotScopeKey
      && snapshot.phase === 'responding'
      && snapshot.blocks.length === 0
  )

  const currentState = shouldResetForScope ? createTranscriptLivePreviewState() : current
  const next: TranscriptLivePreviewState = {
    ...currentState,
    phase: snapshot.phase === 'idle' ? currentState.phase : snapshot.phase,
    active: snapshot.active,
    blocks: currentState.blocks,
    ...(snapshot.scopeKey !== undefined ? { scopeKey: snapshot.scopeKey } : {}),
    ...(snapshot.receivedAt !== undefined ? { receivedAt: snapshot.receivedAt } : {}),
    ...(snapshot.sequence !== undefined ? { sequence: snapshot.sequence } : {}),
    ...(snapshot.sessionId !== undefined ? { sessionId: snapshot.sessionId } : {}),
    ...(snapshot.parentToolUseId !== undefined ? { parentToolUseId: snapshot.parentToolUseId } : {}),
    ...(snapshot.messageId !== undefined ? { messageId: snapshot.messageId } : {}),
  }

  if (snapshot.phase === 'complete') {
    return {
      ...createTranscriptLivePreviewState(),
      ...(snapshot.scopeKey !== undefined ? { scopeKey: snapshot.scopeKey } : {}),
      ...(snapshot.receivedAt !== undefined ? { receivedAt: snapshot.receivedAt } : {}),
      ...(snapshot.sequence !== undefined ? { sequence: snapshot.sequence } : {}),
      ...(snapshot.sessionId !== undefined ? { sessionId: snapshot.sessionId } : {}),
    }
  }

  let blocks = next.blocks
  for (const block of snapshot.blocks) {
    if (block.kind === 'tool_use' && block.name === 'unknown_tool') {
      const existing = blocks.find((item) => item.kind === 'tool_use' && item.index === block.index)
      if (existing && existing.kind === 'tool_use') {
        blocks = upsertLivePreviewBlock(blocks, {
          ...existing,
          inputText: block.inputText,
        })
        continue
      }
    }
    blocks = upsertLivePreviewBlock(blocks, block)
  }

  return {
    ...next,
    blocks,
  }
}

export function clearTranscriptLivePreviewState(): TranscriptLivePreviewState {
  return createTranscriptLivePreviewState()
}


export type TranscriptSemanticKind = 'user' | 'assistant' | 'system' | 'tool_result' | 'thinking' | 'meta' | 'summary' | 'unknown'

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

export function getTranscriptStopReason(message: TranscriptMessage | null | undefined): string | null {
  const rawMessage = getTranscriptRawMessage(message)
  if (!rawMessage) return null
  return typeof rawMessage.stop_reason === 'string' && rawMessage.stop_reason ? rawMessage.stop_reason : null
}

export function isTranscriptMetaMessage(message: TranscriptMessage | null | undefined): boolean {
  const raw = getTranscriptRawRecord(message)
  return raw?.isMeta === true
}

export function isTranscriptSummaryMessage(message: TranscriptMessage | null | undefined): boolean {
  const raw = getTranscriptRawRecord(message)
  return raw?.isCompactSummary === true
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
  if (isTranscriptSummaryMessage(message)) return 'summary'
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
  if (message.role === 'system') return 'system'
  return 'unknown'
}
