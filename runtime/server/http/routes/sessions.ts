import type { Hono } from 'hono'
import type { StaticConfigRegistry } from '../../../config/registry.js'
import type { Orchestrator } from '../../../orchestration/orchestrator.js'
import type { SessionRegistry } from '../../../orchestration/session-registry.js'
import { getProjectDirs } from '../helpers.js'

type Logger = {
  info: (event: string, fields?: Record<string, unknown>) => void
  error: (event: string, fields?: Record<string, unknown>) => void
}

type SessionSummary = {
  id: string
  title: string
  updatedAt: number
}

type SessionsPage = {
  messages: unknown[]
  hasMore: boolean
  nextBefore: string | null
  error?: string
}

export function registerSessionRoutes(app: Hono<any, any, any>, input: {
  logger: Logger
  shortId: (value?: string | null) => string | undefined
  configRegistry: StaticConfigRegistry
  sessionRegistry: SessionRegistry
  orchestrator: Orchestrator
  listAllSessions: () => Promise<SessionSummary[]>
  listSessionsByProjectDirs: (dirs: string[]) => Promise<SessionSummary[]>
  getMessagesPage: (sessionId: string, opts: { limit: number; before: string | null; projectDirs: string[] }) => Promise<SessionsPage>
}) {
  app.get('/api/sessions', async (c) => {
    const startedAt = Date.now()
    try {
      const projectDirs = getProjectDirs(input.configRegistry)
      const sessions = projectDirs.length > 0
        ? await input.listSessionsByProjectDirs(projectDirs)
        : await input.listAllSessions()
      const runtimeBySessionId = new Map(
        input.sessionRegistry.list().map((record) => [record.sessionId, record]),
      )
      return c.json({
        sessions: sessions.map((session) => {
          const runtime = runtimeBySessionId.get(session.id)
          return {
            ...session,
            ...(runtime
              ? {
                  agentId: runtime.agentId,
                  channelId: runtime.channelId,
                  workerRef: runtime.workerRef,
                  sessionStatus: runtime.sessionStatus,
                  activeRunId: runtime.activeRunId,
                }
              : {}),
          }
        }),
      })
    } catch (err) {
      input.logger.error('http:sessions:list:error', {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      })
      return c.json({ sessions: [], error: String(err) })
    }
  })

  app.get('/api/sessions/:id', (c) => {
    const id = c.req.param('id')
    const session = input.sessionRegistry.get(id)
    return c.json({ session })
  })

  app.get('/api/sessions/:id/messages', async (c) => {
    const startedAt = Date.now()
    try {
      const id = c.req.param('id')
      const limit = parseInt(c.req.query('limit') || '50', 10)
      const before = c.req.query('before') || null
      input.logger.info('http:messages:start', {
        sessionId: input.shortId(id),
        limit,
        before: before ? input.shortId(before) : null,
      })
      const page = await input.getMessagesPage(id, { limit, before, projectDirs: getProjectDirs(input.configRegistry) })
      input.logger.info('http:messages:success', {
        sessionId: input.shortId(id),
        limit,
        before: before ? input.shortId(before) : null,
        count: page.messages.length,
        hasMore: page.hasMore,
        nextBefore: page.nextBefore ? input.shortId(page.nextBefore) : null,
        durationMs: Date.now() - startedAt,
      })
      return c.json(page)
    } catch (err) {
      input.logger.error('http:messages:error', {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      })
      return c.json({ messages: [], hasMore: false, nextBefore: null, error: String(err) })
    }
  })

  app.post('/api/sessions/:id/interrupt', async (c) => {
    try {
      const id = c.req.param('id')
      if (!id.trim()) {
        return c.json({ error: 'sessionId is required' }, 400)
      }
      const accepted = await input.orchestrator.interruptSession(id.trim())
      return c.json(accepted)
    } catch (error) {
      input.logger.error('http:sessions:interrupt:error', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: error instanceof Error ? error.message : 'Failed to interrupt session' }, 500)
    }
  })

  app.post('/api/sessions/:id/stop', async (c) => {
    try {
      const id = c.req.param('id')
      if (!id.trim()) {
        return c.json({ error: 'sessionId is required' }, 400)
      }
      const result = await input.orchestrator.stopSession(id.trim())
      return c.json(result)
    } catch (error) {
      input.logger.error('http:sessions:stop:error', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: error instanceof Error ? error.message : 'Failed to stop session' }, 500)
    }
  })

  app.post('/api/sessions/:id/rebuild', async (c) => {
    try {
      const id = c.req.param('id')
      if (!id.trim()) {
        return c.json({ error: 'sessionId is required' }, 400)
      }
      const result = await input.orchestrator.rebuildSession(id.trim())
      return c.json(result)
    } catch (error) {
      input.logger.error('http:sessions:rebuild:error', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: error instanceof Error ? error.message : 'Failed to rebuild session' }, 500)
    }
  })

  app.post('/api/sessions/:id/control', async (c) => {
    try {
      const id = c.req.param('id')
      const body = await c.req.json().catch(() => null)
      const subtype = body?.subtype
      if (!id.trim()) {
        return c.json({ error: 'sessionId is required' }, 400)
      }
      if (subtype !== 'interrupt' && subtype !== 'get_context_usage' && subtype !== 'mcp_status') {
        return c.json({ error: 'Unsupported control subtype' }, 400)
      }
      const accepted = await input.orchestrator.requestControlSession(id.trim(), subtype)
      return c.json(accepted)
    } catch (error) {
      input.logger.error('http:sessions:control:error', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: error instanceof Error ? error.message : 'Failed to request session control' }, 500)
    }
  })
}
