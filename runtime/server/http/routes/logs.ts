import type { Hono } from 'hono'

type Logger = {
  error: (event: string, fields?: Record<string, unknown>) => void
}

type LogsPage = {
  items: unknown[]
  hasMore: boolean
  nextCursor: number | null
  error?: string
}

export function registerLogRoutes(app: Hono<any, any, any>, input: {
  logger: Logger
  readSessionSdkRawLogs: (sessionId: string, cursor: number | null, limit: number, follow: boolean, full: boolean) => Promise<LogsPage>
  readSessionPersistentLogs: (sessionId: string, cursor: number | null, limit: number, follow: boolean) => Promise<LogsPage>
}) {
  app.get('/api/sessions/:id/sdk-raw-logs', async (c) => {
    const startedAt = Date.now()
    try {
      const id = c.req.param('id')
      const limit = parseInt(c.req.query('limit') || '100', 10)
      const cursorRaw = c.req.query('cursor')
      const follow = c.req.query('follow') === '1'
      const full = c.req.query('full') === '1'
      const cursor = cursorRaw ? parseInt(cursorRaw, 10) : null
      const page = await input.readSessionSdkRawLogs(id, Number.isFinite(cursor) ? cursor : null, limit, follow, full)
      return c.json(page)
    } catch (err) {
      input.logger.error('http:sdk-raw-logs:error', {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      })
      return c.json({ items: [], hasMore: false, nextCursor: null, error: String(err) })
    }
  })

  app.get('/api/sessions/:id/persistent-logs', async (c) => {
    const startedAt = Date.now()
    try {
      const id = c.req.param('id')
      const limit = parseInt(c.req.query('limit') || '100', 10)
      const cursorRaw = c.req.query('cursor')
      const follow = c.req.query('follow') === '1'
      const cursor = cursorRaw ? parseInt(cursorRaw, 10) : null
      const page = await input.readSessionPersistentLogs(id, Number.isFinite(cursor) ? cursor : null, limit, follow)
      return c.json(page)
    } catch (err) {
      input.logger.error('http:persistent-logs:error', {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      })
      return c.json({ items: [], hasMore: false, nextCursor: null, error: String(err) })
    }
  })
}

