import { randomUUID } from 'node:crypto'
import { query, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionStreamEvent, TimelineBlock, TurnSummary } from '@cotta/shared'
import { projectPathFromId } from './claude-code-api.js'

function randomId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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

const debugLiveIds = process.env.COTTA_DEBUG_LIVE_IDS === '1'

type LiveSessionState = 'idle' | 'running' | 'requires_action'
type VisibleLiveSessionState = Exclude<LiveSessionState, 'idle'>

function liveSessionStateFromSdkMessage(message: SDKMessage): LiveSessionState | null {
  if (message.type !== 'system' || !('subtype' in message) || message.subtype !== 'session_state_changed') return null
  if (!('state' in message) || typeof message.state !== 'string') return null
  return message.state === 'idle' || message.state === 'running' || message.state === 'requires_action' ? message.state : null
}

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
  messageStartEventUuid?: string
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
      this.current = this.createDraft(apiMessageId, sourceEventId)
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
    if (debugLiveIds) {
      console.info('[live-ids]', {
        turnId: this.turnId,
        ordinal: draft.ordinal,
        messageStartApiId: draft.apiMessageId ?? null,
        finalAssistantMessageId: apiMessageId ?? null,
        messageStartEventUuid: draft.messageStartEventUuid ?? null,
        finalAssistantUuid: uuid,
        apiMessageIdMatches: draft.apiMessageId !== undefined && apiMessageId !== undefined
          ? draft.apiMessageId === apiMessageId
          : null,
        uuidMatches: draft.messageStartEventUuid !== undefined
          ? draft.messageStartEventUuid === uuid
          : null,
      })
    }

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

  private createDraft(apiMessageId?: string, messageStartEventUuid?: string): LiveAssistantMessageDraft {
    const draft: LiveAssistantMessageDraft = {
      ordinal: this.nextAssistantOrdinal++,
      apiMessageId,
      messageStartEventUuid,
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

function timelineBlocksFromSdkMessage(message: SDKMessage): TimelineBlock[] {
  const uuid = sdkMessageUuid(message)
  if (message.type === 'assistant') {
    const content = sdkMessageContent(message)
    if (!Array.isArray(content)) {
      return [{
        id: `${uuid}:assistant`,
        kind: 'assistant.message',
        sourceEventIds: [uuid],
        data: jsonData(message),
      }]
    }
    return content.map((block, index) => ({
      id: `${uuid}:assistant:${index}`,
      kind: blockKindForContentBlock(block),
      sourceEventIds: [uuid],
      ...toolUseMetadata(block),
      data: jsonData(block),
    }))
  }

  if (message.type === 'user') {
    const content = sdkMessageContent(message)
    if (isToolResultContent(content) && Array.isArray(content)) {
      const blocks = content
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
      if (blocks.length > 0) return blocks
    }
  }

  if (message.type === 'stream_event') {
    const eventType = isRecord(message.event) && typeof message.event.type === 'string' ? message.event.type : 'unknown'
    return [{
      id: `${uuid}:stream`,
      kind: `stream.${eventType}`,
      sourceEventIds: [uuid],
      data: jsonData(message.event),
    }]
  }

  if (message.type === 'result') return []

  return [{
    id: `${uuid}:raw`,
    kind: `raw.${message.type}`,
    sourceEventIds: [uuid],
    data: message,
  }]
}

export type LiveTurnSubscriber = (event: SessionStreamEvent) => void

export class LiveTurnManager {
  private readonly subscribers = new Map<string, Set<LiveTurnSubscriber>>()
  private readonly liveQueries = new Map<string, Query>()
  private readonly liveTurnBySession = new Map<string, string>()
  private readonly liveProjectByTurn = new Map<string, string>()
  private readonly liveStateBySession = new Map<string, VisibleLiveSessionState>()

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

  async startTurn(input: { projectId: string; sessionId?: string; text: string }): Promise<{ sessionId: string; turnId: string }> {
    const projectPath = projectPathFromId(input.projectId)
    if (!projectPath) throw new Error('Invalid project id')
    const turnId = randomId('turn')
    const startedAt = Date.now()
    let sessionId = input.sessionId ?? randomUUID()
    const streamAccumulator = new LiveAssistantStreamAccumulator(turnId)
    const q = query({
      prompt: input.text,
      options: {
        cwd: projectPath,
        ...(input.sessionId ? { resume: input.sessionId } : { sessionId }),
        includePartialMessages: true,
      },
    })

    this.liveQueries.set(turnId, q)
    this.liveProjectByTurn.set(turnId, input.projectId)

    void (async () => {
      try {
        for await (const message of q) {
          if (!sessionId && 'session_id' in message && typeof message.session_id === 'string') {
            sessionId = message.session_id
            this.liveTurnBySession.set(sessionId, turnId)
            this.liveStateBySession.set(sessionId, 'running')
            const turn: TurnSummary = {
              id: turnId,
              sessionId,
              title: input.text.length > 80 ? `${input.text.slice(0, 77)}…` : input.text,
              startedAt,
              rawStatus: 'running',
              displayStatus: 'running',
              blocks: [{
                id: `${turnId}:user`,
                kind: 'user.message',
                sourceEventIds: [turnId],
                data: { text: input.text },
              }],
            }
            this.publish(sessionId, {
              type: 'live.turn.started',
              projectId: input.projectId,
              sessionId,
              turnId,
              turn,
            })
          }

          const currentSessionId = sessionId ?? ('session_id' in message && typeof message.session_id === 'string' ? message.session_id : null)
          if (!currentSessionId) continue
          const liveState = liveSessionStateFromSdkMessage(message)
          if (liveState === 'idle') this.liveStateBySession.delete(currentSessionId)
          else if (liveState) this.liveStateBySession.set(currentSessionId, liveState)
          this.publish(currentSessionId, {
            type: 'live.raw',
            projectId: input.projectId,
            sessionId: currentSessionId,
            turnId,
            raw: message,
          })

          const timelineBlocks = message.type === 'stream_event'
            ? streamAccumulator.processStreamEvent(message)
            : message.type === 'assistant'
              ? streamAccumulator.finalAssistantBlocks(message)
              : timelineBlocksFromSdkMessage(message)
          for (const block of timelineBlocks) {
            this.publish(currentSessionId, {
              type: 'live.timeline.block',
              projectId: input.projectId,
              sessionId: currentSessionId,
              turnId,
              block,
            })
          }

          if (message.type === 'result') {
            this.liveStateBySession.delete(currentSessionId)
            const completedAt = Date.now()
            if (message.is_error) {
              this.publish(currentSessionId, {
                type: 'live.turn.failed',
                projectId: input.projectId,
                sessionId: currentSessionId,
                turnId,
                completedAt,
                error: message.subtype === 'success' ? 'Turn failed' : message.errors.join('\n') || 'Turn failed',
              })
            } else {
              this.publish(currentSessionId, {
                type: 'live.turn.completed',
                projectId: input.projectId,
                sessionId: currentSessionId,
                turnId,
                completedAt,
                raw: message,
              })
            }
          }
        }
      } catch (error) {
        if (sessionId) {
          this.publish(sessionId, {
            type: 'live.turn.failed',
            projectId: input.projectId,
            sessionId,
            turnId,
            completedAt: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          })
        }
      } finally {
        this.liveQueries.delete(turnId)
        this.liveProjectByTurn.delete(turnId)
        if (sessionId) {
          this.liveTurnBySession.delete(sessionId)
          this.liveStateBySession.delete(sessionId)
        }
      }
    })()

    if (sessionId) {
      this.liveTurnBySession.set(sessionId, turnId)
      this.liveStateBySession.set(sessionId, 'running')
      this.publish(sessionId, {
        type: 'live.turn.started',
        projectId: input.projectId,
        sessionId,
        turnId,
        turn: {
          id: turnId,
          sessionId,
          title: input.text.length > 80 ? `${input.text.slice(0, 77)}…` : input.text,
          startedAt,
          rawStatus: 'running',
          displayStatus: 'running',
          blocks: [{
            id: `${turnId}:user`,
            kind: 'user.message',
            sourceEventIds: [turnId],
            data: { text: input.text },
          }],
        },
      })
    }

    return { sessionId: sessionId ?? '', turnId }
  }

  async interrupt(sessionId: string): Promise<boolean> {
    const turnId = this.liveTurnBySession.get(sessionId)
    if (!turnId) return false
    const q = this.liveQueries.get(turnId)
    if (!q) return false
    await q.interrupt()
    this.liveStateBySession.delete(sessionId)
    this.publish(sessionId, {
      type: 'live.turn.interrupted',
      projectId: this.liveProjectByTurn.get(turnId) ?? '',
      sessionId,
      turnId,
      completedAt: Date.now(),
    })
    return true
  }

  private publish(sessionId: string, event: SessionStreamEvent): void {
    for (const subscriber of this.subscribers.get(sessionId) ?? []) subscriber(event)
  }
}
