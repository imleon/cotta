import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'
import { createAuth, type CottaAuth } from './auth.js'
import { createClaudeCodeApi, projectIdFromPath, type ClaudeCodeApi } from './claude-code-api.js'
import { createCottaDatabase } from './database.js'
import { createLiveEventStore, type LiveEventStore } from './live-event-store.js'
import { LiveTurnManager } from './live-turn-manager.js'
import { defaultModelCatalogProvider, type ModelCatalogProvider } from './model-catalog.js'
import { registerHealthRoute } from './routes/health.js'
import { registerProjectRoutes, type ProjectRoutesLiveTurnManager, type ProjectRoutesSessionObservationReader, type ProjectRoutesTimelineMetadataReader } from './routes/projects.js'
import { createClaudeSessionRegistry } from './claude-session-registry.js'
import { SessionSummaryCache } from './session-summary-cache.js'
import { createSettingsStore, type SettingsStore } from './settings-store.js'
import { SessionMetaStore } from './session-meta-store.js'
import { TurnMetaTranscriptStore } from './turn-meta-transcript.js'
import { resolveTurnOptions, validateTurnOptions } from './turn-options.js'

setGlobalDispatcher(new EnvHttpProxyAgent())

export function createApp(input: {
  claudeCodeApi?: ClaudeCodeApi
  liveTurnManager?: ProjectRoutesLiveTurnManager
  liveEventStore?: LiveEventStore
  sessionSummaryCache?: SessionSummaryCache
  modelCatalogProvider?: ModelCatalogProvider
  settingsStore?: SettingsStore
  sessionMetaStore?: SessionMetaStore
  sessionObservationReader?: ProjectRoutesSessionObservationReader
  claudeSessionRegistry?: Pick<Awaited<ReturnType<typeof createClaudeSessionRegistry>>, 'cliRunState' | 'cliSessionMetadata'>
  timelineMetadataReader?: ProjectRoutesTimelineMetadataReader
  turnMetaTranscriptReader?: Pick<TurnMetaTranscriptStore, 'listEntries'>
  auth?: CottaAuth
} = {}): Hono {
  const app = new Hono()
  const liveEventStore = input.liveEventStore ?? (process.env.NODE_ENV === 'test' ? undefined : createLiveEventStore())
  const sessionSummaryCache = input.sessionSummaryCache ?? (input.claudeCodeApi || input.liveTurnManager ? undefined : new SessionSummaryCache())
  const claudeCodeApi = input.claudeCodeApi ?? createClaudeCodeApi(sessionSummaryCache)
  const liveTurnManager = input.liveTurnManager ?? new LiveTurnManager(liveEventStore, sessionSummaryCache)
  const modelCatalogProvider = input.modelCatalogProvider ?? defaultModelCatalogProvider
  const settingsStore = input.settingsStore
  const auth = input.auth ?? (process.env.NODE_ENV === 'test' ? createAuth({ github: { clientId: '' }, settingsStore }) : createAuth({ settingsStore }))
  sessionSummaryCache?.setSessionRunStateReader((sessionId) => liveTurnManager.sessionRunState(sessionId) ?? input.claudeSessionRegistry?.cliRunState(sessionId) ?? null)
  sessionSummaryCache?.setSessionMetadataReader?.((sessionId) => input.claudeSessionRegistry?.cliSessionMetadata(sessionId) ?? null)
  void sessionSummaryCache?.ensureReady().catch((error) => console.error('session-summary-cache:ensure-ready failed', error))
  app.use('*', auth.middleware)
  registerHealthRoute(app)
  auth.registerRoutes(app)
  registerProjectRoutes(app, { claudeCodeApi, liveTurnManager, modelCatalogProvider, liveEventStore, sessionSummaryCache, settingsStore, sessionMetaStore: input.sessionMetaStore, sessionObservationReader: input.sessionObservationReader, sessionMetadataReader: (sessionId) => input.claudeSessionRegistry?.cliSessionMetadata(sessionId) ?? null, timelineMetadataReader: input.timelineMetadataReader, turnMetaTranscriptReader: input.turnMetaTranscriptReader })
  return app
}

const host = process.env.HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? 3000)

if (process.env.NODE_ENV !== 'test') {
  const liveEventStore = createLiveEventStore()
  const sessionSummaryCache = new SessionSummaryCache()
  const cottaDb = createCottaDatabase()
  const settingsStore = createSettingsStore(cottaDb)
  const sessionMetaStore = new SessionMetaStore(cottaDb)
  const turnMetaStore = new TurnMetaTranscriptStore(cottaDb, { settingsStore })
  await turnMetaStore.repairIncompleteTranscripts()
  sessionSummaryCache.setChangedListener((changes) => turnMetaStore.syncSessions(changes))
  const claudeCodeApi = createClaudeCodeApi(sessionSummaryCache, {
    timelineVersionProvider: (projectId, sessionId, baseVersion) => turnMetaStore.timelineVersion(projectId, sessionId, baseVersion),
  })
  const liveTurnManager = new LiveTurnManager(liveEventStore, sessionSummaryCache)
  const claudeSessionRegistry = await createClaudeSessionRegistry().catch((error) => {
    console.error('claude-session-registry:start failed', error)
    return null
  })
  const unsubscribeRegistry = claudeSessionRegistry?.subscribe(({ changedSessions, activeSessionIds, idleSessionIds }) => {
    const projectIdsBySessionId = new Map<string, string>()
    for (const { sessionId, cwd } of changedSessions) {
      const projectId = cwd ? projectIdFromPath(cwd) : undefined
      if (projectId) projectIdsBySessionId.set(sessionId, projectId)
      sessionSummaryCache.observeSession({ sessionId, ...(projectId ? { projectId } : {}) })
    }
    for (const sessionId of activeSessionIds) {
      void liveTurnManager.closeForExternalOwner(sessionId).catch((error) => console.error(`live-runtime:external owner close failed for ${sessionId}`, error))
    }
    for (const sessionId of idleSessionIds) {
      const projectId = projectIdsBySessionId.get(sessionId)
      if (!projectId) continue
      const options = resolveTurnOptions({ projectId, sessionId, settingsStore, sessionMetaStore })
      const validation = validateTurnOptions(options, settingsStore)
      if (!validation.ok) {
        console.error(`live-runtime:CLI idle rebuild skipped for ${sessionId}: ${validation.error}`)
        continue
      }
      void liveTurnManager.rebuildRuntimeAfterCliIdle(sessionId, {
        permissionMode: options.permissionMode,
        model: options.model,
        effort: options.effort,
      }).catch((error) => console.error(`live-runtime:CLI idle rebuild failed for ${sessionId}`, error))
    }
  })
  const app = createApp({
    claudeCodeApi,
    liveEventStore,
    liveTurnManager,
    sessionSummaryCache,
    settingsStore,
    sessionMetaStore,
    sessionObservationReader: claudeSessionRegistry ?? undefined,
    claudeSessionRegistry: claudeSessionRegistry ?? undefined,
    timelineMetadataReader: (projectId, sessionId) => turnMetaStore.loadTimelineMetadata(projectId, sessionId),
    turnMetaTranscriptReader: turnMetaStore,
  })

  const server = serve(
    {
      fetch: app.fetch,
      hostname: host,
      port,
    },
    () => {
      console.log(`Cotta server listening on http://${host}:${port}`)
    },
  )

  const shutdown = () => {
    liveTurnManager.closeAll()
    unsubscribeRegistry?.()
    sessionSummaryCache.close()
    void claudeSessionRegistry?.close()
    turnMetaStore.close()
    cottaDb.close()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1000).unref()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Cotta server failed to start: http://${host}:${port} is already in use.`)
      console.error('Stop the process using that port, or start Cotta with a different PORT.')
      liveTurnManager.closeAll()
      unsubscribeRegistry?.()
      sessionSummaryCache.close()
      void claudeSessionRegistry?.close()
      turnMetaStore.close()
      cottaDb.close()
      process.exitCode = 1
      return
    }

    throw error
  })
}
