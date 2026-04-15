import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { UpgradeWebSocket } from 'hono/ws'
import { createServerContext } from './context.js'
import { createWebSocketHandler } from './ws.js'
import { createApiAuthMiddleware, createWsAuthMiddleware } from './http/auth.js'
import { registerMiscRoutes } from './http/routes/misc.js'
import { registerLarkRoutes } from './http/routes/lark.js'
import { registerAgentRoutes } from './http/routes/agents.js'
import { registerRunRoutes } from './http/routes/runs.js'
import { registerSessionRoutes } from './http/routes/sessions.js'
import { registerInteractiveRoutes } from './http/routes/interactive.js'
import { registerLogRoutes } from './http/routes/logs.js'
import { registerSettingsRoutes } from './http/routes/settings.js'
import { registerStatusRoutes } from './http/routes/status.js'

export function createWebRoutes(upgradeWebSocket: UpgradeWebSocket) {
  const context = createServerContext()
  const app = new Hono()

  app.use('*', cors())

  app.use('/api/*', createApiAuthMiddleware({
    config: context.config,
    logger: context.logger,
    allowPaths: new Set([
      '/api/health',
      '/api/channels/lark/inbound',
      '/api/channels/lark/card-action',
    ]),
  }))

  registerMiscRoutes(app, { logger: context.logger, config: context.config })
  registerLarkRoutes(app, { logger: context.logger, larkIntegration: context.larkIntegration })
  registerAgentRoutes(app, { defaultAgentId: context.defaultAgentId, configRegistry: context.configRegistry })
  registerRunRoutes(app, { logger: context.logger, orchestrator: context.orchestrator, runRegistry: context.runRegistry })
  registerSessionRoutes(app, {
    logger: context.logger,
    shortId: context.shortId,
    configRegistry: context.configRegistry,
    sessionRegistry: context.sessionRegistry,
    orchestrator: context.orchestrator,
    listAllSessions: context.listAllSessions,
    listSessionsByProjectDirs: context.listSessionsByProjectDirs,
    getMessagesPage: context.getMessagesPage,
  })
  registerInteractiveRoutes(app, { logger: context.logger, orchestrator: context.orchestrator })
  registerLogRoutes(app, {
    logger: context.logger,
    readSessionSdkRawLogs: context.readSessionSdkRawLogs,
    readSessionPersistentLogs: context.readSessionPersistentLogs,
  })
  registerSettingsRoutes(app, { logger: context.logger })
  registerStatusRoutes(app, {
    logger: context.logger,
    config: context.config,
    configRegistry: context.configRegistry,
    sessionRegistry: context.sessionRegistry,
    runRegistry: context.runRegistry,
    listAllSessions: context.listAllSessions,
    listSessionsByProjectDir: context.listSessionsByProjectDir,
    listSessionsByProjectDirs: context.listSessionsByProjectDirs,
  })

  app.use('/ws', createWsAuthMiddleware({ config: context.config, logger: context.logger }))

  app.get('/ws', createWebSocketHandler(upgradeWebSocket))

  return app
}
