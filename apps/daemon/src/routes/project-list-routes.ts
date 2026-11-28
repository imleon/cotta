import {
  type ListVersionsEvent,
  type ProjectSessionSearchResponse,
  type ProjectSessionsQueryResponse,
  type ProjectSessionsResponse,
  type ProjectSummary,
  type ProjectsResponse,
  projectSessionSearchRequestSchema,
  projectSessionSearchResponseSchema,
  projectSessionsQueryResponseSchema,
  projectSessionsQuerySchema,
  type SessionSummary,
  sessionPinsResponseSchema,
} from '@cotta/shared'
import type { Hono } from 'hono'
import { toSessionSummary } from '../claude-code-api.js'
import { ListCursorError } from '../list-cursor.js'
import { overlayLiveSessionRunState, ProjectReadModelError, readProjectSessions } from '../project-read-model.js'
import type { ProjectRoutesInput } from './project-routes-shared.js'
import { createSseHeartbeat, locateSession, parseCursor, parseLimit, resolveSessionProject } from './project-routes-shared.js'

function encodeSse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function listCursorErrorResponse(error: unknown) {
  if (!(error instanceof ListCursorError)) return null
  return error.code === 'stale' ? { status: 409 as const, body: { error: 'pagination_cursor_stale' } } : { status: 400 as const, body: { error: 'invalid_cursor' } }
}

async function resolveSessionIdentity(input: ProjectRoutesInput, projectId: string, sessionId: string): Promise<{ project: ProjectSummary; session: SessionSummary } | null> {
  const project = await input.claudeCodeApi.getProject(projectId)
  const indexedSession = resolveSessionProject(input, sessionId)
  return project && indexedSession?.currentProjectId === projectId ? { project, session: toSessionSummary(indexedSession) } : null
}

export function registerProjectListRoutes(app: Hono, input: ProjectRoutesInput): void {
  app.get('/api/projects', async (c) => {
    try {
      const response: ProjectsResponse = await input.claudeCodeApi.listProjects({
        limit: parseLimit(c.req.query('limit'), 20),
        cursor: parseCursor(c.req.query('cursor')),
      })
      return c.json(response)
    } catch (error) {
      const cursorError = listCursorErrorResponse(error)
      if (cursorError) return c.json(cursorError.body, cursorError.status)
      console.error('projects:list failed', error)
      return c.json({ error: 'projects_list_failed' }, 500)
    }
  })

  app.get('/api/projects/:projectId/sessions', async (c) => {
    try {
      const response: ProjectSessionsResponse = await readProjectSessions(input, {
        projectId: c.req.param('projectId'),
        limit: parseLimit(c.req.query('limit'), 10),
        cursor: parseCursor(c.req.query('cursor')),
      })
      return c.json(response)
    } catch (error) {
      if (error instanceof ProjectReadModelError && error.code === 'project_not_found') return c.json({ error: error.code }, 404)
      const cursorError = listCursorErrorResponse(error)
      if (cursorError) return c.json(cursorError.body, cursorError.status)
      console.error('projects:sessions failed', error)
      return c.json({ error: 'project_sessions_failed' }, 500)
    }
  })

  app.get('/api/session-pins', async (c) => {
    try {
      if (!input.sessionPinStore) return c.json({ error: 'session_pins_unavailable' }, 503)
      await input.claudeCodeApi.listProjects({ limit: 1 })
      const pins = input.sessionPinStore.listPins()
      const resolved = await Promise.all(pins.map(async (pin) => ({ pin, value: await resolveSessionIdentity(input, pin.projectId, pin.sessionId) })))
      const entries = resolved.flatMap(({ pin, value }) => (value ? [{ pinnedAtMs: pin.pinnedAtMs, ...value }] : []))
      const overlaid = overlayLiveSessionRunState(input.liveTurnManager, { sessions: entries.map((entry) => entry.session) }, input.sessionMetadataReader)
      return c.json(
        sessionPinsResponseSchema.parse({
          pins: entries.map((entry, index) => ({ ...entry, session: overlaid.sessions[index] ?? entry.session })),
        }),
      )
    } catch (error) {
      console.error('session-pins:list failed', error)
      return c.json({ error: 'session_pins_list_failed' }, 500)
    }
  })

  app.post('/api/project-sessions/query', async (c) => {
    try {
      const body = projectSessionsQuerySchema.parse(await c.req.json())
      const sessionsByProject: ProjectSessionsQueryResponse['sessionsByProject'] = {}
      await Promise.all(
        body.projects.map(async ({ projectId, limit, selectedSessionId }) => {
          const result = await input.claudeCodeApi.listProjectSessions(projectId, { limit, cursor: null })
          const indexedSelectedSession = selectedSessionId ? resolveSessionProject(input, selectedSessionId) : null
          const selectedSessionDetail = indexedSelectedSession?.currentProjectId
            ? overlayLiveSessionRunState(input.liveTurnManager, { sessions: [toSessionSummary(indexedSelectedSession)] }, input.sessionMetadataReader).sessions[0]
            : null
          if (!result) {
            if (selectedSessionId) sessionsByProject[projectId] = { sessions: [], hasMore: false, nextCursor: null, selectedSessionExists: false, selectedSessionDetail }
            return
          }
          const baseWindow = overlayLiveSessionRunState(
            input.liveTurnManager,
            {
              sessions: result.sessions,
              hasMore: result.hasMore,
              nextCursor: result.nextCursor,
            },
            input.sessionMetadataReader,
          )
          const window: ProjectSessionsQueryResponse['sessionsByProject'][string] = selectedSessionId
            ? {
                ...baseWindow,
                project: result.project,
                selectedSessionExists: selectedSessionDetail?.projectId === projectId,
                selectedSessionDetail,
              }
            : baseWindow
          sessionsByProject[projectId] = window
        }),
      )
      const response: ProjectSessionsQueryResponse = projectSessionsQueryResponseSchema.parse({ sessionsByProject })
      return c.json(response)
    } catch (error) {
      console.error('project-sessions:query failed', error)
      return c.json({ error: 'project_sessions_query_failed' }, 500)
    }
  })

  app.post('/api/project-sessions/search', async (c) => {
    try {
      if (!input.sessionSearchStore || !input.sessionSearchReady) return c.json({ error: 'project_sessions_search_unavailable' }, 503)
      const parsed = projectSessionSearchRequestSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return c.json({ error: 'invalid_project_sessions_search' }, 400)
      const normalizedQuery = parsed.data.query.trim()
      if ([...normalizedQuery].length < 2) return c.json({ error: 'project_sessions_search_query_too_short' }, 400)
      await input.sessionSearchReady()
      const base = input.sessionSearchStore.search({ query: normalizedQuery, cursor: parsed.data.cursor })
      const overlaid = overlayLiveSessionRunState(input.liveTurnManager, { sessions: base.results.map((result) => result.session) }, input.sessionMetadataReader)
      const response: ProjectSessionSearchResponse = projectSessionSearchResponseSchema.parse({
        ...base,
        results: base.results.map((result, index) => ({ ...result, session: overlaid.sessions[index] ?? result.session })),
      })
      return c.json(response)
    } catch (error) {
      const cursorError = listCursorErrorResponse(error)
      if (cursorError) return c.json(cursorError.body, cursorError.status)
      console.error('project-sessions:search failed', error)
      return c.json({ error: 'project_sessions_search_failed' }, 500)
    }
  })

  app.get('/api/list-versions/events', (c) => {
    const notifier = input.indexChangeNotifier
    if (!notifier) return c.json({ error: 'list_versions_unavailable' }, 503)
    let cleanup = () => {}
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const buffered: ListVersionsEvent[] = []
        let snapshotSent = false
        let closed = false
        let releaseTaskWatcher: (() => void) | null = null
        let releaseSubagentWatcher: (() => void) | null = null
        let send = (event: ListVersionsEvent): void => {
          buffered.push(event)
        }
        const unsubscribe = notifier.subscribe((event: ListVersionsEvent) => send(event))
        const heartbeat = createSseHeartbeat(
          controller,
          c.req.raw.signal,
          () => {
            closed = true
          },
          () => releaseTaskWatcher?.(),
          () => releaseSubagentWatcher?.(),
          unsubscribe,
        )
        send = (event) => (snapshotSent ? void heartbeat.enqueue(encodeSse(event)) : buffered.push(event))
        cleanup = heartbeat.cleanup
        try {
          if (!heartbeat.enqueue(': connected\n\n')) return
          const projectId = c.req.query('projectId')
          const sessionId = c.req.query('sessionId')
          const selectedSession = projectId && sessionId ? locateSession(input, sessionId) : null
          const selectedProjectId = selectedSession?.currentProjectId === projectId ? projectId : null
          if (selectedProjectId && sessionId && input.refreshTaskSnapshot && input.sessionWatcherRegistry) {
            const release = await input.sessionWatcherRegistry
              .acquireTask(sessionId, async () => {
                await input.refreshTaskSnapshot?.(sessionId)
              })
              .catch((error) => {
                console.error(`session-task-watcher:start failed for ${sessionId}`, error)
                return null
              })
            if (closed) {
              release?.()
              return
            }
            releaseTaskWatcher = release
            await input.refreshTaskSnapshot(sessionId, selectedProjectId).catch((error) => console.error(`session-task-snapshot:initial refresh failed for ${sessionId}`, error))
          }
          if (selectedProjectId && sessionId && selectedSession?.transcriptPath && input.refreshSubagentIndex && input.sessionWatcherRegistry) {
            const release = await input.sessionWatcherRegistry
              .acquireSubagent(sessionId, selectedSession.transcriptPath, async () => {
                if (await input.refreshSubagentIndex?.(sessionId)) input.indexChangeNotifier?.publishSubagentChange?.(selectedProjectId, sessionId)
              })
              .catch((error) => {
                console.error(`session-subagent-watcher:start failed for ${sessionId}`, error)
                return null
              })
            if (closed) {
              release?.()
              return
            }
            releaseSubagentWatcher = release
            await input
              .refreshSubagentIndex(sessionId)
              .then((changed) => {
                if (changed) input.indexChangeNotifier?.publishSubagentChange?.(selectedProjectId, sessionId)
              })
              .catch((error) => console.error(`session-subagents:initial refresh failed for ${sessionId}`, error))
          }
          if (closed) return
          const version = selectedProjectId && sessionId ? input.selectedSessionVersionReader?.(selectedProjectId, sessionId) : null
          const snapshot = selectedProjectId && sessionId && notifier.snapshot ? notifier.snapshot({ projectId: selectedProjectId, sessionId, version }) : notifier.versionSnapshot
          if (!heartbeat.enqueue(encodeSse(snapshot))) return
          snapshotSent = true
          for (const event of buffered) if (!heartbeat.enqueue(encodeSse(event))) return
        } catch (error) {
          heartbeat.cleanup()
          throw error
        }
      },
      cancel() {
        cleanup()
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

  app.post('/api/projects/refresh', async (c) => {
    try {
      if (!input.syncTranscriptIndex || !input.indexChangeNotifier) return c.json({ error: 'projects_refresh_unavailable' }, 503)
      await input.syncTranscriptIndex()
      input.indexChangeNotifier.publishChange()
      return c.json({ ok: true })
    } catch (error) {
      console.error('projects:refresh failed', error)
      return c.json({ error: 'projects_refresh_failed' }, 500)
    }
  })

  app.post('/api/projects/:projectId/refresh', async (c) => {
    try {
      if (!input.syncTranscriptIndex || !input.indexChangeNotifier) return c.json({ error: 'projects_refresh_unavailable' }, 503)
      const projectId = c.req.param('projectId')
      await input.syncTranscriptIndex({ projectId })
      input.indexChangeNotifier.publishChange({ projectId })
      return c.json({ ok: true })
    } catch (error) {
      console.error('project:refresh failed', error)
      return c.json({ error: 'project_refresh_failed' }, 500)
    }
  })
}
