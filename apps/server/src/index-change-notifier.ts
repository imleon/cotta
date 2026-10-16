import { randomUUID } from 'node:crypto'
import type { ListVersionsEvent } from '@cotta/shared'

type SessionChange = ListVersionsEvent['sessionChanges'][number]

export type IndexChangeInput =
  | { projectId?: string; previousProjectId?: string; sessionId?: string; kind?: 'changed'; cwd?: string; selectedSessionVersion?: string }
  | (SessionChange & { previousProjectId?: string; cwd?: string; selectedSessionVersion?: string })

function sessionChange(input: IndexChangeInput): SessionChange | null {
  if (input.kind === 'removed') return { projectId: input.projectId, sessionId: input.sessionId, kind: input.kind }
  if (input.kind !== 'changed' || !('version' in input)) return null
  return input.reset
    ? { projectId: input.projectId, sessionId: input.sessionId, kind: input.kind, version: input.version, reset: true, invalidateFromTurnId: null }
    : { projectId: input.projectId, sessionId: input.sessionId, kind: input.kind, version: input.version, reset: false, invalidateFromTurnId: input.invalidateFromTurnId }
}

export class IndexChangeNotifier {
  private readonly epoch = randomUUID()
  private projectsVersionValue = 0
  private readonly projectVersionsById = new Map<string, number>()
  private readonly subagentVersionsBySessionId = new Map<string, number>()
  private readonly listeners = new Set<(event: ListVersionsEvent) => void>()

  get versionSnapshot(): ListVersionsEvent {
    return this.snapshot()
  }

  snapshot(selectedSession?: { projectId: string; sessionId: string; version?: string | null } | null): ListVersionsEvent {
    return {
      epoch: this.epoch,
      projectsVersion: this.projectsVersionValue,
      projectVersions: [...this.projectVersionsById].map(([projectId, version]) => ({ projectId, version })),
      sessionVersions: selectedSession?.version ? [{ projectId: selectedSession.projectId, sessionId: selectedSession.sessionId, version: selectedSession.version, snapshot: true }] : [],
      subagentVersions: selectedSession
        ? [{ projectId: selectedSession.projectId, sessionId: selectedSession.sessionId, version: this.subagentVersionsBySessionId.get(selectedSession.sessionId) ?? 0, snapshot: true }]
        : [],
      sessionChanges: [],
    }
  }

  subscribe(listener: (event: ListVersionsEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  observeSession(input: { sessionId: string; projectId?: string }): void {
    this.publishChange(input.projectId ? { projectId: input.projectId } : {})
  }

  publishSessionVersion(projectId: string, sessionId: string, version: string): void {
    const event: ListVersionsEvent = {
      epoch: this.epoch,
      projectsVersion: this.projectsVersionValue,
      projectVersions: [],
      sessionVersions: [{ projectId, sessionId, version }],
      subagentVersions: [],
      sessionChanges: [],
    }
    for (const listener of this.listeners) listener(event)
  }

  publishSubagentChange(projectId: string, sessionId: string): void {
    const version = (this.subagentVersionsBySessionId.get(sessionId) ?? 0) + 1
    this.subagentVersionsBySessionId.set(sessionId, version)
    const event: ListVersionsEvent = {
      epoch: this.epoch,
      projectsVersion: this.projectsVersionValue,
      projectVersions: [],
      sessionVersions: [],
      subagentVersions: [{ projectId, sessionId, version }],
      sessionChanges: [],
    }
    for (const listener of this.listeners) listener(event)
  }

  publishProjectListChange(projectId: string): void {
    this.projectsVersionValue += 1
    const version = (this.projectVersionsById.get(projectId) ?? 0) + 1
    this.projectVersionsById.set(projectId, version)
    const event: ListVersionsEvent = {
      epoch: this.epoch,
      projectsVersion: this.projectsVersionValue,
      projectVersions: [{ projectId, version }],
      sessionVersions: [],
      subagentVersions: [],
      sessionChanges: [],
    }
    for (const listener of this.listeners) listener(event)
  }

  publishChange(input: IndexChangeInput = {}): void {
    // projectsVersion invalidates the projects list; session-level project changes can update project activity.
    const projectVersions: ListVersionsEvent['projectVersions'] = []
    if (!input.projectId || input.sessionId) this.projectsVersionValue += 1
    const bumpProject = (projectId: string) => {
      const version = (this.projectVersionsById.get(projectId) ?? 0) + 1
      this.projectVersionsById.set(projectId, version)
      projectVersions.push({ projectId, version })
    }
    if (input.previousProjectId && input.previousProjectId !== input.projectId) bumpProject(input.previousProjectId)
    if (input.projectId) bumpProject(input.projectId)
    const event: ListVersionsEvent = {
      epoch: this.epoch,
      projectsVersion: this.projectsVersionValue,
      projectVersions,
      sessionVersions: input.projectId && input.sessionId && input.selectedSessionVersion ? [{ projectId: input.projectId, sessionId: input.sessionId, version: input.selectedSessionVersion }] : [],
      subagentVersions: [],
      sessionChanges: input.projectId && input.sessionId ? [sessionChange(input)].filter((change): change is SessionChange => change !== null) : [],
    }
    for (const listener of this.listeners) listener(event)
  }

  close(): void {
    this.listeners.clear()
  }
}
