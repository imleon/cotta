import type { Hono } from 'hono'

type Logger = {
  debug: (event: string, fields?: Record<string, unknown>) => void
}

type Config = {
  authEnabled: boolean
}

export function registerMiscRoutes(app: Hono<any, any, any>, input: {
  logger: Logger
  config: Config
}) {
  app.get('/api/health', (c) => {
    input.logger.debug('http:health', { authEnabled: input.config.authEnabled })
    return c.json({ status: 'ok', authEnabled: input.config.authEnabled })
  })

}
