import { createClaudeCodeApi, projectIdFromPath, projectPathFromId } from './claude-code-api.js'
import { createClaudeSessionRegistry } from './claude-session-registry.js'
import { assertNoLegacyDatabase } from './cotta-home.js'
import { createCottaDatabase } from './database.js'
import { loadDetailTokenKey } from './detail-token.js'
import { type IndexChangeInput, IndexChangeNotifier } from './index-change-notifier.js'
import { LiveTurnManager } from './live-turn-manager.js'
import { defaultModelCatalogProvider, type ModelCatalogProvider, modelCatalogProvider } from './model-catalog.js'
import { loadProviderAllowlist, resolveActiveProvider } from './model-provider.js'
import { ProjectFilesWatcherRegistry } from './project-files-watcher-registry.js'
import { RawTranscriptCoordinator } from './raw-transcript-coordinator.js'
import { RemoteBotManager } from './remote-bot-manager.js'
import { sessionActivity, sessionActivityVersion } from './routes/project-routes-shared.js'
import { createRemoteBotStore } from './routes/remote-bot-routes.js'
import { SessionContextUsageStore } from './session-context-usage-store.js'
import { SessionPinStore } from './session-pin-store.js'
import { SessionRawTranscriptCacheStore, TranscriptUnavailableError } from './session-raw-transcript-cache.js'
import { SessionSearchStore } from './session-search-store.js'
import { SessionSubagentStore } from './session-subagent-store.js'
import { SessionWatcherRegistry } from './session-watcher-registry.js'
import { type SettingsStore, SqliteSettingsStore } from './settings-store.js'
import { ShareStore } from './share-store.js'
import { ensureModelCatalog } from './startup-config.js'
import { TerminalRegistry } from './terminal-registry.js'
import { TokenUsageStore } from './token-usage-store.js'
import type { TranscriptIndexStore } from './transcript-index-store.js'
import { TurnMetaTranscriptStore } from './turn-meta-transcript.js'
import { resolveTurnOptions, validateTurnOptions } from './turn-options.js'
import { TurnOptionsStore } from './turn-options-store.js'

export function createSessionMutationTarget(input: {
  transcriptIndex: Pick<TranscriptIndexStore, 'getSession'>
  syncTranscript: (projectId: string, sessionId: string) => unknown | Promise<unknown>
}) {
  return async (projectId: string, sessionId: string): Promise<{ transcriptPath: string } | null> => {
    try {
      await input.syncTranscript(projectId, sessionId)
    } catch (error) {
      if (error instanceof TranscriptUnavailableError) return null
      throw error
    }
    const session = input.transcriptIndex.getSession(sessionId)
    if (!session?.isValidSessionId || session.currentProjectId !== projectId || !session.transcriptPath) return null
    return { transcriptPath: session.transcriptPath }
  }
}

export async function closeServerResources(input: {
  liveTurnManager: { closeAll(): void | Promise<void> }
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
  await input.liveTurnManager.closeAll()
  input.unsubscribeRegistry?.()
  input.indexChangeNotifier.close()
  input.projectFilesWatcherRegistry?.close()
  input.sessionWatcherRegistry?.close()
  input.terminalRegistry?.close()
  try {
    try {
      await input.remoteBotManager?.close()
    } finally {
      try {
        await input.claudeSessionRegistry?.close()
      } finally {
        await input.rawTranscriptCoordinator.close()
      }
    }
  } finally {
    input.turnMetaStore.close()
    input.cottaDb.close()
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

export type CreateCottaCoreOptions = {
  /**
   * Runs once the settings store is open and before model catalog checks or transcript indexing start.
   * Interactive host setup (e.g. the legacy GitHub login prompt) belongs here so it never races indexing output.
   */
  onSettingsReady?: (settingsStore: SettingsStore) => Promise<void>
}

/**
 * The local execution and data core: database, stores, transcript indexing, the live Claude Code runtime,
 * watchers, terminals and the remote bot manager. It owns every long-lived resource and releases them
 * through `close()`. It does not know about HTTP hosting, authentication or the web UI, so a different
 * host (the future daemon API, tests) can assemble it without creating a second runtime or store.
 */
export async function createCottaCore(options: CreateCottaCoreOptions = {}) {
  const claudeSessionRegistry = await createClaudeSessionRegistry()
  assertNoLegacyDatabase()
  const cottaDb = createCottaDatabase()
  const indexChangeNotifier = new IndexChangeNotifier()
  const settingsStore = new SqliteSettingsStore(cottaDb)
  const providerAllowlist = await loadProviderAllowlist()
  // Resolve the active provider at call time: the operator can switch it at runtime via PUT /api/providers/active.
  const activeProvider = () => resolveActiveProvider(providerAllowlist, settingsStore)
  // catalog source follows the active provider: its own catalog wins; else if it only redirects turns
  // via env, query the SDK catalog through that env so the list matches what the backend serves.
  const catalogProvider: ModelCatalogProvider = async (cwd) => {
    const active = activeProvider()
    const resolved = active?.modelCatalogProvider ?? (active ? modelCatalogProvider(await active.envForTurn()) : defaultModelCatalogProvider)
    return resolved(cwd)
  }
  await options.onSettingsReady?.(settingsStore)
  // With any provider configured, the selected backend isn't authenticated until the user connects via
  // the web UI (and on a fresh DB none is even selected yet), so the boot-time catalog query would fail;
  // defer to the post-connect lazy refresh instead of crashing. Only the stock no-provider path is fatal.
  await ensureModelCatalog(settingsStore, catalogProvider, { required: providerAllowlist.size === 0 })
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
    onMaintenanceTick: () => claudeSessionRegistry.revalidateIfDue(),
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
        if (!turnOptionsStore.setSessionTurnOptions(input.sessionId, { permissionMode: input.mode }, input.observedAtMs, input.previousMode)) return
        indexChangeNotifier.publishSessionVersion(input.projectId, input.sessionId, timelineVersion(input.projectId, input.sessionId))
      },
    },
    turnMetaStore,
    sessionContextUsageStore,
    settingsStore,
    (sessionId) => claudeSessionRegistry.cliSessionMetadata(sessionId),
    (sessionId) => turnOptionsStore.getPrePlanPermissionMode(sessionId),
    providerAllowlist.size ? async (sessionId) => (await activeProvider()?.envForTurn({ sessionId })) ?? {} : undefined,
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
    mutationTarget: createSessionMutationTarget({
      transcriptIndex: rawTranscriptCache.index,
      syncTranscript: (_projectId, sessionId) => rawTranscriptCache.ensureSessionCachedById(sessionId),
    }),
  })
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
    modelCatalogProvider: catalogProvider,
    sessionWatcherRegistry,
    detailTokenKey,
    shareStore,
  }
  const remoteBotStore = createRemoteBotStore(cottaDb)
  const remoteBotManager = new RemoteBotManager(remoteBotStore, projectRoutesInput)
  await remoteBotManager.start().catch((error) => console.error('Remote bot startup failed', error))

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
  let closing: Promise<void> | null = null

  return {
    settingsStore,
    providerAllowlist,
    terminalRegistry,
    /** Everything the HTTP routes need, all backed by this core's single set of resources. */
    appInput: {
      ...projectRoutesInput,
      projectFilesWatcherRegistry,
      claudeSessionRegistry,
      tokenUsageStore,
      tokenUsageReady: () => rawTranscriptCoordinator.ensureReady(),
      tokenUsageRefresh: () => rawTranscriptCoordinator.refreshUsageNow(),
      remoteBotStore,
      reconcileRemoteBots: (botId?: string) => remoteBotManager.reconcile(botId),
      remoteBotConnectionStatus: (botId: string) => remoteBotManager.connectionStatus(botId),
      remoteBotProjectExists: async (projectId: string) => (await claudeCodeApi.getProject(projectId)) !== null,
      terminalRegistry,
      providerAllowlist,
    },
    /** Releases every owned resource in the established order. Idempotent: later calls share the first close. */
    close(): Promise<void> {
      closing ??= closeServerResources(resources)
      return closing
    },
  }
}

export type CottaCore = Awaited<ReturnType<typeof createCottaCore>>
