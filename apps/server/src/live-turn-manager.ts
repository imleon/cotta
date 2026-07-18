import { randomUUID } from 'node:crypto'
import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionStreamEvent, TimelineBlock, TurnSummary } from '@cotta/shared'
import { projectPathFromId } from './claude-code-api.js'
import type { LiveEventStore } from './live-event-store.js'

function randomId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

function sdkUserMessage(input: { uuid: ReturnType<typeof randomUUID>; text: string; sessionId: string; startedAt: number }): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: input.text },
    parent_tool_use_id: null,
    uuid: input.uuid,
    session_id: input.sessionId,
    timestamp: new Date(input.startedAt).toISOString(),
  }
}

function jsonData(value: unknown): unknown {
  return value === undefined ? null : value
}

function sdkMessageContent(message: SDKMessage): unknown {
  return 'message' in message && isRecord(message.message) ? message.message.content : undefined
}

function blockKindForContentBlock(block: unknown): string {
  if (!isRecord(block) || typeof block.type !== 'string') return 'assistant.unknown_block'
  return `assistant.${block.type}`
}

function toolUseMetadata(block: unknown): Pick<TimelineBlock, 'contentBlockId' | 'toolUseId'> {
  if (!isRecord(block)) return {}
  if (block.type === 'tool_use' && typeof block.id === 'string') return { contentBlockId: block.id, toolUseId: block.id }
  if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') return { toolUseId: block.tool_use_id }
  return {}
}

function isToolResultContent(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === 'tool_result')
}

function sdkMessageUuid(message: SDKMessage): string {
  return 'uuid' in message && typeof message.uuid === 'string' ? message.uuid : randomId('raw')
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []

  push(value: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.values.push(value)
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length > 0) return Promise.resolve({ value: this.values.shift() as T, done: false })
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

type LiveSessionState = 'idle' | 'running' | 'requires_action'
type VisibleLiveSessionState = Exclude<LiveSessionState, 'idle'>

type LiveAssistantBlockDraft = {
  id: string
  index: number
  kind: 'assistant.text' | 'assistant.thinking'
  text: string
  thinking: string
  sourceEventIds: string[]
  closed?: boolean
}

type LiveAssistantMessageDraft = {
  ordinal: number
  apiMessageId?: string
  blocks: Map<number, LiveAssistantBlockDraft>
  finalized?: boolean
}

class LiveAssistantStreamAccumulator {
  private nextAssistantOrdinal = 0
  private current: LiveAssistantMessageDraft | null = null
  private readonly byApiMessageId = new Map<string, LiveAssistantMessageDraft>()
  private readonly drafts: LiveAssistantMessageDraft[] = []

  constructor(private readonly turnId: string) {}

  processStreamEvent(message: SDKMessage): TimelineBlock[] {
    if (message.type !== 'stream_event' || !isRecord(message.event)) return []
    const event = message.event
    const eventType = typeof event.type === 'string' ? event.type : 'unknown'
    const sourceEventId = sdkMessageUuid(message)

    if (eventType === 'message_start') {
      const apiMessageId = isRecord(event.message) && typeof event.message.id === 'string' ? event.message.id : undefined
      this.current = this.createDraft(apiMessageId)
      return []
    }

    if (eventType === 'content_block_start') {
      const index = typeof event.index === 'number' ? event.index : 0
      const contentBlock = isRecord(event.content_block) ? event.content_block : null
      const blockType = typeof contentBlock?.type === 'string' ? contentBlock.type : undefined
      if (blockType !== 'text' && blockType !== 'thinking') return []
      const draft = this.ensureCurrent()
      const block = this.ensureBlock(draft, index, blockType === 'thinking' ? 'assistant.thinking' : 'assistant.text')
      this.addSourceEventId(block, sourceEventId)
      if (blockType === 'text' && typeof contentBlock?.text === 'string') block.text = contentBlock.text
      if (blockType === 'thinking' && typeof contentBlock?.thinking === 'string') block.thinking = contentBlock.thinking
      return this.snapshotIfVisible(block, draft.apiMessageId)
    }

    if (eventType === 'content_block_delta') {
      const index = typeof event.index === 'number' ? event.index : 0
      const delta = isRecord(event.delta) ? event.delta : null
      const deltaType = typeof delta?.type === 'string' ? delta.type : undefined
      if (deltaType !== 'text_delta' && deltaType !== 'thinking_delta') return []
      const draft = this.ensureCurrent()
      const block = this.ensureBlock(draft, index, deltaType === 'thinking_delta' ? 'assistant.thinking' : 'assistant.text')
      this.addSourceEventId(block, sourceEventId)
      if (deltaType === 'text_delta' && typeof delta?.text === 'string') block.text += delta.text
      if (deltaType === 'thinking_delta' && typeof delta?.thinking === 'string') block.thinking += delta.thinking
      return this.snapshotIfVisible(block, draft.apiMessageId)
    }

    if (eventType === 'content_block_stop') {
      const index = typeof event.index === 'number' ? event.index : 0
      const block = this.current?.blocks.get(index)
      if (block) block.closed = true
      return []
    }

    if (eventType === 'message_stop') this.current = null
    return []
  }

  finalAssistantBlocks(message: SDKMessage): TimelineBlock[] {
    const uuid = sdkMessageUuid(message)
    const apiMessageId = 'message' in message && isRecord(message.message) && typeof message.message.id === 'string' ? message.message.id : undefined
    const draft = this.findDraft(apiMessageId)
    draft.finalized = true
    if (this.current === draft) this.current = null

    const content = sdkMessageContent(message)
    const blockApiMessageId = draft.apiMessageId ?? apiMessageId
    if (!Array.isArray(content)) {
      return [{
        id: `${this.turnId}:assistant:${draft.ordinal}:message`,
        kind: 'assistant.message',
        sourceEventIds: [uuid],
        ...(blockApiMessageId ? { apiMessageId: blockApiMessageId } : {}),
        data: jsonData(message),
      }]
    }

    return content.map((block, index) => ({
      id: `${this.turnId}:assistant:${draft.ordinal}:${index}`,
      kind: blockKindForContentBlock(block),
      sourceEventIds: [uuid],
      ...(blockApiMessageId ? { apiMessageId: blockApiMessageId } : {}),
      ...toolUseMetadata(block),
      data: jsonData(block),
    }))
  }

  private createDraft(apiMessageId?: string): LiveAssistantMessageDraft {
    const draft: LiveAssistantMessageDraft = {
      ordinal: this.nextAssistantOrdinal++,
      apiMessageId,
      blocks: new Map(),
    }
    this.drafts.push(draft)
    if (apiMessageId) this.byApiMessageId.set(apiMessageId, draft)
    return draft
  }

  private ensureCurrent(): LiveAssistantMessageDraft {
    if (!this.current) this.current = this.createDraft()
    return this.current
  }

  private findDraft(apiMessageId?: string): LiveAssistantMessageDraft {
    if (apiMessageId) {
      const match = this.byApiMessageId.get(apiMessageId)
      if (match) return match
    }
    const unfinalized = this.drafts.find((draft) => !draft.finalized)
    return unfinalized ?? this.createDraft(apiMessageId)
  }

  private ensureBlock(draft: LiveAssistantMessageDraft, index: number, kind: LiveAssistantBlockDraft['kind']): LiveAssistantBlockDraft {
    const existing = draft.blocks.get(index)
    if (existing) return existing
    const block: LiveAssistantBlockDraft = {
      id: `${this.turnId}:assistant:${draft.ordinal}:${index}`,
      index,
      kind,
      text: '',
      thinking: '',
      sourceEventIds: [],
    }
    draft.blocks.set(index, block)
    return block
  }

  private addSourceEventId(block: LiveAssistantBlockDraft, sourceEventId: string): void {
    if (!block.sourceEventIds.includes(sourceEventId)) block.sourceEventIds.push(sourceEventId)
  }

  private snapshotIfVisible(block: LiveAssistantBlockDraft, apiMessageId?: string): TimelineBlock[] {
    const value = block.kind === 'assistant.text' ? block.text : block.thinking
    if (!value) return []
    return [{
      id: block.id,
      kind: block.kind,
      sourceEventIds: block.sourceEventIds,
      ...(apiMessageId ? { apiMessageId } : {}),
      data: block.kind === 'assistant.text'
        ? { type: 'text', text: block.text, streaming: true }
        : { type: 'thinking', thinking: block.thinking, streaming: true },
    }]
  }
}

function timelineBlocksFromSdkMessage(message: SDKMessage, accumulator: LiveAssistantStreamAccumulator): TimelineBlock[] {
  const uuid = sdkMessageUuid(message)
  if (message.type === 'stream_event') return accumulator.processStreamEvent(message)
  if (message.type === 'assistant') return accumulator.finalAssistantBlocks(message)

  if (message.type === 'user') {
    const content = sdkMessageContent(message)
    if (isToolResultContent(content) && Array.isArray(content)) {
      return content
        .map((block, index): TimelineBlock | null => {
          if (!isRecord(block) || block.type !== 'tool_result') return null
          return {
            id: `${uuid}:tool_result:${index}`,
            kind: 'tool.result',
            sourceEventIds: [uuid],
            ...toolUseMetadata(block),
            data: jsonData(block),
          }
        })
        .filter((block): block is TimelineBlock => block !== null)
    }
  }

  return []
}

type SessionRuntime = {
  projectId: string
  sessionId: string
  query: Query
  input: AsyncQueue<SDKUserMessage>
  currentTurnId: string | null
  streamAccumulator: LiveAssistantStreamAccumulator | null
}

function liveSessionStateFromSdkMessage(message: SDKMessage): LiveSessionState | null {
  if (message.type !== 'system' || !('subtype' in message) || message.subtype !== 'session_state_changed') return null
  if (!('state' in message) || typeof message.state !== 'string') return null
  return message.state === 'idle' || message.state === 'running' || message.state === 'requires_action' ? message.state : null
}

function turnSummary(input: { turnId: string; sessionId: string; text: string; startedAt: number }): TurnSummary {
  return {
    id: input.turnId,
    sessionId: input.sessionId,
    title: input.text.length > 80 ? `${input.text.slice(0, 77)}…` : input.text,
    startedAt: input.startedAt,
    rawStatus: 'running',
    displayStatus: 'running',
    blocks: [{
      id: `${input.turnId}:user`,
      kind: 'user.message',
      sourceEventIds: [input.turnId],
      data: { text: input.text },
    }],
  }
}

export type LiveTurnSubscriber = (event: SessionStreamEvent) => void

export class LiveTurnManager {
  private readonly subscribers = new Map<string, Set<LiveTurnSubscriber>>()
  private readonly runtimes = new Map<string, SessionRuntime>()
  private readonly liveStateBySession = new Map<string, VisibleLiveSessionState>()

  constructor(private readonly liveEventStore?: LiveEventStore) {}

  sessionState(sessionId: string): VisibleLiveSessionState | null {
    return this.liveStateBySession.get(sessionId) ?? null
  }

  subscribe(sessionId: string, subscriber: LiveTurnSubscriber): () => void {
    const set = this.subscribers.get(sessionId) ?? new Set<LiveTurnSubscriber>()
    set.add(subscriber)
    this.subscribers.set(sessionId, set)
    return () => {
      set.delete(subscriber)
      if (set.size === 0) this.subscribers.delete(sessionId)
    }
  }

  ensureRuntime(input: { projectId: string; sessionId: string }): void {
    this.ensureRuntimeInternal({ ...input, resume: true })
  }

  async startTurn(input: { projectId: string; sessionId?: string; text: string }): Promise<{ sessionId: string; turnId: string }> {
    const sessionId = input.sessionId ?? randomUUID()
    const runtime = this.ensureRuntimeInternal({ projectId: input.projectId, sessionId, resume: Boolean(input.sessionId) })
    if (runtime.currentTurnId) throw new Error('Session already has a running turn')

    const startedAt = Date.now()
    const turnId = randomUUID()
    const userMessage = sdkUserMessage({ uuid: turnId, text: input.text, sessionId, startedAt })
    runtime.currentTurnId = turnId
    runtime.streamAccumulator = new LiveAssistantStreamAccumulator(turnId)
    this.liveStateBySession.set(sessionId, 'running')
    this.publish(sessionId, {
      type: 'live.turn.started',
      projectId: input.projectId,
      sessionId,
      turnId,
      turn: turnSummary({ turnId, sessionId, text: input.text, startedAt }),
    })
    runtime.input.push(userMessage)

    return { sessionId, turnId }
  }

  async interrupt(sessionId: string): Promise<boolean> {
    const runtime = this.runtimes.get(sessionId)
    const turnId = runtime?.currentTurnId
    if (!runtime || !turnId) return false
    await runtime.query.interrupt()
    runtime.currentTurnId = null
    runtime.streamAccumulator = null
    this.liveStateBySession.delete(sessionId)
    this.publish(sessionId, {
      type: 'live.turn.interrupted',
      projectId: runtime.projectId,
      sessionId,
      turnId,
      completedAt: Date.now(),
    })
    return true
  }

  private ensureRuntimeInternal(input: { projectId: string; sessionId: string; resume: boolean }): SessionRuntime {
    const existing = this.runtimes.get(input.sessionId)
    if (existing) {
      if (existing.projectId !== input.projectId) throw new Error('Session runtime project mismatch')
      return existing
    }

    const projectPath = projectPathFromId(input.projectId)
    if (!projectPath) throw new Error('Invalid project id')
    const runtimeInput = new AsyncQueue<SDKUserMessage>()
    const runtime: SessionRuntime = {
      projectId: input.projectId,
      sessionId: input.sessionId,
      input: runtimeInput,
      query: query({
        prompt: runtimeInput,
        options: {
          cwd: projectPath,
          ...(input.resume ? { resume: input.sessionId } : { sessionId: input.sessionId }),
          includePartialMessages: true,
        },
      }),
      currentTurnId: null,
      streamAccumulator: null,
    }
    this.runtimes.set(input.sessionId, runtime)
    void this.drainRuntime(runtime)
    return runtime
  }

  private async drainRuntime(runtime: SessionRuntime): Promise<void> {
    try {
      for await (const message of runtime.query) {
        const liveState = liveSessionStateFromSdkMessage(message)
        if (liveState === 'idle') this.liveStateBySession.delete(runtime.sessionId)
        else if (liveState) this.liveStateBySession.set(runtime.sessionId, liveState)

        const turnId = runtime.currentTurnId
        if (!turnId) continue

        this.publish(runtime.sessionId, {
          type: 'live.raw',
          projectId: runtime.projectId,
          sessionId: runtime.sessionId,
          turnId,
          raw: message,
        })

        if (runtime.streamAccumulator) {
          for (const block of timelineBlocksFromSdkMessage(message, runtime.streamAccumulator)) {
            this.publish(runtime.sessionId, {
              type: 'live.timeline.block',
              projectId: runtime.projectId,
              sessionId: runtime.sessionId,
              turnId,
              block,
            })
          }
        }

        if (message.type === 'result') {
          this.liveStateBySession.delete(runtime.sessionId)
          runtime.currentTurnId = null
          runtime.streamAccumulator = null
          const completedAt = Date.now()
          if (message.is_error) {
            this.publish(runtime.sessionId, {
              type: 'live.turn.failed',
              projectId: runtime.projectId,
              sessionId: runtime.sessionId,
              turnId,
              completedAt,
              error: message.subtype === 'success' ? 'Turn failed' : message.errors.join('\n') || 'Turn failed',
            })
          } else {
            this.publish(runtime.sessionId, {
              type: 'live.turn.completed',
              projectId: runtime.projectId,
              sessionId: runtime.sessionId,
              turnId,
              completedAt,
              raw: message,
            })
          }
        }
      }
    } catch (error) {
      const turnId = runtime.currentTurnId
      if (turnId) {
        this.publish(runtime.sessionId, {
          type: 'live.turn.failed',
          projectId: runtime.projectId,
          sessionId: runtime.sessionId,
          turnId,
          completedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        })
      }
    } finally {
      runtime.currentTurnId = null
      runtime.streamAccumulator = null
      this.liveStateBySession.delete(runtime.sessionId)
      this.runtimes.delete(runtime.sessionId)
    }
  }

  private publish(sessionId: string, event: SessionStreamEvent): void {
    if (this.liveEventStore) {
      try {
        this.liveEventStore.append(event)
      } catch (error) {
        console.error('live-events:append failed', error)
      }
    }
    for (const subscriber of this.subscribers.get(sessionId) ?? []) subscriber(event)
  }
}
