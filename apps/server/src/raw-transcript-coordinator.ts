import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { projectTranscriptDirName } from './project-path.js'
import { type SessionRawTranscriptCacheStore, TranscriptUnavailableError } from './session-raw-transcript-cache.js'
import { readSessionSubagentSnapshot } from './session-subagent-snapshot.js'
import type { SessionSubagentStore } from './session-subagent-store.js'
import { readSessionTaskSnapshot } from './session-task-snapshot.js'
import type { TokenUsageStore } from './token-usage-store.js'

const MINUTE = 60_000

type HotSession = { deadline: number; lastSize: number | null; lastMtimeMs: number | null }

type SessionChangeNotification =
  | { sessionId: string; projectId?: string; previousProjectId?: string; kind: 'changed'; version: string; reset: boolean; invalidateFromTurnId: string | null }
  | { sessionId: string; projectId: string; kind: 'removed' }

type CoordinatorOptions = {
  now?: () => number
  hotPollMs?: number
  hotSilentMs?: number
  fullScanMs?: number
  subagentStore?: SessionSubagentStore
  tokenUsageStore?: TokenUsageStore
  timelineVersionReader: (projectId: string, sessionId: string) => string
  onSessionSynced?: (input: SessionChangeNotification) => void
  onSessionVersionChanged?: (input: { projectId: string; sessionId: string; version: string }) => void
  onSubagentsChanged?: (input: { projectId: string; sessionId: string }) => void
  onScanProgress?: (done: number, total: number) => void
}

export class RawTranscriptCoordinator {
  private readonly now: () => number
  private readonly hotPollMs: number
  private readonly hotSilentMs: number
  private readonly fullScanMs: number
  private readonly onSessionSynced?: CoordinatorOptions['onSessionSynced']
  private readonly onSessionVersionChanged?: CoordinatorOptions['onSessionVersionChanged']
  private readonly onSubagentsChanged?: CoordinatorOptions['onSubagentsChanged']
  private readonly onScanProgress?: CoordinatorOptions['onScanProgress']
  private readonly subagentStore?: SessionSubagentStore
  private readonly tokenUsageStore?: TokenUsageStore
  private readonly timelineVersionReader: CoordinatorOptions['timelineVersionReader']
  private readonly hot = new Map<string, HotSession>()
  private readonly syncing = new Map<string, Promise<void>>()
  private readonly syncRequested = new Set<string>()
  private readonly authoritativeSyncRequested = new Set<string>()
  private readonly subagentSyncRequested = new Set<string>()
  private hotTimer?: NodeJS.Timeout
  private fullScanTimer?: NodeJS.Timeout
  private hotPoll: Promise<void> = Promise.resolve()
  private readonly fullScanRuns = new Set<Promise<void>>()
  private readiness: Promise<void> = Promise.resolve()
  private fullScanRun: Promise<void> | null = null
  private fullScanAllRequested = false
  private fullScanAuthoritativeRequested = false
  private readonly fullScanProjectIds = new Set<string>()
  private fullScanActiveAll = false
  private fullScanActiveAuthoritative = false
  private readonly fullScanActiveProjectIds = new Set<string>()
  private readonly subagentRefreshes = new Map<string, Promise<boolean>>()
  private readonly subagentRefreshRequested = new Set<string>()
  private readonly taskSnapshotRefreshes = new Map<string, Promise<boolean>>()
  private readonly taskSnapshotRefreshRequested = new Map<string, { projectId?: string; notify: boolean }>()
  private closed = false

  constructor(
    readonly cache: SessionRawTranscriptCacheStore,
    options: CoordinatorOptions,
  ) {
    this.now = options.now ?? Date.now
    this.hotPollMs = options.hotPollMs ?? 1_000
    this.hotSilentMs = options.hotSilentMs ?? MINUTE
    this.fullScanMs = options.fullScanMs ?? 30 * MINUTE
    this.subagentStore = options.subagentStore
    this.tokenUsageStore = options.tokenUsageStore
    this.timelineVersionReader = options.timelineVersionReader
    this.onSessionSynced = options.onSessionSynced
    this.onSessionVersionChanged = options.onSessionVersionChanged
    this.onSubagentsChanged = options.onSubagentsChanged
    this.onScanProgress = options.onScanProgress
  }

  start(): void {
    this.hotTimer = setInterval(() => {
      this.hotPoll = this.hotPoll.then(() => this.pollHot()).catch((error) => console.error('raw-transcript:hot poll failed', error))
    }, this.hotPollMs)
    this.fullScanTimer = setInterval(() => {
      void this.trackGlobalScan(this.runFullScan()).catch((error) => console.error('raw-transcript:full scan failed', error))
    }, this.fullScanMs)
    this.hotTimer.unref?.()
    this.fullScanTimer.unref?.()
    const hasPersistedSessions = this.cache.prepareSearchIndex()
    const initialScan = this.runFullScan()
    if (!hasPersistedSessions) this.readiness = initialScan
    void initialScan.catch((error) => console.error('raw-transcript:initial full scan failed', error))
  }

  async ensureReady(): Promise<void> {
    await this.readiness
  }

  async refreshNow(): Promise<void> {
    await this.trackGlobalScan(this.runFullScan())
  }

  async refreshUsageNow(): Promise<void> {
    await this.trackGlobalScan(this.runFullScan(undefined, true))
  }

  async refreshProjectNow(projectPath: string): Promise<void> {
    // Project refresh is a fast, best-effort scan of Claude Code's usual transcript shard for this cwd.
    // Session ownership still comes from the latest cwd inside each transcript; misplaced jsonl files are found by full scans.
    await this.runFullScan([projectTranscriptDirName(projectPath)])
  }

  async refreshTaskSnapshot(sessionId: string, projectId?: string, options: { notify?: boolean } = {}): Promise<boolean> {
    const requested = this.taskSnapshotRefreshRequested.get(sessionId)
    this.taskSnapshotRefreshRequested.set(sessionId, {
      ...(requested?.projectId || projectId ? { projectId: requested?.projectId ?? projectId } : {}),
      notify: (requested?.notify ?? false) || options.notify !== false,
    })
    const existing = this.taskSnapshotRefreshes.get(sessionId)
    if (existing) return existing
    const refresh = (async () => {
      let changed = false
      while (true) {
        const request = this.taskSnapshotRefreshRequested.get(sessionId)
        this.taskSnapshotRefreshRequested.delete(sessionId)
        if (!request) break
        const snapshot = await readSessionTaskSnapshot(sessionId)
        if (!snapshot.ok) continue
        const updated = this.cache.index.updateTaskSnapshot(sessionId, snapshot.snapshot)
        changed ||= updated
        if (updated && request.notify) this.notifySessionDetailChanged(sessionId, request.projectId)
      }
      return changed
    })().finally(() => {
      if (this.taskSnapshotRefreshes.get(sessionId) === refresh) this.taskSnapshotRefreshes.delete(sessionId)
    })
    this.taskSnapshotRefreshes.set(sessionId, refresh)
    return refresh
  }

  async refreshSubagentIndex(sessionId: string): Promise<boolean> {
    this.subagentRefreshRequested.add(sessionId)
    const existing = this.subagentRefreshes.get(sessionId)
    if (existing) return existing
    const refresh = (async () => {
      let changed = false
      while (this.subagentRefreshRequested.delete(sessionId)) {
        if (!this.subagentStore) continue
        const indexed = this.cache.index.getSession(sessionId)
        if (!indexed?.transcriptPath) continue
        const entries = await readSessionSubagentSnapshot(sessionId, indexed.transcriptPath)
        changed = this.subagentStore.reconcileMetadata(sessionId, entries) || changed
        await this.tokenUsageStore?.syncSubagents(sessionId)
      }
      return changed
    })().finally(() => {
      if (this.subagentRefreshes.get(sessionId) === refresh) this.subagentRefreshes.delete(sessionId)
    })
    this.subagentRefreshes.set(sessionId, refresh)
    return refresh
  }

  private notifySessionDetailChanged(sessionId: string, projectId?: string): void {
    const indexed = this.cache.index.getSession(sessionId)
    const resolvedProjectId = projectId ?? indexed?.currentProjectId ?? undefined
    if (!resolvedProjectId) return
    const version = this.timelineVersionReader(resolvedProjectId, sessionId)
    if (version) this.onSessionVersionChanged?.({ projectId: resolvedProjectId, sessionId, version })
  }

  signalSession(sessionId: string, hint: { transcriptPath?: string; cwd?: string; fileSize?: number; fileMtimeMs?: number } = {}): void {
    if (this.closed) return
    if (hint.transcriptPath) {
      this.cache.index.upsertSession({
        sessionId,
        transcriptPath: hint.transcriptPath,
        fileSize: hint.fileSize,
        fileMtimeMs: hint.fileMtimeMs,
        currentCwd: hint.cwd,
      })
    }
    const indexed = this.cache.index.getSession(sessionId)
    this.hot.set(sessionId, { deadline: this.now() + this.hotSilentMs, lastSize: indexed?.fileSize ?? null, lastMtimeMs: indexed?.fileMtimeMs ?? null })
  }

  async syncForRead(sessionId: string, projectId?: string, fileSize?: number): Promise<void> {
    if (this.closed) return
    this.signalSession(sessionId, { fileSize })
    await this.syncAndNotify(sessionId, projectId)
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.hotTimer) clearInterval(this.hotTimer)
    if (this.fullScanTimer) clearInterval(this.fullScanTimer)
    this.hot.clear()
    await Promise.allSettled([this.readiness, this.hotPoll, ...this.fullScanRuns])
    await Promise.allSettled([...this.syncing.values(), ...this.subagentRefreshes.values(), ...this.taskSnapshotRefreshes.values()])
  }

  private trackGlobalScan(scan: Promise<void>): Promise<void> {
    return scan
  }

  private runFullScan(projectIds?: readonly string[], authoritative = false): Promise<void> {
    if (projectIds === undefined) {
      if (!this.fullScanActiveAll || (authoritative && !this.fullScanActiveAuthoritative)) this.fullScanAllRequested = true
      if (authoritative && !this.fullScanActiveAuthoritative) this.fullScanAuthoritativeRequested = true
    } else if (!this.fullScanActiveAll) {
      for (const projectId of projectIds) if (!this.fullScanActiveProjectIds.has(projectId)) this.fullScanProjectIds.add(projectId)
    }
    if (this.fullScanRun) return this.fullScanRun
    const run = (async () => {
      let failure: unknown
      while (this.fullScanAllRequested || this.fullScanProjectIds.size > 0) {
        const scanAll = this.fullScanAllRequested
        const authoritativeScan = scanAll && this.fullScanAuthoritativeRequested
        const pendingProjectIds = [...this.fullScanProjectIds]
        this.fullScanAllRequested = false
        this.fullScanAuthoritativeRequested = false
        this.fullScanProjectIds.clear()
        this.fullScanActiveAll = scanAll
        this.fullScanActiveAuthoritative = authoritativeScan
        this.fullScanActiveProjectIds.clear()
        if (!scanAll) for (const projectId of pendingProjectIds) this.fullScanActiveProjectIds.add(projectId)
        try {
          await this.fullScan(scanAll ? undefined : pendingProjectIds, authoritativeScan)
          if (scanAll) failure = undefined
        } catch (error) {
          failure = error
        } finally {
          this.fullScanActiveAll = false
          this.fullScanActiveAuthoritative = false
          this.fullScanActiveProjectIds.clear()
        }
      }
      if (failure) throw failure
    })().finally(() => {
      this.fullScanRuns.delete(run)
      if (this.fullScanRun === run) this.fullScanRun = null
    })
    this.fullScanRun = run
    this.fullScanRuns.add(run)
    return run
  }

  private async pollHot(): Promise<void> {
    if (this.closed) return
    const now = this.now()
    for (const [sessionId, hot] of this.hot) {
      if (now >= hot.deadline) {
        this.hot.delete(sessionId)
        continue
      }
      const indexed = this.cache.index.getSession(sessionId)
      if (!indexed?.transcriptPath) {
        await this.syncHotSession(sessionId, hot)
        continue
      }
      try {
        const info = await stat(indexed.transcriptPath)
        const mtimeMs = Math.trunc(info.mtimeMs)
        if (hot.lastSize === null || hot.lastMtimeMs === null || info.size !== hot.lastSize || mtimeMs !== hot.lastMtimeMs) {
          hot.lastSize = info.size
          hot.lastMtimeMs = mtimeMs
          hot.deadline = now + this.hotSilentMs
          await this.syncHotSession(sessionId, hot)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') this.cache.index.clearTranscriptPath(sessionId)
      }
    }
  }

  private async syncHotSession(sessionId: string, hot: HotSession): Promise<void> {
    try {
      await this.syncAndNotify(sessionId)
      const indexed = this.cache.index.getSession(sessionId)
      if (indexed) {
        hot.lastSize ??= indexed.fileSize ?? null
        hot.lastMtimeMs ??= indexed.fileMtimeMs ?? null
      }
    } catch (error) {
      if (!(error instanceof TranscriptUnavailableError)) console.error(`raw-transcript:hot sync failed for ${sessionId}`, error)
    }
  }

  private syncAndNotify(sessionId: string, projectId?: string, authoritative = false, refreshKnownSubagents = false): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.syncRequested.add(sessionId)
    if (authoritative) this.authoritativeSyncRequested.add(sessionId)
    if (refreshKnownSubagents) this.subagentSyncRequested.add(sessionId)
    const existing = this.syncing.get(sessionId)
    if (existing) return existing
    const syncing = (async () => {
      while (this.syncRequested.delete(sessionId)) {
        const repair = this.authoritativeSyncRequested.delete(sessionId)
        const refreshExistingSubagents = this.subagentSyncRequested.delete(sessionId)
        const result = await this.cache.ensureSessionCachedById(sessionId)
        const changedProjectId = result.changed ? (result.projectId ?? projectId) : projectId
        await this.refreshTaskSnapshot(sessionId, changedProjectId, { notify: !result.changed }).catch((error) => console.error(`raw-transcript:task refresh failed for ${sessionId}`, error))
        const refreshSubagents = (result.changed && result.subagentRootsChanged) || (refreshExistingSubagents && (this.subagentStore?.countsByTurn(sessionId).size ?? 0) > 0)
        if (refreshSubagents) {
          try {
            const changed = await this.refreshSubagentIndex(sessionId)
            if (changedProjectId && (changed || (result.changed && result.subagentRootsChanged))) this.onSubagentsChanged?.({ projectId: changedProjectId, sessionId })
          } catch (error) {
            if (repair) throw error
            console.error(`raw-transcript:subagent refresh failed for ${sessionId}`, error)
          }
        }
        if (repair) {
          const transcriptPath = await this.cache.resolveTranscriptPath(sessionId)
          const info = await stat(transcriptPath)
          await this.tokenUsageStore?.repairTranscript(transcriptPath, sessionId, info.size)
          await this.tokenUsageStore?.syncSubagents(sessionId, true)
        }
        if (result.changed)
          this.onSessionSynced?.({
            sessionId,
            ...(changedProjectId ? { projectId: changedProjectId } : {}),
            ...(result.previousProjectId ? { previousProjectId: result.previousProjectId } : {}),
            kind: 'changed',
            version: changedProjectId ? this.timelineVersionReader(changedProjectId, sessionId) : result.version,
            reset: result.reset,
            invalidateFromTurnId: result.invalidateFromTurnId,
          })
      }
    })().finally(() => this.syncing.delete(sessionId))
    this.syncing.set(sessionId, syncing)
    return syncing
  }

  private async fullScan(projectIds?: readonly string[], authoritative = false): Promise<void> {
    if (this.closed) return
    const global = projectIds === undefined
    const indexedBeforeScan = global ? this.cache.index.listTranscriptSessions() : []
    const indexedForRevalidation = new Map(indexedBeforeScan.map((session) => [session.sessionId, session]))
    const missingSearchIndex = this.cache.missingSearchIndexSessionIds()
    const sessions = new Set<string>()
    const discovered = new Map<string, { path: string; size: number; mtimeMs: number; duplicate: boolean }>()
    let scanFailure: unknown
    let dirs: Array<{ name: string; isDirectory(): boolean }>
    try {
      dirs = projectIds?.map((name) => ({ name, isDirectory: () => true })) ?? (await readdir(this.cache.projectsRoot, { withFileTypes: true }))
    } catch (error) {
      console.error('raw-transcript:full scan root failed', error)
      throw error
    }
    for (const dirent of dirs) {
      if (!dirent.isDirectory()) continue
      const projectDir = join(this.cache.projectsRoot, dirent.name)
      let files: Array<{ name: string; isFile(): boolean }>
      try {
        files = await readdir(projectDir, { withFileTypes: true })
      } catch (error) {
        if (!global && (error as NodeJS.ErrnoException)?.code === 'ENOENT') continue
        scanFailure ??= error
        console.error(`raw-transcript:full scan directory failed for ${projectDir}`, error)
        continue
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
        const sessionId = basename(file.name, '.jsonl')
        const transcriptPath = join(projectDir, file.name)
        try {
          const info = await stat(transcriptPath)
          const existing = discovered.get(sessionId)
          discovered.set(sessionId, { path: transcriptPath, size: info.size, mtimeMs: Math.trunc(info.mtimeMs), duplicate: existing !== undefined })
          sessions.add(sessionId)
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue
          scanFailure ??= error
          console.error(`raw-transcript:full scan stat failed for ${transcriptPath}`, error)
        }
      }
    }
    let scanned = 0
    for (const sessionId of sessions) {
      if (global) this.onScanProgress?.(++scanned, sessions.size)
      try {
        const file = discovered.get(sessionId)
        if (!file) continue
        const indexed = indexedForRevalidation.get(sessionId) ?? this.cache.index.getSession(sessionId)
        const hasSubagents = (this.subagentStore?.countsByTurn(sessionId).size ?? 0) > 0
        if (
          !authoritative &&
          !file.duplicate &&
          !hasSubagents &&
          !missingSearchIndex.has(sessionId) &&
          indexed?.transcriptPath === file.path &&
          indexed.fileSize === file.size &&
          indexed.fileMtimeMs === file.mtimeMs
        )
          continue
        await this.syncAndNotify(sessionId, undefined, authoritative, true)
      } catch (error) {
        if (error instanceof TranscriptUnavailableError) sessions.delete(sessionId)
        else {
          scanFailure ??= error
          console.error(`raw-transcript:full scan sync failed for ${sessionId}`, error)
        }
      }
    }
    if (global && !scanFailure) {
      for (const indexed of indexedBeforeScan) {
        if (sessions.has(indexed.sessionId)) continue
        try {
          await this.syncAndNotify(indexed.sessionId)
          continue
        } catch (error) {
          if (!(error instanceof TranscriptUnavailableError)) {
            scanFailure ??= error
            console.error(`raw-transcript:full scan revalidation failed for ${indexed.sessionId}`, error)
            continue
          }
        }
        if (sessions.has(indexed.sessionId)) continue
        const snapshot = indexedForRevalidation.get(indexed.sessionId)
        if (!snapshot) continue
        const current = this.cache.index.getSession(indexed.sessionId)
        if (
          !current ||
          (current.transcriptPath !== null && (current.transcriptPath !== snapshot.transcriptPath || current.fileSize !== snapshot.fileSize || current.fileMtimeMs !== snapshot.fileMtimeMs))
        )
          continue
        this.cache.deleteCachedSession(indexed.sessionId)
        this.hot.delete(indexed.sessionId)
        if (indexed.currentProjectId) this.onSessionSynced?.({ sessionId: indexed.sessionId, projectId: indexed.currentProjectId, kind: 'removed' })
      }
    }
    if (scanFailure) throw scanFailure
  }
}
