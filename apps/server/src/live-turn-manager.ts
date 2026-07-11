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

function textFromAssistantMessage(message: SDKMessage): string {
  if (!('message' in message) || !isRecord(message.message)) return ''
  const content = message.message.content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => isRecord(block) && typeof block.text === 'string' ? block.text : '')
    .filter(Boolean)
    .join('\n')
}

function timelineBlockFromSdkMessage(message: SDKMessage): TimelineBlock | null {
  const uuid = 'uuid' in message && typeof message.uuid === 'string' ? message.uuid : randomId('raw')
  if (message.type === 'assistant') {
    const text = textFromAssistantMessage(message)
    return {
      id: `${uuid}:assistant`,
      kind: text ? 'assistant.text' : 'assistant.message',
      sourceEventIds: [uuid],
      data: text ? { text, raw: message } : message,
    }
  }

  if (message.type === 'stream_event') {
    const eventType = isRecord(message.event) && typeof message.event.type === 'string' ? message.event.type : 'unknown'
    return {
      id: `${uuid}:stream`,
      kind: `stream.${eventType}`,
      sourceEventIds: [uuid],
      data: jsonData(message.event),
    }
  }

  if (message.type === 'result') return null

  return {
    id: `${uuid}:raw`,
    kind: `raw.${message.type}`,
    sourceEventIds: [uuid],
    data: message,
  }
}

export type LiveTurnSubscriber = (event: SessionStreamEvent) => void

export class LiveTurnManager {
  private readonly subscribers = new Map<string, Set<LiveTurnSubscriber>>()
  private readonly liveQueries = new Map<string, Query>()
  private readonly liveTurnBySession = new Map<string, string>()
  private readonly liveProjectByTurn = new Map<string, string>()

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
    let sessionId = input.sessionId ?? randomUUID()
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
            const turn: TurnSummary = {
              id: turnId,
              sessionId,
              title: input.text.length > 80 ? `${input.text.slice(0, 77)}…` : input.text,
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
          this.publish(currentSessionId, {
            type: 'live.raw',
            projectId: input.projectId,
            sessionId: currentSessionId,
            turnId,
            raw: message,
          })

          const block = timelineBlockFromSdkMessage(message)
          if (block) {
            this.publish(currentSessionId, {
              type: 'live.timeline.block',
              projectId: input.projectId,
              sessionId: currentSessionId,
              turnId,
              block,
            })
          }

          if (message.type === 'result') {
            if (message.is_error) {
              this.publish(currentSessionId, {
                type: 'live.turn.failed',
                projectId: input.projectId,
                sessionId: currentSessionId,
                turnId,
                error: message.subtype === 'success' ? 'Turn failed' : message.errors.join('\n') || 'Turn failed',
              })
            } else {
              this.publish(currentSessionId, {
                type: 'live.turn.completed',
                projectId: input.projectId,
                sessionId: currentSessionId,
                turnId,
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
            error: error instanceof Error ? error.message : String(error),
          })
        }
      } finally {
        this.liveQueries.delete(turnId)
        this.liveProjectByTurn.delete(turnId)
        if (sessionId) this.liveTurnBySession.delete(sessionId)
      }
    })()

    if (sessionId) {
      this.liveTurnBySession.set(sessionId, turnId)
      this.publish(sessionId, {
        type: 'live.turn.started',
        projectId: input.projectId,
        sessionId,
        turnId,
        turn: {
          id: turnId,
          sessionId,
          title: input.text.length > 80 ? `${input.text.slice(0, 77)}…` : input.text,
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
    this.publish(sessionId, {
      type: 'live.turn.interrupted',
      projectId: this.liveProjectByTurn.get(turnId) ?? '',
      sessionId,
      turnId,
    })
    return true
  }

  private publish(sessionId: string, event: SessionStreamEvent): void {
    for (const subscriber of this.subscribers.get(sessionId) ?? []) subscriber(event)
  }
}
