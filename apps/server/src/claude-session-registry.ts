import { type FSWatcher, watch } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionStatus } from '@cotta/shared'

const MAX_SANE_EPOCH_MS = 4_000_000_000_000_000
const SESSION_FILE = /^(\d+)\.json$/

type Snapshot = {
  fileName: string
  fileMtimeMs: number
  rawJson: string
  payload: Record<string, unknown> | null
}

export type CliSessionMetadata = {
  status: SessionStatus
  hasRunningShell: boolean
  kind: string | null
  entrypoint: 'cli'
}

export type ClaudeSessionRegistryOptions = {
  sessionsDir?: string
  debounceMs?: number
}

export type ClaudeSessionRegistryChangedSession = {
  sessionId: string
  cwd: string | null
}

export type ClaudeSessionRegistryChange = {
  changedSessions: ClaudeSessionRegistryChangedSession[]
  idleSessionIds: string[]
  activeSessionIds: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringField(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key]
  return typeof value === 'string' ? value : null
}

export function isBackgroundKind(kind: string | null): boolean {
  return kind === 'bg' || kind === 'daemon' || kind === 'daemon-worker'
}

export function isActiveCliSessionMetadata(metadata: Pick<CliSessionMetadata, 'status' | 'kind'> | null | undefined): boolean {
  return metadata?.status === 'busy' || metadata?.status === 'waiting' || isBackgroundKind(metadata?.kind ?? null)
}

function activeSessionId(snapshot: Snapshot | undefined): string | null {
  if (!snapshot || stringField(snapshot.payload, 'entrypoint') !== 'cli') return null
  const sessionId = stringField(snapshot.payload, 'sessionId')
  return isActiveCliSessionMetadata({ status: sessionStatusFromSnapshot(snapshot), kind: stringField(snapshot.payload, 'kind') }) ? sessionId : null
}

function sessionStatusFromSnapshot(snapshot: Snapshot | undefined): SessionStatus {
  const status = stringField(snapshot?.payload ?? null, 'status')
  return status === 'busy' || status === 'waiting' ? status : 'idle'
}

function latestCliSnapshot(snapshots: Iterable<Snapshot>, sessionId: string): Snapshot | undefined {
  return Array.from(snapshots)
    .filter((snapshot) => stringField(snapshot.payload, 'sessionId') === sessionId && stringField(snapshot.payload, 'entrypoint') === 'cli')
    .sort(
      (left, right) =>
        (saneEpochField(right.payload, 'statusUpdatedAt') ?? saneEpochField(right.payload, 'updatedAt') ?? right.fileMtimeMs) -
        (saneEpochField(left.payload, 'statusUpdatedAt') ?? saneEpochField(left.payload, 'updatedAt') ?? left.fileMtimeMs),
    )[0]
}

function saneEpochField(payload: Record<string, unknown> | null, key: string): number | null {
  const value = payload?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_SANE_EPOCH_MS ? value : null
}

function defaultSessionsDir(): string {
  return join(homedir(), '.claude', 'sessions')
}

export class ClaudeSessionRegistry {
  private readonly sessionsDir: string
  private readonly debounceMs: number
  private snapshots = new Map<string, Snapshot>()
  private watcher: FSWatcher | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private scanChain: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(change: ClaudeSessionRegistryChange) => void>()
  private closed = false

  constructor(options: ClaudeSessionRegistryOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? defaultSessionsDir()
    this.debounceMs = options.debounceMs ?? 100
  }

  async start(): Promise<void> {
    if (this.closed || this.watcher) return
    this.watcher = watch(this.sessionsDir, () => this.scheduleScan())
    this.watcher.on('error', (error) => console.error('claude-session-registry:watch failed', error))
    this.snapshots = await this.readSnapshots()
    this.scheduleScan()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = null
    this.watcher?.close()
    this.watcher = null
    await this.scanChain
    this.listeners.clear()
  }

  subscribe(listener: (change: ClaudeSessionRegistryChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  cliSessionMetadata(sessionId: string): CliSessionMetadata | null {
    const current = latestCliSnapshot(this.snapshots.values(), sessionId)
    if (!current) return null
    const status = sessionStatusFromSnapshot(current)
    const kind = stringField(current.payload, 'kind')
    return {
      status,
      hasRunningShell: stringField(current.payload, 'status') === 'shell',
      kind,
      entrypoint: 'cli',
    }
  }

  private scheduleScan(): void {
    if (this.closed) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.scanChain = this.scanChain.then(() => this.scan()).catch((error) => console.error('claude-session-registry:scan failed', error))
    }, this.debounceMs)
    this.debounceTimer.unref?.()
  }

  private async scan(): Promise<void> {
    if (this.closed) return
    const next = await this.readSnapshots()
    const created: Snapshot[] = []
    const changed: Snapshot[] = []
    const deleted: Snapshot[] = []

    for (const [name, snapshot] of next) {
      const previous = this.snapshots.get(name)
      if (!previous) created.push(snapshot)
      else if (previous.rawJson !== snapshot.rawJson) changed.push(snapshot)
    }
    for (const [name, snapshot] of this.snapshots) {
      if (!next.has(name)) deleted.push(snapshot)
    }

    const idleSessionIds = new Set<string>()
    const activeSessionIds = new Set<string>()
    const changedSessionsById = new Map<string, ClaudeSessionRegistryChangedSession>()
    const addChangedSession = (snapshot: Snapshot) => {
      const sessionId = stringField(snapshot.payload, 'sessionId')
      if (sessionId) changedSessionsById.set(sessionId, { sessionId, cwd: stringField(snapshot.payload, 'cwd') })
      return sessionId
    }
    for (const snapshot of [...created, ...changed]) {
      const sessionId = addChangedSession(snapshot)
      if (!sessionId) continue
      const previousActiveSessionId = activeSessionId(this.snapshots.get(snapshot.fileName))
      const nextActiveSessionId = activeSessionId(snapshot)
      if (previousActiveSessionId && previousActiveSessionId !== nextActiveSessionId) idleSessionIds.add(previousActiveSessionId)
      if (nextActiveSessionId) activeSessionIds.add(nextActiveSessionId)
    }
    for (const snapshot of deleted) {
      addChangedSession(snapshot)
      const sessionId = activeSessionId(snapshot)
      if (sessionId) idleSessionIds.add(sessionId)
    }
    for (const sessionId of activeSessionIds) idleSessionIds.delete(sessionId)
    this.snapshots = next
    if (created.length + changed.length + deleted.length > 0) {
      const change = { changedSessions: [...changedSessionsById.values()], idleSessionIds: [...idleSessionIds], activeSessionIds: [...activeSessionIds] }
      for (const listener of this.listeners) listener(change)
    }
  }

  private async readSnapshots(): Promise<Map<string, Snapshot>> {
    const entries = await readdir(this.sessionsDir, { withFileTypes: true })
    const next = new Map<string, Snapshot>()
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && SESSION_FILE.test(entry.name))
        .map(async (entry) => {
          const filePath = join(this.sessionsDir, entry.name)
          try {
            const [rawJson, metadata] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)])
            let payload: Record<string, unknown> | null = null
            try {
              const parsed: unknown = JSON.parse(rawJson)
              if (isRecord(parsed)) payload = parsed
            } catch {
              payload = this.snapshots.get(entry.name)?.payload ?? null
            }
            next.set(entry.name, { fileName: entry.name, fileMtimeMs: metadata.mtimeMs, rawJson, payload })
          } catch (error) {
            const code = isRecord(error) && typeof error.code === 'string' ? error.code : null
            if (code !== 'ENOENT') {
              console.error(`claude-session-registry:read failed ${filePath}`, error)
              const previous = this.snapshots.get(entry.name)
              if (previous) next.set(entry.name, previous)
            }
          }
        }),
    )
    return next
  }
}

export async function createClaudeSessionRegistry(options?: ClaudeSessionRegistryOptions): Promise<ClaudeSessionRegistry> {
  const observer = new ClaudeSessionRegistry(options)
  await observer.start()
  return observer
}
