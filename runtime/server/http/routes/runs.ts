import type { Hono } from 'hono'
import { z } from 'zod'
import { SessionBusyError, type Orchestrator } from '../../../orchestration/orchestrator.js'
import type { RunRegistry } from '../../../orchestration/run-registry.js'
import type { AppEnv } from '../app-env.js'
import {
  getValidatedBody,
  getValidatedParams,
  sendError,
  sendInternalError,
  validateJsonBody,
  validateParams,
} from '../validation.js'

const CreateRunBodySchema = z.object({
  sessionId: z.string().trim().min(1, 'sessionId is required'),
  agentId: z.string().trim().min(1, 'agentId is required'),
  text: z.string().min(1, 'text is required'),
  mode: z.enum(['new', 'resume']).default('resume'),
})
type CreateRunBody = z.infer<typeof CreateRunBodySchema>

const RunIdParamSchema = z.object({
  id: z.string().trim().min(1, 'run id is required'),
})
type RunIdParams = z.infer<typeof RunIdParamSchema>

export function registerRunRoutes(app: Hono<AppEnv>, input: {
  orchestrator: Orchestrator
  runRegistry: RunRegistry
}) {
  app.post('/api/runs', validateJsonBody(CreateRunBodySchema), async (c) => {
    const body = getValidatedBody<CreateRunBody>(c)
    try {
      const accepted = await input.orchestrator.dispatchRun(body)
      return c.json(accepted)
    } catch (error) {
      if (error instanceof SessionBusyError) {
        return sendError(c, 409, 'session_busy', 'Session already has an active run', {
          details: {
            sessionId: error.sessionId,
            activeRunId: error.activeRunId,
            sessionStatus: error.sessionStatus,
          },
        })
      }
      c.get('logger').error('http:runs:create:error', {
        error: error instanceof Error ? error.message : String(error),
      })
      return sendInternalError(c, 'run_create_failed', error)
    }
  })

  app.get('/api/runs/:id', validateParams(RunIdParamSchema), (c) => {
    const { id } = getValidatedParams<RunIdParams>(c)
    const run = input.runRegistry.get(id)
    return c.json({ run })
  })
}
