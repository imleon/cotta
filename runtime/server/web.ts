import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { UpgradeWebSocket } from 'hono/ws'
import type { AppEnv } from './http/app-env.js'
import { createRequestContextMiddleware } from './http/request-context.js'
import type { ServerContext } from './context.js'
import { createWebSocketHandler } from './ws.js'
import { createApiAuthMiddleware, createWsAuthMiddleware } from './http/auth.js'
import { registerMiscRoutes } from './http/routes/misc.js'
import { registerLarkRoutes } from './http/routes/lark.js'
import { registerAgentRoutes } from './http/routes/agents.js'
import { registerRunRoutes } from './http/routes/runs.js'
import { registerSessionRoutes } from './http/routes/sessions.js'
import { registerInteractiveRoutes } from './http/routes/interactive.js'
import { registerLogRoutes } from './http/routes/logs.js'
import { registerChannelBindingRoutes } from './http/routes/channel-bindings.js'
import { registerConfigRoutes } from './http/routes/config.js'
import { registerStatusRoutes } from './http/routes/status.js'

export function createWebRoutes(upgradeWebSocket: UpgradeWebSocket, context: ServerContext) {
  const app = new Hono<AppEnv>()

  app.use('*', cors())
  // Inject request-scoped logger & requestId into Hono context, so every downstream
  // handler / middleware can rely on `c.get('logger')` and `c.get('requestId')`.
  app.use('*', createRequestContextMiddleware({ logger: context.logger }))

  app.use('/api/*', createApiAuthMiddleware({
    config: context.config,
    logger: context.logger,
    allowPaths: new Set([
      '/api/health',
      '/api/channels/lark/inbound',
      '/api/channels/lark/card-action',
    ]),
  }))

  registerMiscRoutes(app, { config: context.config })
  registerLarkRoutes(app, { larkIntegration: context.larkIntegration })
  registerAgentRoutes(app, { defaultAgentId: context.defaultAgentId, configRegistry: context.configRegistry })
  registerRunRoutes(app, { orchestrator: context.orchestrator, runRegistry: context.runRegistry })
  registerSessionRoutes(app, {
    shortId: context.shortId,
    configRegistry: context.configRegistry,
    sessionRegistry: context.sessionRegistry,
    orchestrator: context.orchestrator,
    listSessionsByProjectDirs: context.listSessionsByProjectDirs,
    getMessagesPage: context.getMessagesPage,
  })
  registerInteractiveRoutes(app, { orchestrator: context.orchestrator })
  registerLogRoutes(app, {
    readSessionSdkRawLogs: context.readSessionSdkRawLogs,
    readSessionPersistentLogs: context.readSessionPersistentLogs,
  })
  registerChannelBindingRoutes(app, {
    configRepository: context.configRepository,
    sessionRegistry: context.sessionRegistry,
    listSessionsByProjectDir: context.listSessionsByProjectDir,
  })
  registerConfigRoutes(app, {
    configDbPath: context.configDbPath,
    configRepository: context.configRepository,
    sessionRegistry: context.sessionRegistry,
  })
  registerStatusRoutes(app, {
    config: context.config,
    configRegistry: context.configRegistry,
    sessionRegistry: context.sessionRegistry,
    runRegistry: context.runRegistry,
    listSessionsByProjectDir: context.listSessionsByProjectDir,
    listSessionsByProjectDirs: context.listSessionsByProjectDirs,
    getWorkerHealthBySessionId: context.getWorkerHealthBySessionId,
  })

  app.use('/ws', createWsAuthMiddleware({ config: context.config, logger: context.logger }))

  app.get('/ws', createWebSocketHandler(upgradeWebSocket, { orchestrator: context.orchestrator }))

  return app
}
