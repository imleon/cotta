import type { Hono } from 'hono'
import { SessionBusyError, type Orchestrator } from '../../../orchestration/orchestrator.js'
import type { RunRegistry } from '../../../orchestration/run-registry.js'

type Logger = {
  error: (event: string, fields?: Record<string, unknown>) => void
}

export function registerRunRoutes(app: Hono<any, any, any>, input: {
  logger: Logger
  orchestrator: Orchestrator
  runRegistry: RunRegistry
}) {
  app.post('/api/runs', async (c) => {
    try {
      const body = await c.req.json()
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
      const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : ''
      const text = typeof body?.text === 'string' ? body.text : ''
      const mode = body?.mode === 'new' ? 'new' : 'resume'

      if (!sessionId || !agentId || !text) {
        return c.json({ error: 'sessionId, agentId, text are required' }, 400)
      }

      const accepted = await input.orchestrator.dispatchRun({ sessionId, agentId, text, mode })
      return c.json(accepted)
    } catch (error) {
      input.logger.error('http:runs:create:error', {
        error: error instanceof Error ? error.message : String(error),
      })
      if (error instanceof SessionBusyError) {
        return c.json({
          error: 'session_busy',
          message: 'Session already has an active run',
          sessionId: error.sessionId,
          activeRunId: error.activeRunId,
          sessionStatus: error.sessionStatus,
        }, 409)
      }
      return c.json({ error: 'Failed to create run' }, 500)
    }
  })

  app.get('/api/runs/:id', (c) => {
    const id = c.req.param('id')
    const run = input.runRegistry.get(id)
    return c.json({ run })
  })
}
