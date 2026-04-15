import type { Hono } from 'hono'
import type { Orchestrator } from '../../../orchestration/orchestrator.js'

type Logger = {
  error: (event: string, fields?: Record<string, unknown>) => void
}

export function registerInteractiveRoutes(app: Hono<any, any, any>, input: {
  logger: Logger
  orchestrator: Orchestrator
}) {
  const handleRespond = async (c: any) => {
    try {
      const sessionId = c.req.param('id')
      const body = await c.req.json().catch(() => null)
      const requestId = body?.requestId
      const kind = body?.kind
      const response = body?.response
      if (!sessionId.trim()) return c.json({ error: 'sessionId is required' }, 400)
      if (typeof requestId !== 'string' || !requestId.trim()) return c.json({ error: 'requestId is required' }, 400)
      if (kind !== 'permission' && kind !== 'elicitation') return c.json({ error: 'Unsupported interaction kind' }, 400)
      await input.orchestrator.respondToInteraction({ sessionId: sessionId.trim(), requestId: requestId.trim(), kind, response })
      return c.json({ ok: true })
    } catch (error) {
      input.logger.error('http:interactive:respond:error', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: error instanceof Error ? error.message : 'Failed to respond to interaction' }, 500)
    }
  }

  app.post('/api/sessions/:id/control/respond', handleRespond)
  app.post('/api/sessions/:id/interactive/respond', handleRespond)

  app.post('/api/sessions/:id/control/cancel', async (c) => {
    try {
      const sessionId = c.req.param('id')
      const body = await c.req.json().catch(() => null)
      const requestId = body?.requestId
      if (!sessionId.trim()) return c.json({ error: 'sessionId is required' }, 400)
      if (typeof requestId !== 'string' || !requestId.trim()) return c.json({ error: 'requestId is required' }, 400)
      await input.orchestrator.cancelControl({
        sessionId: sessionId.trim(),
        requestId: requestId.trim(),
      })
      return c.json({ ok: true })
    } catch (error) {
      input.logger.error('http:control:cancel:error', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: error instanceof Error ? error.message : 'Failed to cancel control request' }, 500)
    }
  })
}
