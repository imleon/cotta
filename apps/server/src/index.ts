import 'dotenv/config'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAdaptorServer } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { requestId } from 'hono/request-id'
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'
import { type CottaAuth, createAuth, noopAuth } from './auth.js'
import { type ClaudeCodeApi, createClaudeCodeApi, projectIdFromPath, projectPathFromId } from './claude-code-api.js'
import { createClaudeSessionRegistry } from './claude-session-registry.js'
import { createCottaDatabase } from './database.js'
import { loadDetailTokenKey } from './detail-token.js'
import { type IndexChangeInput, IndexChangeNotifier } from './index-change-notifier.js'
import { LiveTurnManager } from './live-turn-manager.js'
import { defaultModelCatalogProvider, type ModelCatalogProvider } from './model-catalog.js'
import { ProjectFilesWatcherRegistry } from './project-files-watcher-registry.js'
import { RawTranscriptCoordinator } from './raw-transcript-coordinator.js'
import { RemoteBotManager } from './remote-bot-manager.js'
import { registerHealthRoute } from './routes/health.js'
import { registerProjectFileRoutes } from './routes/project-files.js'
import { sessionActivity, sessionActivityVersion } from './routes/project-routes-shared.js'
import {
  type ProjectRoutesLiveTurnManager,
  type ProjectRoutesRawTranscriptCache,
  type ProjectRoutesSessionSearchReady,
  type ProjectRoutesSessionSearchStore,
  type ProjectRoutesTimelineMetadataReader,
  type ProjectRoutesTranscriptSyncer,
  registerProjectRoutes,
} from './routes/projects.js'
import { createRemoteBotStore, type RemoteBotConnectionStatus, type RemoteBotProjectExists, type RemoteBotReconcile, registerRemoteBotRoutes } from './routes/remote-bot-routes.js'
import { registerShareAdminRoutes, registerShareRoutes } from './routes/share-routes.js'
import { registerTokenUsageRoutes } from './routes/token-usage-routes.js'
import { SessionContextUsageStore } from './session-context-usage-store.js'
import { SessionPinStore } from './session-pin-store.js'
import { SessionRawTranscriptCacheStore, TranscriptUnavailableError } from './session-raw-transcript-cache.js'
import { SessionSearchStore } from './session-search-store.js'
import { SessionSubagentStore } from './session-subagent-store.js'
import { SessionWatcherRegistry } from './session-watcher-registry.js'
import { type SettingsStore, SqliteSettingsStore } from './settings-store.js'
import { ShareStore } from './share-store.js'
import { ensureGithubConfig } from './startup-config.js'
import { TerminalRegistry } from './terminal-registry.js'
import { attachTerminalWebSocket, isAllowedTerminalOrigin, parseTerminalOrigin } from './terminal-websocket.js'
import { TokenUsageStore } from './token-usage-store.js'
import type { TranscriptIndexStore } from './transcript-index-store.js'
import { TurnMetaTranscriptStore } from './turn-meta-transcript.js'
import { resolveTurnOptions, validateTurnOptions } from './turn-options.js'
import { TurnOptionsStore } from './turn-options-store.js'

setGlobalDispatcher(new EnvHttpProxyAgent())

type CreateAppOptions = {
  timelineVersionReader: (projectId: string, sessionId: string) => string
  liveTurnManager?: ProjectRoutesLiveTurnManager
  indexChangeNotifier?: Pick<IndexChangeNotifier, 'versionSnapshot' | 'subscribe' | 'publishChange'> &
    Partial<Pick<IndexChangeNotifier, 'snapshot' | 'observeSession' | 'publishSessionVersion' | 'publishSubagentChange'>>
  selectedSessionVersionReader?: (projectId: string, sessionId: string) => string | null
  refreshTaskSnapshot?: (sessionId: string, projectId?: string) => Promise<unknown>
  refreshSubagentIndex?: (sessionId: string) => Promise<boolean>
  subagentStore?: SessionSubagentStore
  sessionWatcherRegistry?: Pick<SessionWatcherRegistry, 'acquireTask' | 'acquireSubagent'>
  syncTranscriptIndex?: (input?: IndexChangeInput) => Promise<void>
  modelCatalogProvider?: ModelCatalogProvider
  settingsStore?: SettingsStore
  turnOptionsStore?: TurnOptionsStore
  sessionContextUsageStore?: SessionContextUsageStore
  sessionPinStore?: SessionPinStore
  claudeSessionRegistry?: Pick<Awaited<ReturnType<typeof createClaudeSessionRegistry>>, 'cliSessionMetadata'>
  timelineMetadataReader?: ProjectRoutesTimelineMetadataReader
  transcriptSyncer?: ProjectRoutesTranscriptSyncer
  rawTranscriptCache?: ProjectRoutesRawTranscriptCache
  sessionSearchStore?: ProjectRoutesSessionSearchStore
  sessionSearchReady?: ProjectRoutesSessionSearchReady
  auth?: CottaAuth
  tokenUsageStore?: TokenUsageStore
  tokenUsageReady?: () => Promise<void>
  tokenUsageRefresh?: () => Promise<void>
  projectFilesWatcherRegistry?: Pick<ProjectFilesWatcherRegistry, 'acquire'>
  terminalRegistry?: Pick<TerminalRegistry, 'available' | 'terminate'>
  terminalOrigin?: string
  remoteBotStore?: ReturnType<typeof createRemoteBotStore>
  reconcileRemoteBots?: RemoteBotReconcile
  remoteBotConnectionStatus?: RemoteBotConnectionStatus
  remoteBotProjectExists?: RemoteBotProjectExists
  detailTokenKey?: Buffer
  shareStore?: ShareStore
  webRoot?: string
}

type CreateAppInput =
  | (CreateAppOptions & { claudeCodeApi: ClaudeCodeApi; transcriptIndex: Pick<TranscriptIndexStore, 'getSession'> })
  | (CreateAppOptions & {
      claudeCodeApi?: undefined
      transcriptIndex: Pick<TranscriptIndexStore, 'getSession' | 'getProject' | 'listProjectsPage' | 'listProjectSessionsPage'>
    })

export function createApp(input: CreateAppInput): Hono {
  const app = new Hono()
  const indexChangeNotifier = input.indexChangeNotifier ?? (input.claudeCodeApi || input.liveTurnManager ? undefined : new IndexChangeNotifier())
  const rawTranscriptCache = input.rawTranscriptCache
  const claudeCodeApi = input.claudeCodeApi ? input.claudeCodeApi : createClaudeCodeApi({ transcriptIndex: input.transcriptIndex, timelineVersionProvider: input.timelineVersionReader })
  const liveTurnManager =
    input.liveTurnManager ??
    new LiveTurnManager(
      indexChangeNotifier?.observeSession ? { signalSessionActivity: indexChangeNotifier.observeSession.bind(indexChangeNotifier) } : undefined,
      undefined,
      input.sessionContextUsageStore,
      input.settingsStore,
    )
  const sessionSearchStore = input.sessionSearchStore
  const sessionSearchReady = input.sessionSearchReady
  const modelCatalogProvider = input.modelCatalogProvider ?? defaultModelCatalogProvider
  const sessionWatcherRegistry = input.sessionWatcherRegistry ?? new SessionWatcherRegistry()
  const projectFilesWatcherRegistry = input.projectFilesWatcherRegistry ?? new ProjectFilesWatcherRegistry()
  const settingsStore = input.settingsStore
  const auth = input.auth ?? (process.env.NODE_ENV === 'test' ? noopAuth() : createAuth({ settingsStore }))
  app.use('*', requestId())
  // Serve the bundled web app before auth: static assets and the SPA shell must load for an
  // unauthenticated visitor (otherwise the login page itself 401s). Only /api is a backend prefix;
  // /share and /detail are client-side SPA routes (backend lives under /api/share, /api/detail), so
  // they must fall back to the shell. Every other GET serves a file or the SPA index.
  if (input.webRoot) {
    const webRoot = input.webRoot
    const serveAsset = serveStatic({ root: webRoot })
    const serveIndex = serveStatic({ root: webRoot, path: 'index.html' })
    app.use('*', async (c, next) => {
      const path = c.req.path
      if (c.req.method !== 'GET' || path === '/api' || path.startsWith('/api/')) return next()
      // Serve a matching file; on miss (serveStatic calls the no-op next) return undefined. A missing
      // asset must 404, not get the HTML shell (a stale JS/CSS chunk served as text/html breaks the
      // browser); only navigation routes fall back to the SPA index.
      const hit = await serveAsset(c, async () => {})
      if (hit) return hit
      if (path.startsWith('/assets/')) return c.notFound()
      return serveIndex(c, next)
    })
  }
  app.use('*', auth.middleware)
  app.onError((error, c) => {
    const requestId = c.get('requestId') as string
    console.error(
      JSON.stringify({
        event: 'http_request_error',
        requestId,
        method: c.req.method,
        path: c.req.path,
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'UnknownError', message: String(error) },
      }),
    )
    return c.json({ error: 'internal_server_error', requestId }, 500)
  })
  registerHealthRoute(app)
  auth.registerRoutes(app)
  registerShareAdminRoutes(app, input.shareStore, auth, input.transcriptIndex)
  registerProjectFileRoutes(app, { claudeCodeApi, watcherRegistry: projectFilesWatcherRegistry })
  if (input.terminalRegistry) {
    app.get('/api/terminal', (context) => context.json({ available: input.terminalRegistry!.available() }))
    app.delete('/api/terminal', (context) => {
      if (!isAllowedTerminalOrigin(context.req.header('Origin'), input.terminalOrigin)) return context.json({ error: 'forbidden' }, 403)
      if (!input.terminalRegistry!.terminate()) return context.json({ error: 'terminal_not_found' }, 404)
      return context.json({ ok: true })
    })
  }
  registerTokenUsageRoutes(app, input.tokenUsageStore, input.tokenUsageReady, input.tokenUsageRefresh)
  if (input.remoteBotStore) registerRemoteBotRoutes(app, input.remoteBotStore, input.reconcileRemoteBots, input.remoteBotConnectionStatus, input.remoteBotProjectExists)
  const projectRoutesInput = {
    claudeCodeApi,
    liveTurnManager,
    modelCatalogProvider,
    indexChangeNotifier,
    selectedSessionVersionReader: input.selectedSessionVersionReader,
    timelineVersionReader: input.timelineVersionReader,
    refreshTaskSnapshot: input.refreshTaskSnapshot,
    refreshSubagentIndex: input.refreshSubagentIndex,
    subagentStore: input.subagentStore,
    sessionWatcherRegistry,
    syncTranscriptIndex: input.syncTranscriptIndex,
    settingsStore,
    turnOptionsStore: input.turnOptionsStore,
    sessionContextUsageStore: input.sessionContextUsageStore,
    sessionPinStore: input.sessionPinStore,
    sessionMetadataReader: (sessionId: string) => input.claudeSessionRegistry?.cliSessionMetadata(sessionId) ?? null,
    timelineMetadataReader: input.timelineMetadataReader,
    transcriptSyncer: input.transcriptSyncer,
    rawTranscriptCache,
    transcriptIndex: input.transcriptIndex,
    sessionSearchStore,
    sessionSearchReady,
    detailTokenKey: input.detailTokenKey,
    shareStore: input.shareStore,
  }
  registerProjectRoutes(app, projectRoutesInput)
  registerShareRoutes(app, projectRoutesInput, auth)
  return app
}

/**
 * Locate the bundled web assets shipped alongside the compiled server. In a published package,
 * `web/` sits next to `dist/`, so from the running file's directory it is `../web`. Returns
 * undefined when absent (e.g. API-only dev runs), leaving the server to run without a web UI.
 */
function resolveWebRoot(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidate = join(here, '..', 'web')
  return existsSync(join(candidate, 'index.html')) ? candidate : undefined
}

export async function closeServerResources(input: {
  liveTurnManager: { closeAll(): void }
  unsubscribeRegistry?: (() => void) | null
  indexChangeNotifier: { close(): void }
  claudeSessionRegistry?: { close(): Promise<void> } | null
  rawTranscriptCoordinator: { close(): void | Promise<void> }
  turnMetaStore: { close(): void }
  cottaDb: { close(): void }
  projectFilesWatcherRegistry?: { close(): void }
  sessionWatcherRegistry?: { close(): void }
  terminalRegistry?: { close(): void }
  remoteBotManager?: { close(): void | Promise<void> }
}): Promise<void> {
  input.liveTurnManager.closeAll()
  input.unsubscribeRegistry?.()
  input.indexChangeNotifier.close()
  input.projectFilesWatcherRegistry?.close()
  input.sessionWatcherRegistry?.close()
  input.terminalRegistry?.close()
  try {
    try {
      await input.remoteBotManager?.close()
    } finally {
      await input.rawTranscriptCoordinator.close()
    }
  } finally {
    input.turnMetaStore.close()
    try {
      await input.claudeSessionRegistry?.close()
    } finally {
      input.cottaDb.close()
    }
  }
}

export function subscribeCliSessionOwnership({
  claudeSessionRegistry,
  liveTurnManager,
  rawTranscriptCoordinator,
  rawTranscriptCache,
  indexChangeNotifier,
  timelineVersion,
  syncTranscriptIndex,
  settingsStore,
  turnOptionsStore,
}: {
  claudeSessionRegistry: Pick<Awaited<ReturnType<typeof createClaudeSessionRegistry>>, 'subscribe' | 'cliSessionMetadata'>
  liveTurnManager: Pick<LiveTurnManager, 'closeForExternalOwner' | 'rebuildRuntimeAfterCliIdle'>
  rawTranscriptCoordinator: Pick<RawTranscriptCoordinator, 'signalSession' | 'syncForRead'>
  rawTranscriptCache: { index: Pick<TranscriptIndexStore, 'getSession'> }
  indexChangeNotifier: Pick<IndexChangeNotifier, 'publishChange'>
  timelineVersion: (projectId: string, sessionId: string) => string
  syncTranscriptIndex: (input?: IndexChangeInput) => Promise<void>
  settingsStore: SettingsStore
  turnOptionsStore: TurnOptionsStore
}): () => void {
  const cliOwnedSessionIds = new Set<string>()
  return claudeSessionRegistry.subscribe(({ changedSessions, activeSessionIds, idleSessionIds }) => {
    const projectIdsBySessionId = new Map<string, string>()
    const activeSessionIdSet = new Set(activeSessionIds)
    const publishActivityChange = (sessionId: string) => {
      const projectId = projectIdsBySessionId.get(sessionId) ?? rawTranscriptCache.index.getSession(sessionId)?.currentProjectId ?? undefined
      if (!projectId) return
      const version = timelineVersion(projectId, sessionId)
      indexChangeNotifier.publishChange(version ? { projectId, sessionId, selectedSessionVersion: version } : { projectId })
    }
    for (const { sessionId, cwd } of changedSessions) {
      const projectId = cwd ? projectIdFromPath(cwd) : undefined
      if (projectId) {
        projectIdsBySessionId.set(sessionId, projectId)
        rawTranscriptCoordinator.signalSession(sessionId, { cwd: cwd ?? undefined })
      }
      void syncTranscriptIndex({ sessionId, ...(projectId ? { projectId } : {}), ...(cwd ? { cwd } : {}) }).catch((error) => {
        if (!(error instanceof TranscriptUnavailableError)) console.error(`transcript-index:signal failed for ${sessionId}`, error)
      })
      if (!activeSessionIdSet.has(sessionId)) publishActivityChange(sessionId)
    }
    for (const sessionId of activeSessionIds) {
      void liveTurnManager
        .closeForExternalOwner(sessionId)
        .then(() => publishActivityChange(sessionId))
        .catch((error) => console.error(`live-runtime:external owner close failed for ${sessionId}`, error))
    }
    for (const sessionId of idleSessionIds) publishActivityChange(sessionId)
    for (const { sessionId } of changedSessions) {
      const cliMetadata = claudeSessionRegistry.cliSessionMetadata(sessionId)
      if (cliMetadata) {
        cliOwnedSessionIds.add(sessionId)
        continue
      }
      if (!cliOwnedSessionIds.delete(sessionId)) continue
      const projectId = projectIdsBySessionId.get(sessionId) ?? rawTranscriptCache.index.getSession(sessionId)?.currentProjectId ?? undefined
      void (async () => {
        try {
          await rawTranscriptCoordinator.syncForRead(sessionId, projectId)
          const resolvedProjectId = rawTranscriptCache.index.getSession(sessionId)?.currentProjectId
          if (!resolvedProjectId) return
          const options = resolveTurnOptions({ sessionId, settingsStore, turnOptionsStore })
          const validation = validateTurnOptions(options, settingsStore)
          if (!validation.ok) {
            console.error(`live-runtime:CLI idle rebuild skipped for ${sessionId}: ${validation.error}`)
            return
          }
          await liveTurnManager.rebuildRuntimeAfterCliIdle({
            projectId: resolvedProjectId,
            sessionId,
            permissionMode: options.permissionMode,
            model: options.model,
            effort: options.effort,
            hasCliOwnership: () => claudeSessionRegistry.cliSessionMetadata(sessionId) !== null,
          })
        } catch (error) {
          if (!(error instanceof TranscriptUnavailableError)) console.error(`live-runtime:CLI idle rebuild failed for ${sessionId}`, error)
        }
      })()
    }
  })
}

const host = process.env.HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? 3000)
const terminalOrigin = parseTerminalOrigin(process.env.COTTA_TERMINAL_ORIGIN)

if (process.env.NODE_ENV !== 'test') {
  const claudeSessionRegistry = await createClaudeSessionRegistry()
  const cottaDb = createCottaDatabase()
  const indexChangeNotifier = new IndexChangeNotifier()
  const settingsStore = new SqliteSettingsStore(cottaDb)
  await ensureGithubConfig(settingsStore, { force: process.argv.includes('--reconfigure-github') })
  const detailTokenKey = loadDetailTokenKey(settingsStore)
  const shareStore = new ShareStore(cottaDb)
  const turnOptionsStore = new TurnOptionsStore(cottaDb)
  const sessionContextUsageStore = new SessionContextUsageStore(cottaDb)
  const sessionPinStore = new SessionPinStore(cottaDb)
  const turnMetaStore = new TurnMetaTranscriptStore(cottaDb, { settingsStore })
  const subagentStore = new SessionSubagentStore(cottaDb)
  const tokenUsageStore = new TokenUsageStore(cottaDb)
  const rawTranscriptCache = new SessionRawTranscriptCacheStore(cottaDb, { turnMetaStore, subagentStore, tokenUsageStore })
  let activityVersion = (_sessionId: string) => sessionActivityVersion({ activity: sessionActivity(null, null) })
  const timelineVersion = (projectId: string, sessionId: string, baseVersion?: string | null): string => {
    const transcriptVersion = baseVersion ?? rawTranscriptCache.timelineVersion(sessionId) ?? 'missing'
    const taskVersion = rawTranscriptCache.index.getSession(sessionId)?.taskSnapshotVersion ?? 'unknown'
    return `${turnMetaStore.timelineVersion(projectId, sessionId, `transcript=${transcriptVersion}`)};tasks=${taskVersion};${activityVersion(sessionId)}`
  }
  let indexingDone = false
  const rawTranscriptCoordinator = new RawTranscriptCoordinator(rawTranscriptCache, {
    subagentStore,
    tokenUsageStore,
    timelineVersionReader: timelineVersion,
    onSessionSynced: (input) => indexChangeNotifier.publishChange(input),
    onSessionVersionChanged: ({ projectId, sessionId, version }) => indexChangeNotifier.publishSessionVersion(projectId, sessionId, version),
    onSubagentsChanged: ({ projectId, sessionId }) => indexChangeNotifier.publishSubagentChange(projectId, sessionId),
    onScanProgress: (done, total) => {
      if (indexingDone || !process.stdout.isTTY) return
      process.stdout.write(`\rIndexing transcripts… ${done}/${total}`)
    },
  })
  console.log('Indexing transcripts…')
  rawTranscriptCoordinator.start()
  const syncTranscriptIndex = async (input?: IndexChangeInput) => {
    if (input?.kind === 'removed' && input.sessionId) {
      rawTranscriptCache.deleteCachedSession(input.sessionId)
      return
    }
    if (input?.sessionId) {
      const cwd = input.cwd ?? (input.projectId ? (projectPathFromId(input.projectId) ?? undefined) : undefined)
      rawTranscriptCoordinator.signalSession(input.sessionId, { ...(cwd ? { cwd } : {}) })
      if (input.kind === 'changed') await rawTranscriptCoordinator.syncForRead(input.sessionId, input.projectId)
      return
    }
    if (input?.projectId) {
      const projectPath = projectPathFromId(input.projectId)
      if (projectPath) await rawTranscriptCoordinator.refreshProjectNow(projectPath)
      return
    }
    await rawTranscriptCoordinator.refreshNow()
  }
  const liveTurnManager = new LiveTurnManager(
    {
      signalSessionActivity: (input) => rawTranscriptCoordinator.signalSession(input.sessionId, { ...(input.projectId ? { cwd: projectPathFromId(input.projectId) ?? undefined } : {}) }),
      notifySessionRunStateActive: (input) => {
        const version = timelineVersion(input.projectId, input.sessionId)
        indexChangeNotifier.publishChange(version ? { projectId: input.projectId, sessionId: input.sessionId, selectedSessionVersion: version } : { projectId: input.projectId })
      },
      onPermissionModeChanged: (input) => {
        if (!turnOptionsStore.setSessionTurnOptions(input.sessionId, { permissionMode: input.mode }, input.observedAtMs)) return
        indexChangeNotifier.publishSessionVersion(input.projectId, input.sessionId, timelineVersion(input.projectId, input.sessionId))
      },
    },
    turnMetaStore,
    sessionContextUsageStore,
    settingsStore,
    (sessionId) => claudeSessionRegistry.cliSessionMetadata(sessionId),
  )
  activityVersion = (sessionId) => {
    const runState = liveTurnManager.sessionRunState(sessionId)
    return `${sessionActivityVersion({
      activity: sessionActivity(runState, claudeSessionRegistry.cliSessionMetadata(sessionId) ?? null, liveTurnManager.liveBackgroundTasks(sessionId)),
      pendingPermission: runState?.phase === 'requires_action' ? (runState.pendingPermission ?? null) : null,
    })}:runtime=${liveTurnManager.sessionRunStateVersion(sessionId)}`
  }
  const unsubscribeRegistry = subscribeCliSessionOwnership({
    claudeSessionRegistry,
    liveTurnManager,
    rawTranscriptCoordinator,
    rawTranscriptCache,
    indexChangeNotifier,
    timelineVersion,
    syncTranscriptIndex,
    settingsStore,
    turnOptionsStore,
  })
  const projectFilesWatcherRegistry = new ProjectFilesWatcherRegistry()
  const sessionWatcherRegistry = new SessionWatcherRegistry()
  const terminalRegistry = new TerminalRegistry()
  const sessionSearchStore = new SessionSearchStore(cottaDb, rawTranscriptCache.index)
  const claudeCodeApi = createClaudeCodeApi({
    transcriptIndex: rawTranscriptCache.index,
    beforeList: () => rawTranscriptCoordinator.ensureReady(),
    timelineVersionProvider: timelineVersion,
  })
  const auth = createAuth({ settingsStore })
  const projectRoutesInput = {
    claudeCodeApi,
    liveTurnManager,
    indexChangeNotifier,
    selectedSessionVersionReader: timelineVersion,
    timelineVersionReader: timelineVersion,
    refreshTaskSnapshot: (sessionId: string, projectId?: string) => rawTranscriptCoordinator.refreshTaskSnapshot(sessionId, projectId),
    refreshSubagentIndex: (sessionId: string) => rawTranscriptCoordinator.refreshSubagentIndex(sessionId),
    subagentStore,
    syncTranscriptIndex,
    settingsStore,
    turnOptionsStore,
    sessionContextUsageStore,
    sessionPinStore,
    sessionMetadataReader: (sessionId: string) => claudeSessionRegistry.cliSessionMetadata(sessionId),
    timelineMetadataReader: (projectId: string, sessionId: string) => turnMetaStore.loadTimelineMetadata(projectId, sessionId),
    transcriptSyncer: (projectId: string, sessionId: string, fileSize?: number) => rawTranscriptCoordinator.syncForRead(sessionId, projectId, fileSize),
    rawTranscriptCache,
    transcriptIndex: rawTranscriptCache.index,
    sessionSearchStore,
    sessionSearchReady: () => rawTranscriptCoordinator.ensureReady(),
    modelCatalogProvider: defaultModelCatalogProvider,
    sessionWatcherRegistry,
    detailTokenKey,
    shareStore,
  }
  const remoteBotStore = createRemoteBotStore(cottaDb)
  const remoteBotManager = new RemoteBotManager(remoteBotStore, projectRoutesInput)
  await remoteBotManager.start().catch((error) => console.error('Remote bot startup failed', error))
  const app = createApp({
    ...projectRoutesInput,
    projectFilesWatcherRegistry,
    claudeSessionRegistry,
    tokenUsageStore,
    tokenUsageReady: () => rawTranscriptCoordinator.ensureReady(),
    tokenUsageRefresh: () => rawTranscriptCoordinator.refreshUsageNow(),
    remoteBotStore,
    reconcileRemoteBots: (botId) => remoteBotManager.reconcile(botId),
    remoteBotConnectionStatus: (botId) => remoteBotManager.connectionStatus(botId),
    remoteBotProjectExists: async (projectId) => (await claudeCodeApi.getProject(projectId)) !== null,
    auth,
    terminalRegistry,
    terminalOrigin,
    webRoot: resolveWebRoot(),
  })

  const server = createAdaptorServer({ fetch: app.fetch })
  attachTerminalWebSocket({ server: server as import('node:http').Server, auth, registry: terminalRegistry, terminalOrigin })
  server.listen(port, host, () => {
    console.log(`Cotta server listening on http://${host}:${port}`)
  })
  rawTranscriptCoordinator
    .ensureReady()
    .then(() => {
      indexingDone = true
      const indexedCount = rawTranscriptCache.index.listTranscriptSessions().length
      if (process.stdout.isTTY) process.stdout.write('\r\x1b[K')
      console.log(`Indexed ${indexedCount} sessions`)
    })
    .catch((error) => {
      indexingDone = true
      if (process.stdout.isTTY) process.stdout.write('\r\x1b[K')
      console.error('Transcript indexing failed', error)
    })

  const resources = {
    liveTurnManager,
    unsubscribeRegistry,
    indexChangeNotifier,
    claudeSessionRegistry,
    rawTranscriptCoordinator,
    turnMetaStore,
    cottaDb,
    projectFilesWatcherRegistry,
    sessionWatcherRegistry,
    terminalRegistry,
    remoteBotManager,
  }
  const shutdown = () => {
    setTimeout(() => process.exit(0), 1000).unref()
    const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()))
    void Promise.allSettled([serverClosed, closeServerResources(resources)]).then(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Cotta server failed to start: http://${host}:${port} is already in use.`)
      console.error('Stop the process using that port, or start Cotta with a different PORT.')
      void closeServerResources(resources).finally(() => {
        process.exitCode = 1
      })
      return
    }

    throw error
  })
}
