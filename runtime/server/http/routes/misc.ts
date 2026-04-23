import type { Hono } from 'hono'
import type { AppEnv } from '../app-env.js'

type Config = {
  authEnabled: boolean
}

export function registerMiscRoutes(app: Hono<AppEnv>, input: {
  config: Config
}) {
  app.get('/api/health', (c) => {
    c.get('logger').debug('http:health', { authEnabled: input.config.authEnabled })
    return c.json({ status: 'ok', authEnabled: input.config.authEnabled })
  })
}
