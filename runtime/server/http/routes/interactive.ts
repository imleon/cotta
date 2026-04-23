import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { Orchestrator } from '../../../orchestration/orchestrator.js'
import type { AppEnv } from '../app-env.js'
import {
  getValidatedBody,
  getValidatedParams,
  sendInternalError,
  validateJsonBody,
  validateParams,
} from '../validation.js'

const SessionIdParamSchema = z.object({
  id: z.string().trim().min(1, 'sessionId is required'),
})
type SessionIdParams = z.infer<typeof SessionIdParamSchema>

const RespondBodySchema = z.object({
  requestId: z.string().trim().min(1, 'requestId is required'),
  kind: z.enum(['permission', 'elicitation']),
  response: z.unknown(),
})
type RespondBody = z.infer<typeof RespondBodySchema>

const CancelBodySchema = z.object({
  requestId: z.string().trim().min(1, 'requestId is required'),
})
type CancelBody = z.infer<typeof CancelBodySchema>

export function registerInteractiveRoutes(app: Hono<AppEnv>, input: {
  orchestrator: Orchestrator
}) {
  const respondHandlers = [
    validateParams(SessionIdParamSchema),
    validateJsonBody(RespondBodySchema),
  ] as const

  const handleRespond = async (c: Context<AppEnv>) => {
    const { id: sessionId } = getValidatedParams<SessionIdParams>(c)
    const { requestId, kind, response } = getValidatedBody<RespondBody>(c)
    try {
      await input.orchestrator.respondToInteraction({ sessionId, requestId, kind, response })
      return c.json({ ok: true })
    } catch (error) {
      c.get('logger').error('http:interactive:respond:error', {
        error: error instanceof Error ? error.message : String(error),
      })
      return sendInternalError(c, 'interaction_respond_failed', error)
    }
  }

  app.post('/api/sessions/:id/control/respond', ...respondHandlers, handleRespond)
  app.post('/api/sessions/:id/interactive/respond', ...respondHandlers, handleRespond)

  app.post(
    '/api/sessions/:id/control/cancel',
    validateParams(SessionIdParamSchema),
    validateJsonBody(CancelBodySchema),
    async (c) => {
      const { id: sessionId } = getValidatedParams<SessionIdParams>(c)
      const { requestId } = getValidatedBody<CancelBody>(c)
      try {
        await input.orchestrator.cancelControl({ sessionId, requestId })
        return c.json({ ok: true })
      } catch (error) {
        c.get('logger').error('http:control:cancel:error', {
          error: error instanceof Error ? error.message : String(error),
        })
        return sendInternalError(c, 'control_cancel_failed', error)
      }
    },
  )
}
