import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAdaptorServer } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { requestId } from 'hono/request-id'
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'
import { type CottaAuth, createAuth, noopAuth } from './auth.js'
import { forceCloseOwnedClaudeProcesses } from './claude-cli/query.js'
import { type ClaudeCodeApi, createClaudeCodeApi } from './claude-code-api.js'
import type { createClaudeSessionRegistry } from './claude-session-registry.js'
import { acquireServerLock, serverUrl, writePidRecord } from './cotta-home.js'
import { createCottaCore, createSessionMutationTarget } from './core.js'
import { type IndexChangeInput, IndexChangeNotifier } from './index-change-notifier.js'
import { LiveTurnManager } from './live-turn-manager.js'
import { defaultModelCatalogProvider, type ModelCatalogProvider } from './model-catalog.js'
import { type ModelProvider, registerProviderRoutes } from './model-provider.js'
import { ProjectFilesWatcherRegistry } from './project-files-watcher-registry.js'
import { registerHealthRoute } from './routes/health.js'
import { registerProjectFileRoutes } from './routes/project-files.js'
import {
  type ProjectRoutesLiveTurnManager,
  type ProjectRoutesRawTranscriptCache,
  type ProjectRoutesSessionSearchReady,
  type ProjectRoutesSessionSearchStore,
  type ProjectRoutesTimelineMetadataReader,
  type ProjectRoutesTranscriptSyncer,
  registerProjectRoutes,
} from './routes/projects.js'
import { type createRemoteBotStore, type RemoteBotConnectionStatus, type RemoteBotProjectExists, type RemoteBotReconcile, registerRemoteBotRoutes } from './routes/remote-bot-routes.js'
import { registerShareAdminRoutes, registerShareRoutes } from './routes/share-routes.js'
import { registerTokenUsageRoutes } from './routes/token-usage-routes.js'
import type { SessionContextUsageStore } from './session-context-usage-store.js'
import type { SessionPinStore } from './session-pin-store.js'
import type { SessionSubagentStore } from './session-subagent-store.js'
import { SessionWatcherRegistry } from './session-watcher-registry.js'
import type { SettingsStore } from './settings-store.js'
import type { ShareStore } from './share-store.js'
import { ensureGithubConfig } from './startup-config.js'
import type { TerminalRegistry } from './terminal-registry.js'
import { attachTerminalWebSocket, isAllowedTerminalOrigin } from './terminal-websocket.js'
import type { TokenUsageStore } from './token-usage-store.js'
import type { TranscriptIndexStore } from './transcript-index-store.js'
import type { TurnOptionsStore } from './turn-options-store.js'

// Existing importers (tests, scripts) keep resolving these from the server entry.
export { closeServerResources, createSessionMutationTarget, subscribeCliSessionOwnership } from './core.js'

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
  remoteBotStore?: ReturnType<typeof createRemoteBotStore>
  reconcileRemoteBots?: RemoteBotReconcile
  remoteBotConnectionStatus?: RemoteBotConnectionStatus
  remoteBotProjectExists?: RemoteBotProjectExists
  detailTokenKey?: Buffer
  shareStore?: ShareStore
  webRoot?: string
  providerAllowlist?: Map<string, ModelProvider>
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
  const claudeCodeApi =
    input.claudeCodeApi ??
    createClaudeCodeApi({
      transcriptIndex: input.transcriptIndex,
      ...(input.transcriptSyncer ? { mutationTarget: createSessionMutationTarget({ transcriptIndex: input.transcriptIndex, syncTranscript: input.transcriptSyncer }) } : {}),
    })
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
  if (input.providerAllowlist?.size) registerProviderRoutes(app, { allowlist: input.providerAllowlist, settingsStore })
  registerShareAdminRoutes(app, input.shareStore, auth, input.transcriptIndex)
  registerProjectFileRoutes(app, { claudeCodeApi, watcherRegistry: projectFilesWatcherRegistry })
  if (input.terminalRegistry) {
    app.get('/api/terminal', (context) => context.json({ available: input.terminalRegistry!.available() }))
    app.delete('/api/terminal', (context) => {
      const requestHost = context.req.header('x-forwarded-host')?.split(',')[0]?.trim() || context.req.header('host')
      if (!isAllowedTerminalOrigin(context.req.header('Origin'), requestHost)) return context.json({ error: 'forbidden' }, 403)
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

export function shutdownServer(server: { close(callback: () => void): unknown }, closeResources: () => Promise<void>): void {
  let finished = false
  const finishShutdown = () => {
    if (finished) return
    finished = true
    clearTimeout(deadline)
    forceCloseOwnedClaudeProcesses()
    process.exit(0)
  }
  const deadline = setTimeout(finishShutdown, 1000).unref()
  const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()))
  void Promise.allSettled([serverClosed, closeResources()]).then(finishShutdown)
}

export async function runServer(opts: { reconfigureGithub: boolean }): Promise<boolean> {
  const host = process.env.HOST ?? '127.0.0.1'
  const port = Number(process.env.PORT ?? 3000)
  // Take the single-instance lock before touching the database, so a second server never indexes or writes.
  // False means another server holds it; the caller reports that.
  if (!acquireServerLock()) return false
  // Write the pid now, not on listen, so `cotta stop` can still kill a server stuck in setup; readiness is probed over HTTP.
  writePidRecord({ pid: process.pid, host, port, startedAt: Date.now() })
  const core = await createCottaCore({
    onSettingsReady: (settingsStore) => ensureGithubConfig(settingsStore, { force: opts.reconfigureGithub }),
  })
  // Hosting concerns stay here: authentication and the bundled web UI are not part of the core.
  const auth = createAuth({ settingsStore: core.settingsStore })
  const app = createApp({ ...core.appInput, auth, webRoot: resolveWebRoot() })

  const server = createAdaptorServer({ fetch: app.fetch })
  attachTerminalWebSocket({ server: server as import('node:http').Server, auth, registry: core.terminalRegistry })
  server.listen(port, host, () => {
    console.log(`Cotta server listening on ${serverUrl({ host, port })}`)
  })

  const shutdown = () => shutdownServer(server, () => core.close())
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Cotta server failed to start: ${serverUrl({ host, port })} is already in use.`)
      console.error('Stop the process using that port, or start Cotta with a different PORT.')
      // Exit outright like shutdown(): a lingering handle would otherwise keep the single-instance lock held.
      void core.close().finally(() => process.exit(1))
      return
    }

    throw error
  })
  return true
}
