import { randomUUID } from 'node:crypto'
import { listSessions, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import type { ProjectSummary, SessionRunState, SessionSummary } from '@cotta/shared'
import { createListCursor, resolveListCursor } from './list-cursor.js'
import { SessionActivityTracker } from './session-activity.js'

type SummaryCacheProject = {
  id: string
  name: string
  path: string
  lastActivityAt: number
}

type RefreshReason = 'background' | 'manual' | 'session-created' | 'session-stale' | 'focus' | 'load-more'

type RefreshInput = {
  reason?: RefreshReason
}

type SummaryVersionEvent = {
  epoch: string
  projectsVersion: number
  projectVersions: Array<{ projectId: string; version: number }>
}

type ProjectSessionsWindow = {
  sessions: SessionSummary[]
  hasMore: boolean
  nextCursor: string | null
  selectedSessionExists?: boolean
}

type CacheSnapshot = {
  projectsById: Map<string, SummaryCacheProject>
  sessionInfosByProjectId: Map<string, SDKSessionInfo[]>
  sessionRunStatesById: Map<string, SessionRunState | null>
  projectIdBySessionId: Map<string, string>
  projectSessionsFullyLoadedById: Map<string, boolean>
  scannedSessionCount: number
  projectsFullyScanned: boolean
}

export type SessionSummaryCacheChange = {
  projectId: string
  projectPath: string
  sessionInfo: SDKSessionInfo
}

type VersionChanges = {
  projectIds: Set<string>
  projectsChanged: boolean
  changedSessions: Map<string, SessionSummaryCacheChange>
}

function createVersionChanges(): VersionChanges {
  return {
    projectIds: new Set<string>(),
    projectsChanged: false,
    changedSessions: new Map(),
  }
}

export type SessionSummaryScanTarget = 'global' | { projectId: string }

type ObservationTimers = {
  projectId?: string
  debounce?: ReturnType<typeof setTimeout>
  maxWait?: ReturnType<typeof setTimeout>
}

function projectIdFromPath(path: string): string {
  return Buffer.from(path, 'utf8').toString('base64url')
}

function projectNameFromPath(path: string): string {
  const normalized = path.replace(/\/+$/, '')
  const name = normalized.split('/').filter(Boolean).at(-1)
  return name || path
}

function titleFromSession(session: SDKSessionInfo): string {
  return session.customTitle || session.summary || session.firstPrompt || session.sessionId
}

function normalizeProjectPath(path: string): string {
  return path.replace(/\/+$/, '') || '/'
}

function compareProjects(left: SummaryCacheProject, right: SummaryCacheProject): number {
  const byTime = right.lastActivityAt - left.lastActivityAt
  if (byTime !== 0) return byTime
  return left.id.localeCompare(right.id)
}

function compareSessions(activity: SessionActivityTracker, left: SDKSessionInfo, right: SDKSessionInfo): number {
  const byTime = activity.get(right) - activity.get(left)
  if (byTime !== 0) return byTime
  return left.sessionId.localeCompare(right.sessionId)
}

function sameProject(left: SummaryCacheProject, right: SummaryCacheProject): boolean {
  return left.id === right.id && left.name === right.name && left.path === right.path && left.lastActivityAt === right.lastActivityAt
}

function defaultRunState(): SessionRunState {
  return { phase: 'idle', activeUserMessageUuid: null }
}

function sameRunState(left: SessionRunState | null | undefined, right: SessionRunState | null | undefined): boolean {
  const leftState = left ?? defaultRunState()
  const rightState = right ?? defaultRunState()
  return (
    leftState.phase === rightState.phase &&
    leftState.activeUserMessageUuid === rightState.activeUserMessageUuid &&
    leftState.lastTurn?.id === rightState.lastTurn?.id &&
    leftState.lastTurn?.outcome === rightState.lastTurn?.outcome
  )
}

function toSessionSummary(
  activity: SessionActivityTracker,
  projectId: string,
  session: SDKSessionInfo,
  sessionRunStatesById?: Map<string, SessionRunState | null>,
): SessionSummary {
  return {
    id: session.sessionId,
    title: titleFromSession(session),
    projectId,
    lastActivityAt: activity.get(session),
    runState: sessionRunStatesById?.get(session.sessionId) ?? defaultRunState(),
  }
}

function exactProjectSessions(activity: SessionActivityTracker, projectPath: string, sessions: SDKSessionInfo[]): SDKSessionInfo[] {
  const normalized = normalizeProjectPath(projectPath)
  return sessions.filter((session) => normalizeProjectPath(session.cwd ?? '') === normalized).sort((left, right) => compareSessions(activity, left, right))
}

function buildProjectSessionsWindow(
  activity: SessionActivityTracker,
  projectId: string,
  sessions: SDKSessionInfo[],
  projectSessionsFullyLoaded: boolean,
  input: { limit?: number; cursor?: string | null },
  sessionRunStatesById: Map<string, SessionRunState | null> | undefined,
  paginationEpoch: string,
): ProjectSessionsWindow {
  const limit = Math.max(1, Math.min(10_000, Math.trunc(input.limit ?? 10)))
  const ids = sessions.map((session) => session.sessionId)
  const start = input.cursor
    ? resolveListCursor({
        cursor: input.cursor,
        kind: 'project-sessions',
        epoch: paginationEpoch,
        ids,
        projectId,
      })
    : 0
  const page = sessions.slice(start, start + limit)
  const hasMore = start + limit < sessions.length || !projectSessionsFullyLoaded
  const offset = start + page.length
  return {
    sessions: page.map((session) => toSessionSummary(activity, projectId, session, sessionRunStatesById)),
    hasMore,
    nextCursor:
      hasMore && page.length > 0
        ? createListCursor({
            kind: 'project-sessions',
            epoch: paginationEpoch,
            ids,
            offset,
            projectId,
          })
        : null,
  }
}

function sameSession(left: SDKSessionInfo, right: SDKSessionInfo): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.lastModified === right.lastModified &&
    left.fileSize === right.fileSize &&
    left.cwd === right.cwd &&
    titleFromSession(left) === titleFromSession(right)
  )
}

function sameSessionList(left: SDKSessionInfo[], right: SDKSessionInfo[]): boolean {
  return left.length === right.length && left.every((session, index) => sameSession(session, right[index]!))
}

function setIfChanged<K, V>(map: Map<K, V>, key: K, nextValue: V, equals: (left: V, right: V) => boolean): boolean {
  const currentValue = map.get(key)
  if (currentValue && equals(currentValue, nextValue)) return false
  map.set(key, nextValue)
  return true
}

function setBooleanIfChanged(map: Map<string, boolean>, key: string, nextValue: boolean): boolean {
  const currentValue = map.get(key)
  if (currentValue === nextValue) return false
  map.set(key, nextValue)
  return true
}

export class SessionSummaryCache {
  private readonly projectsById = new Map<string, SummaryCacheProject>()
  private readonly sessionInfosByProjectId = new Map<string, SDKSessionInfo[]>()
  private readonly projectSessionsFullyLoadedById = new Map<string, boolean>()
  private readonly projectVersionsById = new Map<string, number>()
  private readonly sessionRunStatesById = new Map<string, SessionRunState | null>()
  private readonly projectIdBySessionId = new Map<string, string>()
  readonly activity = new SessionActivityTracker()
  private mutationQueue: Promise<void> | null = null
  private scanPromise: Promise<void> | null = null
  private pendingGlobalScan = false
  private readonly pendingProjectScans = new Set<string>()
  private readonly observationTimers = new Map<string, ObservationTimers>()
  private backgroundRefreshTimer?: ReturnType<typeof setInterval>
  private projectsFullyScanned = false
  private closed = false
  private projectsVersionValue = 0
  private readonly epoch = randomUUID()
  private readonly paginationEpoch = randomUUID()
  private readonly listeners = new Set<(event: SummaryVersionEvent) => void>()
  private changedListener?: (changes: SessionSummaryCacheChange[]) => Promise<void>
  private sessionRunStateReader?: (sessionId: string) => SessionRunState | null

  constructor(private readonly pageSize = 100) {}

  setSessionRunStateReader(reader: ((sessionId: string) => SessionRunState | null) | undefined): void {
    this.sessionRunStateReader = reader
    this.refreshSessionRunStates()
  }

  subscribe(listener: (event: SummaryVersionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setChangedListener(listener: ((changes: SessionSummaryCacheChange[]) => Promise<void>) | undefined): void {
    this.changedListener = listener
  }

  get projectsVersion(): number {
    return this.projectsVersionValue
  }

  getProjectVersion(projectId: string): number {
    return this.projectVersionsById.get(projectId) ?? 0
  }

  get versionSnapshot(): SummaryVersionEvent {
    return {
      epoch: this.epoch,
      projectsVersion: this.projectsVersionValue,
      projectVersions: [...this.projectVersionsById].map(([projectId, version]) => ({ projectId, version })),
    }
  }

  async ensureReady(): Promise<void> {
    try {
      await this.requestScan('global')
    } finally {
      this.startBackgroundRefreshLoop()
    }
  }

  async requestScan(target: SessionSummaryScanTarget): Promise<void> {
    if (this.closed) return
    if (target === 'global' || !this.projectsById.has(target.projectId)) {
      this.pendingGlobalScan = true
      this.pendingProjectScans.clear()
    } else if (!this.pendingGlobalScan) {
      this.pendingProjectScans.add(target.projectId)
    }
    if (!this.scanPromise) {
      const scanPromise = (async () => {
        let firstError: unknown
        while (this.pendingGlobalScan || this.pendingProjectScans.size > 0) {
          const global = this.pendingGlobalScan
          const projectIds = global ? [] : [...this.pendingProjectScans]
          this.pendingGlobalScan = false
          this.pendingProjectScans.clear()
          try {
            await this.enqueueMutation(async () => {
              if (global) return this.rebuildFromScratch()
              for (const projectId of projectIds) await this.scanProject(projectId)
            })
          } catch (error) {
            firstError ??= error
          }
        }
        if (firstError) throw firstError
      })()
      this.scanPromise = scanPromise
      void scanPromise
        .finally(() => {
          if (this.scanPromise === scanPromise) this.scanPromise = null
        })
        .catch(() => undefined)
    }
    await this.scanPromise
  }

  async scheduleRefresh(_input: RefreshInput = {}): Promise<void> {
    await this.requestScan('global')
  }

  observeSession(input: { sessionId: string; projectId?: string }): void {
    if (this.closed) return
    const timers = this.observationTimers.get(input.sessionId) ?? {}
    if (input.projectId) timers.projectId = input.projectId
    const scan = () => {
      if (timers.debounce) clearTimeout(timers.debounce)
      if (timers.maxWait) clearTimeout(timers.maxWait)
      this.observationTimers.delete(input.sessionId)
      const projectId = timers.projectId ?? this.projectIdBySessionId.get(input.sessionId)
      void this.requestScan(projectId ? { projectId } : 'global').catch((error) => {
        console.error('session-summary-cache:observation failed', error)
      })
    }
    if (timers.debounce) clearTimeout(timers.debounce)
    timers.debounce = setTimeout(scan, 800)
    timers.debounce.unref?.()
    if (!timers.maxWait) {
      timers.maxWait = setTimeout(scan, 2_500)
      timers.maxWait.unref?.()
    }
    this.observationTimers.set(input.sessionId, timers)
  }

  async notifySessionRunStateActive(sessionId: string): Promise<void> {
    // Product rule: entering non-idle should mark an already-listed session immediately;
    // returning to idle waits for listSessions so the list state changes with transcript visibility.
    await this.enqueueMutation(async () => {
      const projectId = this.projectIdBySessionId.get(sessionId)
      if (!projectId) return
      const nextRunState = this.sessionRunStateReader?.(sessionId) ?? null
      if ((nextRunState ?? defaultRunState()).phase === 'idle') return
      if (sameRunState(this.sessionRunStatesById.get(sessionId), nextRunState)) return
      this.sessionRunStatesById.set(sessionId, nextRunState)
      const versionChanges = createVersionChanges()
      versionChanges.projectIds.add(projectId)
      await this.publishVersionChanges(versionChanges)
    })
  }

  close(): void {
    this.closed = true
    if (this.backgroundRefreshTimer) clearInterval(this.backgroundRefreshTimer)
    for (const timers of this.observationTimers.values()) {
      if (timers.debounce) clearTimeout(timers.debounce)
      if (timers.maxWait) clearTimeout(timers.maxWait)
    }
    this.observationTimers.clear()
  }

  async listProjects(input: { limit?: number; cursor?: string | null }): Promise<{
    projects: ProjectSummary[]
    hasMore: boolean
    nextCursor: string | null
  }> {
    const limit = Math.max(1, Math.min(10_000, Math.trunc(input.limit ?? 20)))
    await this.ensureProjectWindow(input, limit)
    const ordered = [...this.projectsById.values()].sort(compareProjects)
    const ids = ordered.map((project) => project.id)
    const start = input.cursor
      ? resolveListCursor({
          cursor: input.cursor,
          kind: 'projects',
          epoch: this.paginationEpoch,
          ids,
        })
      : 0
    const page = ordered.slice(start, start + limit)
    const hasMore = start + limit < ordered.length || !this.projectsFullyScanned
    const offset = start + page.length
    return {
      projects: page.map(({ id, name, path, lastActivityAt }) => ({
        id,
        name,
        path,
        lastActivityAt,
      })),
      hasMore,
      nextCursor:
        hasMore && page.length > 0
          ? createListCursor({
              kind: 'projects',
              epoch: this.paginationEpoch,
              ids,
              offset,
            })
          : null,
    }
  }

  private async ensureProjectWindow(_input: { cursor?: string | null }, _limit: number): Promise<void> {
    if (!this.projectsFullyScanned) await this.requestScan('global')
  }

  async getProject(projectId: string): Promise<ProjectSummary | null> {
    await this.discoverProjects([projectId])
    const project = this.projectsById.get(projectId)
    if (!project) return null
    return {
      id: project.id,
      name: project.name,
      path: project.path,
      lastActivityAt: project.lastActivityAt,
    }
  }

  private async discoverProjects(projectIds: string[]): Promise<void> {
    if (projectIds.every((projectId) => this.projectsById.has(projectId))) return
    await this.requestScan('global')
  }

  async queryProjectSessions(input: {
    projects: Array<{
      projectId: string
      limit?: number
      selectedSessionId?: string
    }>
  }): Promise<{ sessionsByProject: Record<string, ProjectSessionsWindow> }> {
    await this.discoverProjects(input.projects.map((project) => project.projectId))
    const sessionsByProject: Record<string, ProjectSessionsWindow> = {}
    for (const { projectId, limit, selectedSessionId } of input.projects) {
      const project = this.projectsById.get(projectId)
      if (!project) continue
      await this.maybeBackfillProjectSessions(project, { limit, cursor: null })
      if (!this.projectsById.has(projectId)) continue
      const sessions = this.sessionInfosByProjectId.get(projectId) ?? []
      const fullyLoaded = this.projectSessionsFullyLoadedById.get(projectId) ?? this.projectsFullyScanned
      const window = buildProjectSessionsWindow(
        this.activity,
        projectId,
        sessions,
        fullyLoaded,
        { limit, cursor: null },
        this.sessionRunStatesById,
        this.paginationEpoch,
      )
      if (selectedSessionId) {
        const selectedSessionExists = sessions.some((session) => session.sessionId === selectedSessionId)
        if (selectedSessionExists || fullyLoaded) window.selectedSessionExists = selectedSessionExists
      }
      sessionsByProject[projectId] = window
    }
    return { sessionsByProject }
  }

  async listProjectSessions(
    projectId: string,
    input: { limit?: number; cursor?: string | null },
  ): Promise<{
    project: ProjectSummary
    sessions: SessionSummary[]
    defaultSessionId: string | null
    hasMore: boolean
    nextCursor: string | null
  } | null> {
    await this.discoverProjects([projectId])
    const project = this.projectsById.get(projectId)
    if (!project) return null
    await this.maybeBackfillProjectSessions(project, input)
    const refreshedProject = this.projectsById.get(projectId)
    if (!refreshedProject) return null
    const sessions = this.sessionInfosByProjectId.get(projectId) ?? []
    const window = buildProjectSessionsWindow(
      this.activity,
      projectId,
      sessions,
      this.projectSessionsFullyLoadedById.get(projectId) ?? this.projectsFullyScanned,
      input,
      this.sessionRunStatesById,
      this.paginationEpoch,
    )
    return {
      project: {
        id: refreshedProject.id,
        name: refreshedProject.name,
        path: refreshedProject.path,
        lastActivityAt: refreshedProject.lastActivityAt,
      },
      sessions: window.sessions,
      defaultSessionId: sessions[0]?.sessionId ?? null,
      hasMore: window.hasMore,
      nextCursor: window.nextCursor,
    }
  }

  private async maybeBackfillProjectSessions(project: SummaryCacheProject, input: { limit?: number; cursor?: string | null }): Promise<void> {
    const sessions = this.sessionInfosByProjectId.get(project.id) ?? []
    const ids = sessions.map((session) => session.sessionId)
    const start = input.cursor
      ? resolveListCursor({
          cursor: input.cursor,
          kind: 'project-sessions',
          epoch: this.paginationEpoch,
          ids,
          projectId: project.id,
        })
      : 0
    const limit = Math.max(1, Math.min(10_000, Math.trunc(input.limit ?? 10)))
    if (start + limit <= sessions.length || (this.projectSessionsFullyLoadedById.get(project.id) ?? this.projectsFullyScanned)) return
    await this.requestScan({ projectId: project.id })
  }

  private async scanProject(projectId: string): Promise<void> {
    const currentProject = this.projectsById.get(projectId)
    if (!currentProject) return
    const loaded = exactProjectSessions(
      this.activity,
      currentProject.path,
      await listSessions({
        dir: currentProject.path,
        includeWorktrees: true,
        includeProgrammatic: true,
      }),
    )
    const versionChanges = createVersionChanges()
    const previousSessions = this.sessionInfosByProjectId.get(currentProject.id) ?? []
    const loadedIds = new Set(loaded.map((session) => session.sessionId))
    for (const session of previousSessions) {
      if (loadedIds.has(session.sessionId)) continue
      this.sessionRunStatesById.delete(session.sessionId)
      this.projectIdBySessionId.delete(session.sessionId)
      versionChanges.projectIds.add(currentProject.id)
    }
    for (const session of loaded) {
      this.removeSessionFromPreviousProject(session.sessionId, currentProject.id, versionChanges)
      this.projectIdBySessionId.set(session.sessionId, currentProject.id)
      const previous = previousSessions.find((candidate) => candidate.sessionId === session.sessionId)
      if (!previous || !sameSession(previous, session)) this.recordSessionChange(versionChanges, currentProject.id, currentProject.path, session)
    }
    if (!sameSessionList(previousSessions, loaded)) versionChanges.projectIds.add(currentProject.id)
    this.sessionInfosByProjectId.set(currentProject.id, loaded)
    if (setBooleanIfChanged(this.projectSessionsFullyLoadedById, currentProject.id, true)) versionChanges.projectIds.add(currentProject.id)
    for (const projectId of this.refreshSessionRunStates([currentProject.id])) versionChanges.projectIds.add(projectId)
    if (loaded.length === 0) {
      this.projectsById.delete(currentProject.id)
      this.sessionInfosByProjectId.delete(currentProject.id)
      this.projectSessionsFullyLoadedById.delete(currentProject.id)
      versionChanges.projectsChanged = true
    } else if (this.updateProjectFromSessions(currentProject.path, loaded)) {
      versionChanges.projectsChanged = true
    }
    await this.publishVersionChanges(versionChanges)
  }

  private recordSessionChange(versionChanges: VersionChanges, projectId: string, projectPath: string, sessionInfo: SDKSessionInfo): void {
    versionChanges.changedSessions.set(sessionInfo.sessionId, {
      projectId,
      projectPath,
      sessionInfo,
    })
  }

  private refreshSessionRunStates(projectIds?: Iterable<string>): Set<string> {
    const changedProjectIds = new Set<string>()
    const targetProjectIds = projectIds ? [...projectIds] : [...this.sessionInfosByProjectId.keys()]
    for (const projectId of targetProjectIds) {
      for (const session of this.sessionInfosByProjectId.get(projectId) ?? []) {
        const nextRunState = this.sessionRunStateReader?.(session.sessionId) ?? null
        if (!sameRunState(this.sessionRunStatesById.get(session.sessionId), nextRunState)) changedProjectIds.add(projectId)
        this.sessionRunStatesById.set(session.sessionId, nextRunState)
      }
    }
    return changedProjectIds
  }

  private startBackgroundRefreshLoop(): void {
    if (this.backgroundRefreshTimer || this.closed) return
    this.backgroundRefreshTimer = setInterval(() => {
      void this.requestScan('global').catch((error) => console.error('session-summary-cache:background-scan failed', error))
    }, 30 * 60_000)
    this.backgroundRefreshTimer.unref?.()
  }

  private enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
    let next: Promise<T>
    try {
      next = this.mutationQueue ? this.mutationQueue.then(task, task) : task()
    } catch (error) {
      next = Promise.reject(error)
    }
    const settled = next.then(
      () => undefined,
      () => undefined,
    )
    this.mutationQueue = settled
    void settled.finally(() => {
      if (this.mutationQueue === settled) this.mutationQueue = null
    })
    return next
  }

  private async rebuildFromScratch(): Promise<void> {
    const snapshot = await this.buildSnapshotFromGlobalScan()
    const versionChanges = this.replaceSnapshot(snapshot)
    await this.publishVersionChanges(versionChanges)
  }

  private async buildSnapshotFromGlobalScan(): Promise<CacheSnapshot> {
    const projectsById = new Map<string, SummaryCacheProject>()
    const sessionInfosByProjectId = new Map<string, SDKSessionInfo[]>()
    let offset = 0
    while (true) {
      const page = await listSessions({
        limit: this.pageSize,
        offset,
        includeWorktrees: true,
        includeProgrammatic: true,
      })
      if (page.length === 0) break
      for (const session of page) {
        if (!session.cwd) continue
        const path = normalizeProjectPath(session.cwd)
        const projectId = projectIdFromPath(path)
        const currentSessions = sessionInfosByProjectId.get(projectId) ?? []
        currentSessions.push(session)
        sessionInfosByProjectId.set(projectId, currentSessions)
        const currentProject = projectsById.get(projectId)
        const lastActivityAt = this.activity.get(session)
        const nextProject: SummaryCacheProject = currentProject
          ? {
              ...currentProject,
              lastActivityAt: Math.max(currentProject.lastActivityAt, lastActivityAt),
            }
          : {
              id: projectId,
              name: projectNameFromPath(path),
              path,
              lastActivityAt,
            }
        projectsById.set(projectId, nextProject)
      }
      offset += page.length
      if (page.length < this.pageSize) break
    }
    for (const [projectId, sessions] of sessionInfosByProjectId) {
      sessions.sort((left, right) => compareSessions(this.activity, left, right))
      sessionInfosByProjectId.set(projectId, sessions)
    }
    const projectSessionsFullyLoadedById = new Map<string, boolean>()
    for (const projectId of projectsById.keys()) projectSessionsFullyLoadedById.set(projectId, true)
    const sessionRunStatesById = new Map<string, SessionRunState | null>()
    const projectIdBySessionId = new Map<string, string>()
    for (const [projectId, sessions] of sessionInfosByProjectId) {
      for (const session of sessions) {
        sessionRunStatesById.set(session.sessionId, this.sessionRunStateReader?.(session.sessionId) ?? null)
        projectIdBySessionId.set(session.sessionId, projectId)
      }
    }
    return {
      projectsById,
      sessionInfosByProjectId,
      sessionRunStatesById,
      projectIdBySessionId,
      projectSessionsFullyLoadedById,
      scannedSessionCount: offset,
      projectsFullyScanned: true,
    }
  }

  private replaceSnapshot(snapshot: CacheSnapshot): VersionChanges {
    const versionChanges = createVersionChanges()
    const previousProjectIds = new Set(this.projectsById.keys())
    const nextProjectIds = new Set(snapshot.projectsById.keys())

    for (const [projectId, nextProject] of snapshot.projectsById) {
      const currentProject = this.projectsById.get(projectId)
      if (!currentProject || !sameProject(currentProject, nextProject)) {
        versionChanges.projectIds.add(projectId)
        versionChanges.projectsChanged = true
      }
      this.projectsById.set(projectId, nextProject)
    }
    for (const projectId of previousProjectIds) {
      if (nextProjectIds.has(projectId)) continue
      versionChanges.projectIds.add(projectId)
      versionChanges.projectsChanged = true
      this.projectsById.delete(projectId)
      this.sessionInfosByProjectId.delete(projectId)
      this.projectSessionsFullyLoadedById.delete(projectId)
    }

    for (const [projectId, nextSessions] of snapshot.sessionInfosByProjectId) {
      const currentSessions = this.sessionInfosByProjectId.get(projectId) ?? []
      if (!sameSessionList(currentSessions, nextSessions)) versionChanges.projectIds.add(projectId)
      const projectPath = snapshot.projectsById.get(projectId)?.path
      if (projectPath) {
        for (const session of nextSessions) {
          const previous = currentSessions.find((candidate) => candidate.sessionId === session.sessionId)
          if (!previous || !sameSession(previous, session)) this.recordSessionChange(versionChanges, projectId, projectPath, session)
        }
      }
      this.sessionInfosByProjectId.set(projectId, nextSessions)
      this.projectSessionsFullyLoadedById.set(projectId, snapshot.projectSessionsFullyLoadedById.get(projectId) ?? snapshot.projectsFullyScanned)
    }
    this.sessionRunStatesById.clear()
    for (const [sessionId, status] of snapshot.sessionRunStatesById) this.sessionRunStatesById.set(sessionId, status)
    this.projectIdBySessionId.clear()
    for (const [sessionId, projectId] of snapshot.projectIdBySessionId) this.projectIdBySessionId.set(sessionId, projectId)

    this.projectsFullyScanned = snapshot.projectsFullyScanned
    return versionChanges
  }

  private reconcileCoveredSessions(scannedSessions: SDKSessionInfo[], reachedEnd: boolean, versionChanges: VersionChanges): void {
    const scannedIds = new Set(scannedSessions.map((session) => session.sessionId))
    const cutoff = scannedSessions.length > 0 ? Math.min(...scannedSessions.map((session) => session.lastModified)) : Number.POSITIVE_INFINITY
    for (const [projectId, sessions] of [...this.sessionInfosByProjectId]) {
      const nextSessions = sessions.filter((session) => scannedIds.has(session.sessionId) || (!reachedEnd && session.lastModified <= cutoff))
      if (nextSessions.length === sessions.length) continue
      this.sessionInfosByProjectId.set(projectId, nextSessions)
      for (const session of sessions) {
        if (nextSessions.includes(session)) continue
        this.sessionRunStatesById.delete(session.sessionId)
        this.projectIdBySessionId.delete(session.sessionId)
      }
      versionChanges.projectIds.add(projectId)
      const project = this.projectsById.get(projectId)
      if (nextSessions.length === 0) {
        this.projectsById.delete(projectId)
        versionChanges.projectsChanged = true
      } else if (project && this.updateProjectFromSessions(project.path, nextSessions)) {
        versionChanges.projectsChanged = true
      }
    }
  }

  private removeSessionFromPreviousProject(sessionId: string, nextProjectId: string, versionChanges: VersionChanges): void {
    const previousProjectId = this.projectIdBySessionId.get(sessionId)
    if (!previousProjectId || previousProjectId === nextProjectId) return
    const previousSessions = this.sessionInfosByProjectId.get(previousProjectId) ?? []
    const nextSessions = previousSessions.filter((session) => session.sessionId !== sessionId)
    if (nextSessions.length === previousSessions.length) return
    this.sessionInfosByProjectId.set(previousProjectId, nextSessions)
    this.sessionRunStatesById.delete(sessionId)
    versionChanges.projectIds.add(previousProjectId)
    const previousProject = this.projectsById.get(previousProjectId)
    if (nextSessions.length === 0) {
      this.projectsById.delete(previousProjectId)
      versionChanges.projectsChanged = true
    } else if (previousProject && this.updateProjectFromSessions(previousProject.path, nextSessions)) {
      versionChanges.projectsChanged = true
    }
  }

  private applySessionsPage(page: SDKSessionInfo[], versionChanges: VersionChanges): void {
    for (const session of page) {
      if (!session.cwd) continue
      const path = normalizeProjectPath(session.cwd)
      const projectId = projectIdFromPath(path)
      this.removeSessionFromPreviousProject(session.sessionId, projectId, versionChanges)
      this.projectIdBySessionId.set(session.sessionId, projectId)
      const currentSessions = this.sessionInfosByProjectId.get(projectId) ?? []
      const existingIndex = currentSessions.findIndex((candidate) => candidate.sessionId === session.sessionId)
      if (existingIndex >= 0) {
        const existing = currentSessions[existingIndex]!
        if (!sameSession(existing, session)) {
          const nextSessions = [...currentSessions]
          nextSessions[existingIndex] = session
          nextSessions.sort((left, right) => compareSessions(this.activity, left, right))
          this.sessionInfosByProjectId.set(projectId, nextSessions)
          versionChanges.projectIds.add(projectId)
          this.recordSessionChange(versionChanges, projectId, path, session)
        }
      } else {
        const nextSessions = [...currentSessions, session].sort((left, right) => compareSessions(this.activity, left, right))
        this.sessionInfosByProjectId.set(projectId, nextSessions)
        versionChanges.projectIds.add(projectId)
        this.recordSessionChange(versionChanges, projectId, path, session)
      }
      if (this.updateProjectFromSessions(path, this.sessionInfosByProjectId.get(projectId) ?? [])) {
        versionChanges.projectIds.add(projectId)
        versionChanges.projectsChanged = true
      }
    }
  }

  private updateProjectFromSessions(projectPath: string, sessions: SDKSessionInfo[]): boolean {
    if (sessions.length === 0) return false
    const projectId = projectIdFromPath(projectPath)
    const nextProject: SummaryCacheProject = {
      id: projectId,
      name: projectNameFromPath(projectPath),
      path: normalizeProjectPath(projectPath),
      lastActivityAt: Math.max(...sessions.map((session) => this.activity.get(session))),
    }
    return setIfChanged(this.projectsById, projectId, nextProject, sameProject)
  }

  private async publishVersionChanges(versionChanges: VersionChanges): Promise<void> {
    if (versionChanges.changedSessions.size > 0) await this.changedListener?.([...versionChanges.changedSessions.values()])
    const projectVersions: Array<{ projectId: string; version: number }> = []
    for (const projectId of versionChanges.projectIds) {
      const nextVersion = (this.projectVersionsById.get(projectId) ?? 0) + 1
      this.projectVersionsById.set(projectId, nextVersion)
      projectVersions.push({ projectId, version: nextVersion })
    }
    if (!versionChanges.projectsChanged && projectVersions.length === 0) return
    if (versionChanges.projectsChanged) this.projectsVersionValue += 1
    const event: SummaryVersionEvent = {
      epoch: this.epoch,
      projectsVersion: this.projectsVersionValue,
      projectVersions,
    }
    for (const listener of this.listeners) listener(event)
  }
}
