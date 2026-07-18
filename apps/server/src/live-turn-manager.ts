import { randomUUID } from 'node:crypto'
import { query, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionStreamEvent, TurnSummary } from '@cotta/shared'
import { projectPathFromId } from './claude-code-api.js'
import type { LiveEventStore } from './live-event-store.js'

function randomId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

type LiveSessionState = 'idle' | 'running' | 'requires_action'
type VisibleLiveSessionState = Exclude<LiveSessionState, 'idle'>

function liveSessionStateFromSdkMessage(message: SDKMessage): LiveSessionState | null {
  if (message.type !== 'system' || !('subtype' in message) || message.subtype !== 'session_state_changed') return null
  if (!('state' in message) || typeof message.state !== 'string') return null
  return message.state === 'idle' || message.state === 'running' || message.state === 'requires_action' ? message.state : null
}

export type LiveTurnSubscriber = (event: SessionStreamEvent) => void

export class LiveTurnManager {
  private readonly subscribers = new Map<string, Set<LiveTurnSubscriber>>()
  private readonly liveQueries = new Map<string, Query>()
  private readonly liveTurnBySession = new Map<string, string>()
  private readonly liveProjectByTurn = new Map<string, string>()
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

  async startTurn(input: { projectId: string; sessionId?: string; text: string }): Promise<{ sessionId: string; turnId: string }> {
    const projectPath = projectPathFromId(input.projectId)
    if (!projectPath) throw new Error('Invalid project id')
    const turnId = randomId('turn')
    const startedAt = Date.now()
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
