import { randomUUID } from 'node:crypto'
import { listSessions, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import type { ProjectSummary, SessionSummary } from '@cotta/shared'
import { createListCursor, resolveListCursor } from './list-cursor.js'

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
  sessionStatusesById: Map<string, string | null>
  projectIdBySessionId: Map<string, string>
  projectSessionsFullyLoadedById: Map<string, boolean>
  scannedSessionCount: number
  projectsFullyScanned: boolean
}

type VersionChanges = {
  projectIds: Set<string>
  projectsChanged: boolean
}

type RefreshKind = 'shallow' | 'deep' | 'rebuild'

const refreshPriority: Record<RefreshKind, number> = { shallow: 1, deep: 2, rebuild: 3 }

function strongerRefresh(left: RefreshKind | null, right: RefreshKind): RefreshKind {
  return !left || refreshPriority[right] > refreshPriority[left] ? right : left
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

function compareSessions(left: SDKSessionInfo, right: SDKSessionInfo): number {
  const byTime = right.lastModified - left.lastModified
  if (byTime !== 0) return byTime
  return left.sessionId.localeCompare(right.sessionId)
}

function sameProject(left: SummaryCacheProject, right: SummaryCacheProject): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.path === right.path
    && left.lastActivityAt === right.lastActivityAt
}

function toSessionSummary(projectId: string, session: SDKSessionInfo, sessionStatusesById?: Map<string, string | null>): SessionSummary {
  const liveState = sessionStatusesById?.get(session.sessionId) ?? null
  return {
    id: session.sessionId,
    title: titleFromSession(session),
    projectId,
    lastActivityAt: session.lastModified,
    ...(liveState ? { rawStatus: liveState, displayStatus: liveState } : {}),
  }
}

function exactProjectSessions(projectPath: string, sessions: SDKSessionInfo[]): SDKSessionInfo[] {
  const normalized = normalizeProjectPath(projectPath)
  return sessions
    .filter((session) => normalizeProjectPath(session.cwd ?? '') === normalized)
    .sort(compareSessions)
}

function buildProjectSessionsWindow(
  projectId: string,
  sessions: SDKSessionInfo[],
  projectSessionsFullyLoaded: boolean,
  input: { limit?: number; cursor?: string | null },
  sessionStatusesById: Map<string, string | null> | undefined,
  paginationEpoch: string,
): ProjectSessionsWindow {
  const limit = Math.max(1, Math.min(10_000, Math.trunc(input.limit ?? 10)))
  const ids = sessions.map((session) => session.sessionId)
  const start = input.cursor
    ? resolveListCursor({ cursor: input.cursor, kind: 'project-sessions', epoch: paginationEpoch, ids, projectId })
    : 0
  const page = sessions.slice(start, start + limit)
  const hasMore = start + limit < sessions.length || !projectSessionsFullyLoaded
  const offset = start + page.length
  return {
    sessions: page.map((session) => toSessionSummary(projectId, session, sessionStatusesById)),
    hasMore,
    nextCursor: hasMore && page.length > 0
      ? createListCursor({ kind: 'project-sessions', epoch: paginationEpoch, ids, offset, projectId })
      : null,
  }
}

function sameSession(left: SDKSessionInfo, right: SDKSessionInfo): boolean {
  return left.sessionId === right.sessionId
    && left.lastModified === right.lastModified
    && left.fileSize === right.fileSize
    && left.cwd === right.cwd
    && titleFromSession(left) === titleFromSession(right)
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
  private readonly sessionStatusesById = new Map<string, string | null>()
  private readonly projectIdBySessionId = new Map<string, string>()
  private mutationQueue: Promise<void> | null = null
  private refreshPromise: Promise<void> | null = null
  private pendingRefreshKind: RefreshKind | null = null
  private scannedOffset = 0
  private projectsFullyScanned = false
  private backgroundRefreshStarted = false
  private projectsVersionValue = 0
  private readonly epoch = randomUUID()
  private readonly paginationEpoch = randomUUID()
  private readonly listeners = new Set<(event: SummaryVersionEvent) => void>()
  private sessionStateReader?: (sessionId: string) => string | null

  constructor(private readonly pageSize = 100) {}

  setSessionStateReader(reader: ((sessionId: string) => string | null) | undefined): void {
    this.sessionStateReader = reader
    this.refreshSessionStatuses()
  }

  subscribe(listener: (event: SummaryVersionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
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
    if (this.projectsById.size > 0 || this.refreshPromise) {
      await (this.refreshPromise ?? Promise.resolve())
      return
    }
    try {
      while (this.projectsById.size < 20 && !this.projectsFullyScanned) {
        await this.runRefreshTask('deep')
      }
    } finally {
      this.startBackgroundRefreshLoop()
    }
  }

  async scheduleRefresh(_input: RefreshInput = {}): Promise<void> {
    await this.runRefreshTask('shallow')
  }

  async listProjects(input: { limit?: number; cursor?: string | null }): Promise<{ projects: ProjectSummary[]; hasMore: boolean; nextCursor: string | null }> {
    const limit = Math.max(1, Math.min(10_000, Math.trunc(input.limit ?? 20)))
    await this.ensureProjectWindow(input, limit)
    const ordered = [...this.projectsById.values()].sort(compareProjects)
    const ids = ordered.map((project) => project.id)
    const start = input.cursor
      ? resolveListCursor({ cursor: input.cursor, kind: 'projects', epoch: this.paginationEpoch, ids })
      : 0
    const page = ordered.slice(start, start + limit)
    const hasMore = start + limit < ordered.length || !this.projectsFullyScanned
    const offset = start + page.length
    return {
      projects: page.map(({ id, name, path, lastActivityAt }) => ({ id, name, path, lastActivityAt })),
      hasMore,
      nextCursor: hasMore && page.length > 0
        ? createListCursor({ kind: 'projects', epoch: this.paginationEpoch, ids, offset })
        : null,
    }
  }

  private async ensureProjectWindow(input: { cursor?: string | null }, limit: number): Promise<void> {
    while (!this.projectsFullyScanned) {
      const ordered = [...this.projectsById.values()].sort(compareProjects)
      const ids = ordered.map((project) => project.id)
      const start = input.cursor
        ? resolveListCursor({ cursor: input.cursor, kind: 'projects', epoch: this.paginationEpoch, ids })
        : 0
      if (start + limit <= ordered.length) return
      const beforeOffset = this.scannedOffset
      await this.runRefreshTask('deep')
      if (this.scannedOffset === beforeOffset) return
    }
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
    if (this.projectsFullyScanned || projectIds.every((projectId) => this.projectsById.has(projectId))) return
    await this.runRefreshTask('rebuild')
  }

  async queryProjectSessions(input: { projects: Array<{ projectId: string; limit?: number; selectedSessionId?: string }> }): Promise<{ sessionsByProject: Record<string, ProjectSessionsWindow> }> {
    await this.discoverProjects(input.projects.map((project) => project.projectId))
    const sessionsByProject: Record<string, ProjectSessionsWindow> = {}
    for (const { projectId, limit, selectedSessionId } of input.projects) {
      if (!this.projectsById.has(projectId)) continue
      const sessions = this.sessionInfosByProjectId.get(projectId) ?? []
      const fullyLoaded = this.projectSessionsFullyLoadedById.get(projectId) ?? this.projectsFullyScanned
      const window = buildProjectSessionsWindow(
        projectId,
        sessions,
        fullyLoaded,
        { limit, cursor: null },
        this.sessionStatusesById,
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

  async listProjectSessions(projectId: string, input: { limit?: number; cursor?: string | null }): Promise<{
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
      projectId,
      sessions,
      this.projectSessionsFullyLoadedById.get(projectId) ?? this.projectsFullyScanned,
      input,
      this.sessionStatusesById,
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
    await this.enqueueMutation(async () => {
      const currentProject = this.projectsById.get(project.id)
      if (!currentProject) return
      const sessions = this.sessionInfosByProjectId.get(currentProject.id) ?? []
      const ids = sessions.map((session) => session.sessionId)
      const start = input.cursor
        ? resolveListCursor({ cursor: input.cursor, kind: 'project-sessions', epoch: this.paginationEpoch, ids, projectId: currentProject.id })
        : 0
      const limit = Math.max(1, Math.min(10_000, Math.trunc(input.limit ?? 10)))
      const needsMoreFromCache = start + limit > sessions.length
      const isLoadMore = start > 0 || Boolean(input.cursor)
      if (!isLoadMore || !needsMoreFromCache || (this.projectSessionsFullyLoadedById.get(currentProject.id) ?? this.projectsFullyScanned)) return

      const loaded = exactProjectSessions(currentProject.path, await listSessions({
        dir: currentProject.path,
        includeWorktrees: true,
        includeProgrammatic: true,
      }))
      const versionChanges: VersionChanges = { projectIds: new Set<string>(), projectsChanged: false }
      const previousSessions = this.sessionInfosByProjectId.get(project.id) ?? []
      const loadedIds = new Set(loaded.map((session) => session.sessionId))
      for (const session of previousSessions) {
        if (loadedIds.has(session.sessionId)) continue
        this.sessionStatusesById.delete(session.sessionId)
        this.projectIdBySessionId.delete(session.sessionId)
        versionChanges.projectIds.add(project.id)
      }
      for (const session of loaded) {
        this.removeSessionFromPreviousProject(session.sessionId, project.id, versionChanges)
        this.projectIdBySessionId.set(session.sessionId, project.id)
      }
      if (!sameSessionList(previousSessions, loaded)) versionChanges.projectIds.add(project.id)
      this.sessionInfosByProjectId.set(project.id, loaded)
      if (setBooleanIfChanged(this.projectSessionsFullyLoadedById, project.id, true)) versionChanges.projectIds.add(project.id)
      for (const projectId of this.refreshSessionStatuses([project.id])) versionChanges.projectIds.add(projectId)
      if (loaded.length === 0) {
        this.projectsById.delete(project.id)
        this.sessionInfosByProjectId.delete(project.id)
        this.projectSessionsFullyLoadedById.delete(project.id)
        versionChanges.projectsChanged = true
      } else if (this.updateProjectFromSessions(project.path, loaded)) {
        versionChanges.projectsChanged = true
      }
      this.publishVersionChanges(versionChanges)
    })
  }

  private refreshSessionStatuses(projectIds?: Iterable<string>): Set<string> {
    const changedProjectIds = new Set<string>()
    const targetProjectIds = projectIds ? [...projectIds] : [...this.sessionInfosByProjectId.keys()]
    for (const projectId of targetProjectIds) {
      for (const session of this.sessionInfosByProjectId.get(projectId) ?? []) {
        const nextStatus = this.sessionStateReader?.(session.sessionId) ?? null
        if (this.sessionStatusesById.get(session.sessionId) !== nextStatus) changedProjectIds.add(projectId)
        this.sessionStatusesById.set(session.sessionId, nextStatus)
      }
    }
    return changedProjectIds
  }

  private startBackgroundRefreshLoop(): void {
    if (this.backgroundRefreshStarted) return
    this.backgroundRefreshStarted = true
    setInterval(() => {
      void this.runRefreshTask('shallow').catch((error) => console.error('session-summary-cache:shallow-refresh failed', error))
    }, 15_000)
    setInterval(() => {
      void this.runRefreshTask('deep').catch((error) => console.error('session-summary-cache:deep-refresh failed', error))
    }, 60_000)
    setInterval(() => {
      void this.runRefreshTask('rebuild').catch((error) => console.error('session-summary-cache:rebuild failed', error))
    }, 30 * 60_000)
  }

  private enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
    let next: Promise<T>
    try {
      next = this.mutationQueue ? this.mutationQueue.then(task, task) : task()
    } catch (error) {
      next = Promise.reject(error)
    }
    const settled = next.then(() => undefined, () => undefined)
    this.mutationQueue = settled
    void settled.finally(() => {
      if (this.mutationQueue === settled) this.mutationQueue = null
    })
    return next
  }

  private async runRefreshTask(kind: RefreshKind): Promise<void> {
    if (this.refreshPromise) {
      this.pendingRefreshKind = strongerRefresh(this.pendingRefreshKind, kind)
      await this.refreshPromise
      return
    }
    this.refreshPromise = (async () => {
      let current: RefreshKind | null = kind
      let firstError: unknown
      while (current) {
        try {
          await this.enqueueMutation(() => this.executeRefresh(current!))
        } catch (error) {
          firstError ??= error
        }
        current = this.pendingRefreshKind
        this.pendingRefreshKind = null
      }
      if (firstError) throw firstError
    })()
    try {
      await this.refreshPromise
    } finally {
      this.refreshPromise = null
    }
  }

  private async executeRefresh(kind: RefreshKind): Promise<void> {
    if (kind === 'rebuild') return this.rebuildFromScratch()
    const coveredPages = Math.max(1, Math.ceil(this.scannedOffset / this.pageSize))
    const maxPages = kind === 'shallow' ? 2 : Math.max(coveredPages + 4, 4)
    return this.runRefreshWindow(0, maxPages)
  }

  private async runRefreshWindow(startOffset: number, maxPages: number): Promise<void> {
    let offset = startOffset
    let reachedEnd = false
    const pages: SDKSessionInfo[][] = []
    for (let pagesRead = 0; pagesRead < maxPages; pagesRead += 1) {
      const page = await listSessions({
        limit: this.pageSize,
        offset,
        includeWorktrees: true,
        includeProgrammatic: true,
      })
      pages.push(page)
      offset += page.length
      if (page.length < this.pageSize) {
        reachedEnd = true
        break
      }
    }

    const scannedSessions = pages.flat()
    const versionChanges: VersionChanges = { projectIds: new Set<string>(), projectsChanged: false }
    for (const page of pages) this.applySessionsPage(page, versionChanges)
    this.reconcileCoveredSessions(scannedSessions, reachedEnd, versionChanges)
    this.projectsFullyScanned = reachedEnd
    for (const projectId of this.projectsById.keys()) {
      if (setBooleanIfChanged(this.projectSessionsFullyLoadedById, projectId, reachedEnd)) {
        versionChanges.projectIds.add(projectId)
      }
    }
    for (const projectId of this.refreshSessionStatuses()) versionChanges.projectIds.add(projectId)
    this.scannedOffset = Math.max(this.scannedOffset, offset)
    this.publishVersionChanges(versionChanges)
  }

  private async rebuildFromScratch(): Promise<void> {
    const snapshot = await this.buildSnapshotFromGlobalScan()
    const versionChanges = this.replaceSnapshot(snapshot)
    this.publishVersionChanges(versionChanges)
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
        const nextProject: SummaryCacheProject = currentProject
          ? { ...currentProject, lastActivityAt: Math.max(currentProject.lastActivityAt, session.lastModified) }
          : { id: projectId, name: projectNameFromPath(path), path, lastActivityAt: session.lastModified }
        projectsById.set(projectId, nextProject)
      }
      offset += page.length
      if (page.length < this.pageSize) break
    }
    for (const [projectId, sessions] of sessionInfosByProjectId) {
      sessions.sort(compareSessions)
      sessionInfosByProjectId.set(projectId, sessions)
    }
    const projectSessionsFullyLoadedById = new Map<string, boolean>()
    for (const projectId of projectsById.keys()) projectSessionsFullyLoadedById.set(projectId, true)
    const sessionStatusesById = new Map<string, string | null>()
    const projectIdBySessionId = new Map<string, string>()
    for (const [projectId, sessions] of sessionInfosByProjectId) {
      for (const session of sessions) {
        sessionStatusesById.set(session.sessionId, this.sessionStateReader?.(session.sessionId) ?? null)
        projectIdBySessionId.set(session.sessionId, projectId)
      }
    }
    return {
      projectsById,
      sessionInfosByProjectId,
      sessionStatusesById,
      projectIdBySessionId,
      projectSessionsFullyLoadedById,
      scannedSessionCount: offset,
      projectsFullyScanned: true,
    }
  }

  private replaceSnapshot(snapshot: CacheSnapshot): VersionChanges {
    const versionChanges: VersionChanges = { projectIds: new Set<string>(), projectsChanged: false }
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
      this.sessionInfosByProjectId.set(projectId, nextSessions)
      this.projectSessionsFullyLoadedById.set(projectId, snapshot.projectSessionsFullyLoadedById.get(projectId) ?? snapshot.projectsFullyScanned)
    }
    this.sessionStatusesById.clear()
    for (const [sessionId, status] of snapshot.sessionStatusesById) this.sessionStatusesById.set(sessionId, status)
    this.projectIdBySessionId.clear()
    for (const [sessionId, projectId] of snapshot.projectIdBySessionId) this.projectIdBySessionId.set(sessionId, projectId)

    this.projectsFullyScanned = snapshot.projectsFullyScanned
    this.scannedOffset = snapshot.scannedSessionCount
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
        this.sessionStatusesById.delete(session.sessionId)
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
    this.sessionStatusesById.delete(sessionId)
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
          nextSessions.sort(compareSessions)
          this.sessionInfosByProjectId.set(projectId, nextSessions)
          versionChanges.projectIds.add(projectId)
        }
      } else {
        const nextSessions = [...currentSessions, session].sort(compareSessions)
        this.sessionInfosByProjectId.set(projectId, nextSessions)
        versionChanges.projectIds.add(projectId)
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
      lastActivityAt: Math.max(...sessions.map((session) => session.lastModified)),
    }
    return setIfChanged(this.projectsById, projectId, nextProject, sameProject)
  }

  private publishVersionChanges(versionChanges: VersionChanges): void {
    const projectVersions: Array<{ projectId: string; version: number }> = []
    for (const projectId of versionChanges.projectIds) {
      const nextVersion = (this.projectVersionsById.get(projectId) ?? 0) + 1
      this.projectVersionsById.set(projectId, nextVersion)
      projectVersions.push({ projectId, version: nextVersion })
    }
    if (!versionChanges.projectsChanged && projectVersions.length === 0) return
    if (versionChanges.projectsChanged) this.projectsVersionValue += 1
    const event: SummaryVersionEvent = { epoch: this.epoch, projectsVersion: this.projectsVersionValue, projectVersions }
    for (const listener of this.listeners) listener(event)
  }
}
