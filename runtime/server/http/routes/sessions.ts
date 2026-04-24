import type { Hono } from 'hono'
import { z } from 'zod'
import type { ConfigRegistry } from '../../../config/registry.js'
import type { Orchestrator } from '../../../orchestration/orchestrator.js'
import type { SessionRegistry } from '../../../orchestration/session-registry.js'
import type { AppEnv } from '../app-env.js'
import { getProjectDirs } from '../helpers.js'
import {
  getValidatedBody,
  getValidatedParams,
  getValidatedQuery,
  sendInternalError,
  validateJsonBody,
  validateParams,
  validateQuery,
} from '../validation.js'

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

const SessionIdParamSchema = z.object({
  id: z.string().trim().min(1, 'sessionId is required'),
})
type SessionIdParams = z.infer<typeof SessionIdParamSchema>

const MessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  before: z
    .string()
    .trim()
    .min(1)
    .optional()
    .transform((value) => value ?? null),
})
type MessagesQuery = z.infer<typeof MessagesQuerySchema>

const ControlBodySchema = z.object({
  subtype: z.enum(['interrupt', 'get_context_usage', 'mcp_status']),
})
type ControlBody = z.infer<typeof ControlBodySchema>

const RecoverBodySchema = z.object({
  interruptTimeoutMs: z.number().int().min(0).max(60_000).optional(),
}).default({})
type RecoverBody = z.infer<typeof RecoverBodySchema>

export function registerSessionRoutes(app: Hono<AppEnv>, input: {
  shortId: (value?: string | null) => string | undefined
  configRegistry: ConfigRegistry
  sessionRegistry: SessionRegistry
  orchestrator: Orchestrator
  listSessionsByProjectDirs: (dirs: string[]) => Promise<SessionSummary[]>
  getMessagesPage: (sessionId: string, opts: { limit: number; before: string | null; projectDirs: string[] }) => Promise<SessionsPage>
}) {
  app.get('/api/sessions', async (c) => {
    const startedAt = Date.now()
    const logger = c.get('logger')
    try {
      const projectDirs = getProjectDirs(input.configRegistry)
      const sessions = projectDirs.length > 0
        ? await input.listSessionsByProjectDirs(projectDirs)
        : []
      const runtimeBySessionId = new Map(
        input.sessionRegistry.list().map((record) => [record.sessionId, record]),
      )
      return c.json({
        sessions: sessions.map((session) => {
          const runtime = runtimeBySessionId.get(session.id)
          return {
            ...session,
            sessionScope: runtime?.sessionScope ?? 'foreign',
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
      logger.error('http:sessions:list:error', {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      })
      return sendInternalError(c, 'sessions_list_failed', err)
    }
  })

  app.get('/api/sessions/:id', validateParams(SessionIdParamSchema), (c) => {
    const { id } = getValidatedParams<SessionIdParams>(c)
    const session = input.sessionRegistry.get(id)
    return c.json({
      session: session ? { ...session, sessionScope: session.sessionScope ?? 'managed' } : null,
    })
  })

  app.get(
    '/api/sessions/:id/messages',
    validateParams(SessionIdParamSchema),
    validateQuery(MessagesQuerySchema),
    async (c) => {
      const startedAt = Date.now()
      const logger = c.get('logger')
      const { id } = getValidatedParams<SessionIdParams>(c)
      const { limit, before } = getValidatedQuery<MessagesQuery>(c)
      try {
        logger.info('http:messages:start', {
          sessionId: input.shortId(id),
          limit,
          before: before ? input.shortId(before) : null,
        })
        const page = await input.getMessagesPage(id, {
          limit,
          before,
          projectDirs: getProjectDirs(input.configRegistry),
        })
        logger.info('http:messages:success', {
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
        logger.error('http:messages:error', {
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startedAt,
        })
        return sendInternalError(c, 'session_messages_failed', err)
      }
    },
  )

  app.post(
    '/api/sessions/:id/interrupt',
    validateParams(SessionIdParamSchema),
    async (c) => {
      const { id } = getValidatedParams<SessionIdParams>(c)
      try {
        const accepted = await input.orchestrator.interruptSession(id)
        return c.json(accepted)
      } catch (error) {
        c.get('logger').error('http:sessions:interrupt:error', {
          error: error instanceof Error ? error.message : String(error),
        })
        return sendInternalError(c, 'session_interrupt_failed', error)
      }
    },
  )

  app.post(
    '/api/sessions/:id/stop',
    validateParams(SessionIdParamSchema),
    async (c) => {
      const { id } = getValidatedParams<SessionIdParams>(c)
      try {
        const result = await input.orchestrator.stopSession(id)
        return c.json(result)
      } catch (error) {
        c.get('logger').error('http:sessions:stop:error', {
          error: error instanceof Error ? error.message : String(error),
        })
        return sendInternalError(c, 'session_stop_failed', error)
      }
    },
  )

  app.post(
    '/api/sessions/:id/rebuild',
    validateParams(SessionIdParamSchema),
    async (c) => {
      const { id } = getValidatedParams<SessionIdParams>(c)
      try {
        const result = await input.orchestrator.rebuildSession(id)
        return c.json(result)
      } catch (error) {
        c.get('logger').error('http:sessions:rebuild:error', {
          error: error instanceof Error ? error.message : String(error),
        })
        return sendInternalError(c, 'session_rebuild_failed', error)
      }
    },
  )

  // Standard recovery workflow: interrupt -> stop -> rebuild.
  app.post(
    '/api/sessions/:id/recover',
    validateParams(SessionIdParamSchema),
    validateJsonBody(RecoverBodySchema),
    async (c) => {
      const { id } = getValidatedParams<SessionIdParams>(c)
      const { interruptTimeoutMs } = getValidatedBody<RecoverBody>(c)
      try {
        const result = await input.orchestrator.recoverSession(id, { interruptTimeoutMs })
        return c.json(result)
      } catch (error) {
        c.get('logger').error('http:sessions:recover:error', {
          error: error instanceof Error ? error.message : String(error),
        })
        return sendInternalError(c, 'session_recover_failed', error)
      }
    },
  )

  app.post(
    '/api/sessions/:id/control',
    validateParams(SessionIdParamSchema),
    validateJsonBody(ControlBodySchema),
    async (c) => {
      const { id } = getValidatedParams<SessionIdParams>(c)
      const { subtype } = getValidatedBody<ControlBody>(c)
      try {
        const accepted = await input.orchestrator.requestControlSession(id, subtype)
        return c.json(accepted)
      } catch (error) {
        c.get('logger').error('http:sessions:control:error', {
          error: error instanceof Error ? error.message : String(error),
        })
        return sendInternalError(c, 'session_control_failed', error)
      }
    },
  )
}
