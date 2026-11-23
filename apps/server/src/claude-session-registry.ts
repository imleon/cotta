import { constants, type FSWatcher, lstatSync, type Stats, unlinkSync, watch } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionStatus } from '@cotta/shared'
import { isOwnedClaudeProcess } from './claude-cli/query.js'

const MAX_SANE_EPOCH_MS = 4_000_000_000_000_000
const SESSION_FILE = /^(\d+)\.json$/
const REVALIDATE_INTERVAL_MS = 30_000
const OPEN_NOFOLLOW_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

type Snapshot = {
  fileName: string
  fileMtimeMs: number
  ino: number
  dev: number
  owned: boolean
  rawJson: string
  payload: Record<string, unknown> | null
}

export type CliSessionMetadata = {
  status: SessionStatus
  hasRunningShell: boolean
  kind: string | null
  entrypoint: string | null
}

export type ClaudeSessionRegistryOptions = {
  sessionsDir?: string
  debounceMs?: number
  isOwnedProcess?: (pid: number) => boolean
  checkProcess?: (pid: number) => void
  now?: () => number
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

function isExternalSnapshot(snapshot: Snapshot, isOwnedProcess: (pid: number) => boolean): boolean {
  return !(stringField(snapshot.payload, 'entrypoint') === 'cotta' && (snapshot.owned || isOwnedProcess(Number(snapshot.fileName.slice(0, -5)))))
}

function activeSessionId(snapshot: Snapshot | undefined, isOwnedProcess: (pid: number) => boolean): string | null {
  if (!snapshot || !isExternalSnapshot(snapshot, isOwnedProcess)) return null
  const sessionId = stringField(snapshot.payload, 'sessionId')
  return isActiveCliSessionMetadata({ status: sessionStatusFromSnapshot(snapshot), kind: stringField(snapshot.payload, 'kind') }) ? sessionId : null
}

function sessionStatusFromSnapshot(snapshot: Snapshot | undefined): SessionStatus {
  const status = stringField(snapshot?.payload ?? null, 'status')
  return status === 'busy' || status === 'waiting' ? status : 'idle'
}

function latestCliSnapshot(snapshots: Iterable<Snapshot>, sessionId: string, isOwnedProcess: (pid: number) => boolean): Snapshot | undefined {
  return Array.from(snapshots)
    .filter((snapshot) => stringField(snapshot.payload, 'sessionId') === sessionId && isExternalSnapshot(snapshot, isOwnedProcess))
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

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === 'string' ? error.code : null
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

export class ClaudeSessionRegistry {
  private readonly sessionsDir: string
  private readonly debounceMs: number
  private readonly isOwnedProcess: (pid: number) => boolean
  private readonly checkProcess: (pid: number) => void
  private readonly now: () => number
  private lastRevalidatedAt = -Infinity
  private scanRunning = false
  private scanRequested = false
  private snapshots = new Map<string, Snapshot>()
  private watcher: FSWatcher | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private scanChain: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(change: ClaudeSessionRegistryChange) => void>()
  private closed = false

  constructor(options: ClaudeSessionRegistryOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? defaultSessionsDir()
    this.debounceMs = options.debounceMs ?? 100
    this.isOwnedProcess = options.isOwnedProcess ?? isOwnedClaudeProcess
    this.checkProcess = options.checkProcess ?? ((pid) => process.kill(pid, 0))
    this.now = options.now ?? Date.now
  }

  async start(): Promise<void> {
    if (this.closed || this.watcher) return
    const watcher = watch(this.sessionsDir, () => this.scheduleScan())
    watcher.on('error', (error) => console.error('claude-session-registry:watch failed', error))
    this.watcher = watcher
    this.scanRunning = true
    this.lastRevalidatedAt = this.now()
    let startupError: unknown = null
    let failed = false
    this.scanChain = this.scanChain.then(async () => {
      try {
        this.snapshots = await this.readSnapshots()
      } catch (error) {
        failed = true
        startupError = error
      } finally {
        this.scanRunning = false
      }
    })
    await this.scanChain
    if (failed) {
      this.scanRequested = false
      if (this.debounceTimer) clearTimeout(this.debounceTimer)
      this.debounceTimer = null
      if (this.watcher === watcher) {
        this.watcher = null
        watcher.close()
      }
      throw startupError
    }
    if (this.closed) return
    if (this.scanRequested) {
      void this.requestScan()
    }
  }

  revalidateIfDue(): Promise<void> {
    const now = this.now()
    if (this.closed || !this.watcher || (now >= this.lastRevalidatedAt && now - this.lastRevalidatedAt < REVALIDATE_INTERVAL_MS)) return Promise.resolve()
    // A running scan already probes liveness; periodic ticks must not build a backlog.
    if (this.scanRunning) return this.scanChain
    return this.requestScan()
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
    const current = latestCliSnapshot(this.snapshots.values(), sessionId, this.isOwnedProcess)
    if (!current) return null
    const entrypoint = stringField(current.payload, 'entrypoint')
    const status = sessionStatusFromSnapshot(current)
    const kind = stringField(current.payload, 'kind')
    return {
      status,
      hasRunningShell: stringField(current.payload, 'status') === 'shell',
      kind,
      entrypoint,
    }
  }

  private scheduleScan(): void {
    if (this.closed) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.requestScan()
    }, this.debounceMs)
    this.debounceTimer.unref?.()
  }

  private requestScan(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = null
    this.scanRequested = true
    if (this.scanRunning) return this.scanChain
    this.scanRunning = true
    this.scanChain = this.scanChain.then(async () => {
      try {
        while (this.scanRequested && !this.closed) {
          this.scanRequested = false
          this.lastRevalidatedAt = this.now()
          try {
            await this.scan()
          } catch (error) {
            console.error('claude-session-registry:scan failed', error)
          }
        }
      } finally {
        this.scanRunning = false
      }
    })
    return this.scanChain
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
      const previousActiveSessionId = activeSessionId(this.snapshots.get(snapshot.fileName), this.isOwnedProcess)
      const nextActiveSessionId = activeSessionId(snapshot, this.isOwnedProcess)
      if (previousActiveSessionId && previousActiveSessionId !== nextActiveSessionId) idleSessionIds.add(previousActiveSessionId)
      if (nextActiveSessionId) activeSessionIds.add(nextActiveSessionId)
    }
    for (const snapshot of deleted) {
      addChangedSession(snapshot)
      const sessionId = activeSessionId(snapshot, this.isOwnedProcess)
      if (sessionId) idleSessionIds.add(sessionId)
    }
    for (const sessionId of activeSessionIds) idleSessionIds.delete(sessionId)
    this.snapshots = next
    if (created.length + changed.length + deleted.length > 0) {
      const change = { changedSessions: [...changedSessionsById.values()], idleSessionIds: [...idleSessionIds], activeSessionIds: [...activeSessionIds] }
      for (const listener of this.listeners) listener(change)
    }
  }

  private processIsDead(pid: number): boolean {
    try {
      this.checkProcess(pid)
    } catch (error) {
      if (errorCode(error) === 'ESRCH') return true
      console.error(`claude-session-registry:pid probe inconclusive pid=${pid} code=${errorCode(error) ?? 'unknown'}`, error)
    }
    return false
  }

  private async discardStale(filePath: string, pid: number, rawJson: string, metadata: Stats): Promise<boolean> {
    try {
      // Independently reopen without following links: the earlier snapshot is not deletion authority.
      const handle = await open(filePath, OPEN_NOFOLLOW_FLAGS)
      try {
        const before = await handle.stat()
        if (!sameFile(metadata, before)) {
          this.scheduleScan()
          return false
        }
        const currentJson = await handle.readFile('utf8')
        const after = await handle.stat()
        if (currentJson !== rawJson || !sameFile(before, after)) {
          this.scheduleScan()
          return false
        }
        // No portable atomic compare-and-unlink exists on POSIX; execute the final path/PID checks
        // and unlink synchronously back-to-back without yielding across the libuv threadpool.
        const pathMetadata = lstatSync(filePath)
        if (!sameFile(after, pathMetadata)) {
          this.scheduleScan()
          return false
        }
        if (!this.processIsDead(pid)) {
          this.scheduleScan()
          return false
        }
        try {
          unlinkSync(filePath)
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') {
            console.error(`claude-session-registry:stale unlink failed path=${filePath} pid=${pid} code=${errorCode(error) ?? 'unknown'}`, error)
          }
        }
        // Confirmed invalid metadata stays excluded even if disk cleanup failed. Recheck next scan.
        return true
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return true
      console.error(`claude-session-registry:stale verification failed path=${filePath} pid=${pid} code=${errorCode(error) ?? 'unknown'}`, error)
      if (errorCode(error) === 'ELOOP') this.scheduleScan()
      return false
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
          const previous = this.snapshots.get(entry.name)
          try {
            let snapshot: Snapshot | null = null
            let staleCandidate: { pid: number; rawJson: string; metadata: Stats } | null = null
            const handle = await open(filePath, OPEN_NOFOLLOW_FLAGS)
            try {
              const metadata = await handle.stat()
              if (!metadata.isFile()) {
                if (previous) next.set(entry.name, previous)
                this.scheduleScan()
                return
              }
              const rawJson = await handle.readFile('utf8')
              const after = await handle.stat()
              const pathMetadata = await lstat(filePath)
              const stable = sameFile(metadata, after) && sameFile(after, pathMetadata)
              let payload: Record<string, unknown> | null = null
              let parsedSuccessfully = false
              try {
                const parsed: unknown = JSON.parse(rawJson)
                if (isRecord(parsed) && !Array.isArray(parsed)) {
                  payload = parsed
                  parsedSuccessfully = true
                }
              } catch {
                payload = previous?.payload ?? null
              }
              const pid = Number(entry.name.slice(0, -5))
              const owned = this.isOwnedProcess(pid) || (previous?.owned === true && previous.ino === metadata.ino && previous.dev === metadata.dev)
              snapshot = { fileName: entry.name, fileMtimeMs: metadata.mtimeMs, ino: metadata.ino, dev: metadata.dev, owned, rawJson, payload }
              if (!stable) {
                next.set(entry.name, previous ?? snapshot)
                this.scheduleScan()
                return
              }
              if (parsedSuccessfully && payload?.entrypoint === 'cotta' && Number.isSafeInteger(pid) && pid > 1 && entry.name === `${pid}.json` && payload.pid === pid && this.processIsDead(pid)) {
                staleCandidate = { pid, rawJson, metadata }
              }
            } finally {
              await handle.close()
            }
            if (staleCandidate && (await this.discardStale(filePath, staleCandidate.pid, staleCandidate.rawJson, staleCandidate.metadata))) {
              return
            }
            if (snapshot) next.set(entry.name, snapshot)
          } catch (error) {
            if (errorCode(error) !== 'ENOENT') {
              console.error(`claude-session-registry:read failed ${filePath}`, error)
              if (previous) next.set(entry.name, previous)
              if (errorCode(error) === 'ELOOP') this.scheduleScan()
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
