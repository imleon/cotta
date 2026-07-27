import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'
import { createAuth, type CottaAuth } from './auth.js'
import { createClaudeCodeApi, type ClaudeCodeApi } from './claude-code-api.js'
import { createLiveEventStore, type LiveEventStore } from './live-event-store.js'
import { LiveTurnManager } from './live-turn-manager.js'
import { defaultModelCatalogProvider, type ModelCatalogProvider } from './model-catalog.js'
import { registerHealthRoute } from './routes/health.js'
import { registerProjectRoutes, type ProjectRoutesLiveTurnManager } from './routes/projects.js'
import { SessionSummaryCache } from './session-summary-cache.js'
import { createSettingsStore, type SettingsStore } from './settings-store.js'

setGlobalDispatcher(new EnvHttpProxyAgent())

export function createApp(input: {
  claudeCodeApi?: ClaudeCodeApi
  liveTurnManager?: ProjectRoutesLiveTurnManager
  liveEventStore?: LiveEventStore
  sessionSummaryCache?: SessionSummaryCache
  modelCatalogProvider?: ModelCatalogProvider
  settingsStore?: SettingsStore
  auth?: CottaAuth
} = {}): Hono {
  const app = new Hono()
  const liveEventStore = input.liveEventStore ?? (process.env.NODE_ENV === 'test' ? undefined : createLiveEventStore())
  const sessionSummaryCache = input.sessionSummaryCache ?? (input.claudeCodeApi || input.liveTurnManager ? undefined : new SessionSummaryCache())
  const claudeCodeApi = input.claudeCodeApi ?? createClaudeCodeApi(sessionSummaryCache)
  const liveTurnManager = input.liveTurnManager ?? new LiveTurnManager(liveEventStore, sessionSummaryCache)
  const modelCatalogProvider = input.modelCatalogProvider ?? defaultModelCatalogProvider
  const settingsStore = input.settingsStore ?? (process.env.NODE_ENV === 'test' ? undefined : createSettingsStore())
  const auth = input.auth ?? (process.env.NODE_ENV === 'test' ? createAuth({ github: { clientId: '' }, settingsStore }) : createAuth({ settingsStore }))
  sessionSummaryCache?.setSessionRunStateReader((sessionId) => liveTurnManager.sessionRunState(sessionId))
  void sessionSummaryCache?.ensureReady().catch((error) => console.error('session-summary-cache:ensure-ready failed', error))
  app.use('*', auth.middleware)
  registerHealthRoute(app)
  auth.registerRoutes(app)
  registerProjectRoutes(app, { claudeCodeApi, liveTurnManager, modelCatalogProvider, liveEventStore, sessionSummaryCache, settingsStore })
  return app
}

const host = process.env.HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? 3000)

if (process.env.NODE_ENV !== 'test') {
  const server = serve(
    {
      fetch: createApp().fetch,
      hostname: host,
      port,
    },
    () => {
      console.log(`Cotta server listening on http://${host}:${port}`)
    },
  )

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Cotta server failed to start: http://${host}:${port} is already in use.`)
      console.error('Stop the process using that port, or start Cotta with a different PORT.')
      process.exitCode = 1
      return
    }

    throw error
  })
}
