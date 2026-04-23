import type { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.js'
import {
  getValidatedParams,
  getValidatedQuery,
  sendInternalError,
  validateParams,
  validateQuery,
} from '../validation.js'

type LogsPage = {
  items: unknown[]
  hasMore: boolean
  nextCursor: number | null
  error?: string
}

const SessionIdParamSchema = z.object({
  id: z.string().trim().min(1, 'sessionId is required'),
})
type SessionIdParams = z.infer<typeof SessionIdParamSchema>

const booleanFlag = z
  .enum(['0', '1', 'true', 'false'])
  .transform((v) => v === '1' || v === 'true')

const SdkRawLogsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  cursor: z.coerce.number().int().min(0).optional().transform((v) => (v === undefined ? null : v)),
  follow: booleanFlag.optional().transform((v) => v ?? false),
  full: booleanFlag.optional().transform((v) => v ?? false),
})
type SdkRawLogsQuery = z.infer<typeof SdkRawLogsQuerySchema>

const PersistentLogsQuerySchema = SdkRawLogsQuerySchema.pick({
  limit: true,
  cursor: true,
  follow: true,
})
type PersistentLogsQuery = z.infer<typeof PersistentLogsQuerySchema>

export function registerLogRoutes(app: Hono<AppEnv>, input: {
  readSessionSdkRawLogs: (sessionId: string, cursor: number | null, limit: number, follow: boolean, full: boolean) => Promise<LogsPage>
  readSessionPersistentLogs: (sessionId: string, cursor: number | null, limit: number, follow: boolean) => Promise<LogsPage>
}) {
  app.get(
    '/api/sessions/:id/sdk-raw-logs',
    validateParams(SessionIdParamSchema),
    validateQuery(SdkRawLogsQuerySchema),
    async (c) => {
      const startedAt = Date.now()
      const { id } = getValidatedParams<SessionIdParams>(c)
      const { limit, cursor, follow, full } = getValidatedQuery<SdkRawLogsQuery>(c)
      try {
        const page = await input.readSessionSdkRawLogs(id, cursor, limit, follow, full)
        return c.json(page)
      } catch (err) {
        c.get('logger').error('http:sdk-raw-logs:error', {
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startedAt,
        })
        return sendInternalError(c, 'sdk_raw_logs_failed', err)
      }
    },
  )

  app.get(
    '/api/sessions/:id/persistent-logs',
    validateParams(SessionIdParamSchema),
    validateQuery(PersistentLogsQuerySchema),
    async (c) => {
      const startedAt = Date.now()
      const { id } = getValidatedParams<SessionIdParams>(c)
      const { limit, cursor, follow } = getValidatedQuery<PersistentLogsQuery>(c)
      try {
        const page = await input.readSessionPersistentLogs(id, cursor, limit, follow)
        return c.json(page)
      } catch (err) {
        c.get('logger').error('http:persistent-logs:error', {
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startedAt,
        })
        return sendInternalError(c, 'persistent_logs_failed', err)
      }
    },
  )
}
