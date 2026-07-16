import type { Hono } from 'hono'
import {
  createTurnRequestSchema,
  type CreateTurnResponse,
  type ProjectResponse,
  type ProjectsResponse,
  type ProjectSessionsResponse,
  type SessionRawMessagesResponse,
  type SessionTimelineResponse,
  type SessionTimelineStateResponse,
} from '@cotta/shared'
import type { ClaudeCodeApi } from '../claude-code-api.js'
import type { LiveTurnManager } from '../live-turn-manager.js'
import { projectSessionTimeline } from '../timeline-projection.js'

export type ProjectRoutesLiveTurnManager = Pick<LiveTurnManager, 'interrupt' | 'sessionState' | 'startTurn' | 'subscribe'>

function parseLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(100, Math.trunc(parsed)))
}

function parseCursor(value: string | undefined): string | null {
  return value && value.trim() ? value.trim() : null
}

function encodeSse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

export function registerProjectRoutes(
  app: Hono,
  input: { claudeCodeApi: ClaudeCodeApi; liveTurnManager: ProjectRoutesLiveTurnManager },
): void {
  app.get('/api/projects', async (c) => {
    try {
      const response: ProjectsResponse = {
        projects: await input.claudeCodeApi.listProjects(),
      }
      return c.json(response)
    } catch (error) {
      console.error('projects:list failed', error)
      return c.json({ error: 'projects_list_failed' }, 500)
    }
  })

  app.get('/api/projects/:projectId', async (c) => {
    try {
      const project = await input.claudeCodeApi.getProject(c.req.param('projectId'))
      if (!project) {
        return c.json({ error: 'project_not_found' }, 404)
      }
      const response: ProjectResponse = { project }
      return c.json(response)
    } catch (error) {
      console.error('projects:get failed', error)
      return c.json({ error: 'project_get_failed' }, 500)
    }
  })

  app.get('/api/projects/:projectId/sessions', async (c) => {
    try {
      const result = await input.claudeCodeApi.listProjectSessions(c.req.param('projectId'), {
        limit: parseLimit(c.req.query('limit'), 10),
        cursor: parseCursor(c.req.query('cursor')),
      })
      if (!result) {
        return c.json({ error: 'project_not_found' }, 404)
      }
      const response: ProjectSessionsResponse = {
        ...result,
        sessions: result.sessions.map((session) => {
          const liveState = input.liveTurnManager.sessionState(session.id)
          return liveState ? { ...session, rawStatus: liveState, displayStatus: liveState } : session
        }),
      }
      return c.json(response)
    } catch (error) {
      console.error('projects:sessions failed', error)
      return c.json({ error: 'project_sessions_failed' }, 500)
    }
  })

  app.post('/api/projects/:projectId/sessions', async (c) => {
    try {
      const body = createTurnRequestSchema.parse(await c.req.json())
      const result = await input.liveTurnManager.startTurn({
        projectId: c.req.param('projectId'),
        text: body.text,
      })
      const response: CreateTurnResponse = {
        projectId: c.req.param('projectId'),
        sessionId: result.sessionId,
        turnId: result.turnId,
      }
      return c.json(response, 202)
    } catch (error) {
      console.error('sessions:create failed', error)
      return c.json({ error: 'session_create_failed' }, 500)
    }
  })

  app.post('/api/projects/:projectId/sessions/:sessionId/turns', async (c) => {
    try {
      const body = createTurnRequestSchema.parse(await c.req.json())
      const result = await input.liveTurnManager.startTurn({
        projectId: c.req.param('projectId'),
        sessionId: c.req.param('sessionId'),
        text: body.text,
      })
      const response: CreateTurnResponse = {
        projectId: c.req.param('projectId'),
        sessionId: result.sessionId,
        turnId: result.turnId,
      }
      return c.json(response, 202)
    } catch (error) {
      console.error('turns:create failed', error)
      return c.json({ error: 'turn_create_failed' }, 500)
    }
  })

  app.post('/api/projects/:projectId/sessions/:sessionId/turns/:turnId/interrupt', async (c) => {
    try {
      const interrupted = await input.liveTurnManager.interrupt(c.req.param('sessionId'))
      return c.json({ interrupted })
    } catch (error) {
      console.error('turns:interrupt failed', error)
      return c.json({ error: 'turn_interrupt_failed' }, 500)
    }
  })

  app.get('/api/projects/:projectId/sessions/:sessionId/events', (c) => {
    const sessionId = c.req.param('sessionId')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(encoder.encode(': connected\n\n'))
        const unsubscribe = input.liveTurnManager.subscribe(sessionId, (event) => {
          controller.enqueue(encoder.encode(encodeSse(event)))
        })
        c.req.raw.signal.addEventListener('abort', () => {
          unsubscribe()
          controller.close()
        }, { once: true })
      },
    })
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  })

  app.get('/api/projects/:projectId/sessions/:sessionId/timeline/state', async (c) => {
    try {
      const state = await input.claudeCodeApi.getSessionTimelineState(
        c.req.param('projectId'),
        c.req.param('sessionId'),
      )
      if (!state) {
        return c.json({ error: 'session_not_found' }, 404)
      }
      const response: SessionTimelineStateResponse = { state }
      return c.json(response)
    } catch (error) {
      console.error('session:timeline-state failed', error)
      return c.json({ error: 'session_timeline_state_failed' }, 500)
    }
  })

  app.get('/api/projects/:projectId/sessions/:sessionId/timeline', async (c) => {
    try {
      const state = await input.claudeCodeApi.getSessionTimelineState(
        c.req.param('projectId'),
        c.req.param('sessionId'),
      )
      if (!state) {
        return c.json({ error: 'session_not_found' }, 404)
      }
      const messages = await input.claudeCodeApi.getSessionMessages(
        c.req.param('projectId'),
        c.req.param('sessionId'),
      )
      if (!messages) {
        return c.json({ error: 'session_not_found' }, 404)
      }
      const response: SessionTimelineResponse = {
        ...projectSessionTimeline(c.req.param('sessionId'), messages, {
          limitTurns: parseLimit(c.req.query('limitTurns'), 20),
          cursor: parseCursor(c.req.query('cursor')),
        }),
        state,
      }
      return c.json(response)
    } catch (error) {
      console.error('session:timeline failed', error)
      return c.json({ error: 'session_timeline_failed' }, 500)
    }
  })

  app.get('/api/projects/:projectId/sessions/:sessionId/raw-messages', async (c) => {
    try {
      const messages = await input.claudeCodeApi.getSessionMessages(
        c.req.param('projectId'),
        c.req.param('sessionId'),
      )
      if (!messages) {
        return c.json({ error: 'session_not_found' }, 404)
      }
      const response: SessionRawMessagesResponse = {
        sessionId: c.req.param('sessionId'),
        messages,
      }
      return c.json(response)
    } catch (error) {
      console.error('session:raw-messages failed', error)
      return c.json({ error: 'session_raw_messages_failed' }, 500)
    }
  })
}
