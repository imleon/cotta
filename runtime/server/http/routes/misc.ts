import type { Hono } from 'hono'
import { getLarkConfigStatus } from '../helpers.js'

type Logger = {
  debug: (event: string, fields?: Record<string, unknown>) => void
}

type Config = {
  authEnabled: boolean
  lark: {
    appId: string
    appSecret: string
    encryptKey: string
    verificationToken: string
    botName: string
  }
}

export function registerMiscRoutes(app: Hono<any, any, any>, input: {
  logger: Logger
  config: Config
}) {
  app.get('/api/health', (c) => {
    input.logger.debug('http:health', { authEnabled: input.config.authEnabled })
    return c.json({ status: 'ok', authEnabled: input.config.authEnabled })
  })

  app.get('/api/channels/lark', (c) => {
    return c.json(getLarkConfigStatus(input.config.lark))
  })
}
