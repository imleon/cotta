import { mkdirSync, watch, type FSWatcher } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionObservation, SessionObservationSort, SessionObservationsResponse, SessionStatus } from '@cotta/shared'

const MAX_SANE_EPOCH_MS = 4_000_000_000_000_000
const SESSION_FILE = /^(\d+)\.json$/
const SORT_COLUMNS: Record<SessionObservationSort, string> = {
  id: 'id', eventKind: 'event_kind', observedAtMs: 'observed_at_ms', fileName: 'file_name', filePath: 'file_path', filePid: 'file_pid',
  fileMtimeMs: 'file_mtime_ms', fileSizeBytes: 'file_size_bytes', rawJson: 'raw_json', parseError: 'parse_error', payloadPid: 'payload_pid',
  procStart: 'proc_start', sessionId: 'session_id', cwd: 'cwd', startedAtMs: 'started_at_ms', updatedAtMs: 'updated_at_ms',
  statusUpdatedAtMs: 'status_updated_at_ms', version: 'version', peerProtocol: 'peer_protocol', kind: 'kind', entrypoint: 'entrypoint',
  name: 'name', nameSource: 'name_source', status: 'status', waitingFor: 'waiting_for', tempo: 'tempo', state: 'state', detail: 'detail',
  needs: 'needs', agent: 'agent', messagingSocketPath: 'messaging_socket_path', jobId: 'job_id', parkedJobId: 'parked_job_id',
  bridgeSessionId: 'bridge_session_id', logPath: 'log_path', tmux: 'tmux', pidAlive: 'pid_alive', procStartMatches: 'proc_start_matches',
}

type EventKind = 'snapshot' | 'create' | 'change' | 'delete'
type Snapshot = {
  fileName: string
  filePath: string
  filePid: number
  fileMtimeMs: number
  fileSizeBytes: number
  rawJson: string
  payload: Record<string, unknown> | null
  parseError: string | null
}

export type CliSessionMetadata = {
  status: SessionStatus
  hasRunningShell: boolean
  kind: string | null
  entrypoint: 'cli'
}

export type ClaudeSessionRegistryOptions = {
  sessionsDir?: string
  dbPath?: string
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

function isBackgroundKind(kind: string | null): boolean {
  return kind === 'bg' || kind === 'daemon' || kind === 'daemon-worker'
}

function activeSessionId(snapshot: Snapshot | undefined): string | null {
  if (!snapshot || stringField(snapshot.payload, 'entrypoint') !== 'cli') return null
  const status = stringField(snapshot.payload, 'status')
  if (isBackgroundKind(stringField(snapshot.payload, 'kind'))) return stringField(snapshot.payload, 'sessionId')
  return status === 'busy' || status === 'waiting' ? stringField(snapshot.payload, 'sessionId') : null
}

function sessionStatusFromSnapshot(snapshot: Snapshot | undefined): SessionStatus {
  const status = stringField(snapshot?.payload ?? null, 'status')
  return status === 'busy' || status === 'waiting' ? status : 'idle'
}

function latestCliSnapshot(snapshots: Iterable<Snapshot>, sessionId: string): Snapshot | undefined {
  return Array.from(snapshots)
    .filter((snapshot) => stringField(snapshot.payload, 'sessionId') === sessionId && stringField(snapshot.payload, 'entrypoint') === 'cli')
    .sort((left, right) => (saneEpochField(right.payload, 'statusUpdatedAt') ?? saneEpochField(right.payload, 'updatedAt') ?? right.fileMtimeMs) - (saneEpochField(left.payload, 'statusUpdatedAt') ?? saneEpochField(left.payload, 'updatedAt') ?? left.fileMtimeMs))[0]
}

function integerField(payload: Record<string, unknown> | null, key: string): number | null {
  const value = payload?.[key]
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function saneEpochField(payload: Record<string, unknown> | null, key: string): number | null {
  const value = payload?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_SANE_EPOCH_MS ? value : null
}

function processAlive(pid: number | null): number | null {
  if (pid === null) return null
  try {
    process.kill(pid, 0)
    return 1
  } catch {
    return 0
  }
}

async function linuxProcessStartMatches(pid: number | null, expected: string | null): Promise<number | null> {
  if (process.platform !== 'linux' || pid === null || expected === null) return null
  try {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8')
    const close = value.lastIndexOf(')')
    const fields = close >= 0 ? value.slice(close + 2).split(' ') : []
    return fields[19] === expected ? 1 : 0
  } catch {
    return null
  }
}

function nullableBoolean(value: unknown): boolean | null {
  return value === null || value === undefined ? null : Number(value) !== 0
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function toObservation(row: Record<string, unknown>): SessionObservation {
  return {
    id: Number(row.id), eventKind: row.event_kind as SessionObservation['eventKind'], observedAtMs: Number(row.observed_at_ms),
    fileName: String(row.file_name), filePath: String(row.file_path), filePid: nullableNumber(row.file_pid), fileMtimeMs: nullableNumber(row.file_mtime_ms),
    fileSizeBytes: nullableNumber(row.file_size_bytes), rawJson: String(row.raw_json), parseError: nullableString(row.parse_error),
    payloadPid: nullableNumber(row.payload_pid), procStart: nullableString(row.proc_start), sessionId: nullableString(row.session_id), cwd: nullableString(row.cwd),
    startedAtMs: nullableNumber(row.started_at_ms), updatedAtMs: nullableNumber(row.updated_at_ms), statusUpdatedAtMs: nullableNumber(row.status_updated_at_ms),
    version: nullableString(row.version), peerProtocol: nullableNumber(row.peer_protocol), kind: nullableString(row.kind), entrypoint: nullableString(row.entrypoint),
    name: nullableString(row.name), nameSource: nullableString(row.name_source), status: nullableString(row.status), waitingFor: nullableString(row.waiting_for),
    tempo: nullableString(row.tempo), state: nullableString(row.state), detail: nullableString(row.detail), needs: nullableString(row.needs), agent: nullableString(row.agent),
    messagingSocketPath: nullableString(row.messaging_socket_path), jobId: nullableString(row.job_id), parkedJobId: nullableString(row.parked_job_id),
    bridgeSessionId: nullableString(row.bridge_session_id), logPath: nullableString(row.log_path), tmux: nullableString(row.tmux),
    pidAlive: nullableBoolean(row.pid_alive), procStartMatches: nullableBoolean(row.proc_start_matches),
  }
}

function defaultSessionsDir(): string {
  return join(homedir(), '.claude', 'sessions')
}

function defaultDbPath(): string {
  return resolve(process.cwd(), process.env.COTTA_SESSION_OBSERVATIONS_DB_PATH ?? 'data/cotta-session-observations.sqlite')
}

export class ClaudeSessionRegistry {
  private readonly db: DatabaseSync
  private readonly insertStatement
  private readonly sessionsDir: string
  private readonly debounceMs: number
  private snapshots = new Map<string, Snapshot>()
  private watcher: FSWatcher | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private scanChain: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(change: ClaudeSessionRegistryChange) => void>()
  private closed = false

  constructor(options: ClaudeSessionRegistryOptions = {}) {
    const dbPath = options.dbPath ?? defaultDbPath()
    this.sessionsDir = options.sessionsDir ?? defaultSessionsDir()
    this.debounceMs = options.debounceMs ?? 100
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.migrate()
    this.insertStatement = this.db.prepare(`
      INSERT INTO session_registry_observations (
        event_kind, observed_at_ms, file_name, file_path, file_pid, file_mtime_ms, file_size_bytes, raw_json, parse_error,
        payload_pid, proc_start, session_id, cwd, started_at_ms, updated_at_ms, status_updated_at_ms, version, peer_protocol,
        kind, entrypoint, name, name_source, status, waiting_for, tempo, state, detail, needs, agent,
        messaging_socket_path, job_id, parked_job_id, bridge_session_id, log_path, tmux, pid_alive, proc_start_matches
      ) VALUES (${Array.from({ length: 37 }, () => '?').join(', ')})
    `)
  }

  async start(): Promise<void> {
    if (this.closed || this.watcher) return
    this.watcher = watch(this.sessionsDir, () => this.scheduleScan())
    this.watcher.on('error', (error) => console.error('claude-session-registry:watch failed', error))
    const initial = await this.readSnapshots()
    const latestRawByFile = new Map((this.db.prepare(`
      SELECT file_name, raw_json
      FROM session_registry_observations
      WHERE id IN (SELECT MAX(id) FROM session_registry_observations GROUP BY file_name)
    `).all() as Array<{ file_name: string; raw_json: string }>).map((row) => [row.file_name, row.raw_json]))
    await this.appendBatch('snapshot', Array.from(initial.values()).filter((snapshot) => latestRawByFile.get(snapshot.fileName) !== snapshot.rawJson))
    this.snapshots = initial
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
    this.db.close()
  }

  subscribe(listener: (change: ClaudeSessionRegistryChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  cliSessionMetadata(sessionId: string): CliSessionMetadata | null {
    const current = latestCliSnapshot(this.snapshots.values(), sessionId)
    if (!current) return null
    return {
      status: sessionStatusFromSnapshot(current),
      hasRunningShell: stringField(current.payload, 'status') === 'shell',
      kind: stringField(current.payload, 'kind'),
      entrypoint: 'cli',
    }
  }

  listObservations(input: { sessionId?: string | null; sort: SessionObservationSort; direction: 'asc' | 'desc'; limit: number; offset: number }): SessionObservationsResponse {
    const column = SORT_COLUMNS[input.sort]
    const direction = input.direction.toUpperCase()
    const where = input.sessionId === undefined ? '' : input.sessionId === null ? 'WHERE session_id IS NULL' : 'WHERE session_id = ?'
    const params = typeof input.sessionId === 'string' ? [input.sessionId, input.limit + 1, input.offset] : [input.limit + 1, input.offset]
    const rows = this.db.prepare(`
      SELECT * FROM session_registry_observations
      ${where}
      ORDER BY ${column} ${direction}, id ${direction}
      LIMIT ? OFFSET ?
    `).all(...params) as Array<Record<string, unknown>>
    const sessionIds = (this.db.prepare(`
      SELECT DISTINCT session_id FROM session_registry_observations
      ORDER BY session_id IS NULL, session_id ASC
    `).all() as Array<{ session_id: string | null }>).map((row) => row.session_id)
    return {
      observations: rows.slice(0, input.limit).map(toObservation),
      sessionIds,
      limit: input.limit,
      offset: input.offset,
      hasMore: rows.length > input.limit,
      sort: input.sort,
      direction: input.direction,
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

    this.db.exec('BEGIN')
    try {
      await this.appendMany('create', created)
      await this.appendMany('change', changed)
      await this.appendMany('delete', deleted)
      this.db.exec('COMMIT')
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
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private async readSnapshots(): Promise<Map<string, Snapshot>> {
    const entries = await readdir(this.sessionsDir, { withFileTypes: true })
    const next = new Map<string, Snapshot>()
    await Promise.all(entries.filter((entry) => entry.isFile() && SESSION_FILE.test(entry.name)).map(async (entry) => {
      const filePath = join(this.sessionsDir, entry.name)
      try {
        const [rawJson, metadata] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)])
        let payload: Record<string, unknown> | null = null
        let parseError: string | null = null
        try {
          const parsed: unknown = JSON.parse(rawJson)
          if (isRecord(parsed)) payload = parsed
          else parseError = 'Root JSON value is not an object'
        } catch (error) {
          parseError = error instanceof Error ? error.message : String(error)
          payload = this.snapshots.get(entry.name)?.payload ?? null
        }
        next.set(entry.name, {
          fileName: entry.name,
          filePath,
          filePid: Number(entry.name.match(SESSION_FILE)?.[1]),
          fileMtimeMs: metadata.mtimeMs,
          fileSizeBytes: metadata.size,
          rawJson,
          payload,
          parseError,
        })
      } catch (error) {
        const code = isRecord(error) && typeof error.code === 'string' ? error.code : null
        if (code !== 'ENOENT') {
          console.error(`claude-session-registry:read failed ${filePath}`, error)
          const previous = this.snapshots.get(entry.name)
          if (previous) next.set(entry.name, previous)
        }
      }
    }))
    return next
  }

  private async appendBatch(kind: EventKind, snapshots: Snapshot[]): Promise<void> {
    this.db.exec('BEGIN')
    try {
      await this.appendMany(kind, snapshots)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private async appendMany(kind: EventKind, snapshots: Snapshot[]): Promise<void> {
    const observedAt = Date.now()
    for (const snapshot of snapshots) await this.append(kind, snapshot, observedAt)
  }

  private async append(kind: EventKind, snapshot: Snapshot, observedAt: number): Promise<void> {
    const payload = snapshot.payload
    const payloadPid = integerField(payload, 'pid')
    const procStart = stringField(payload, 'procStart')
    this.insertStatement.run(
      kind,
      observedAt,
      snapshot.fileName,
      snapshot.filePath,
      snapshot.filePid,
      snapshot.fileMtimeMs,
      snapshot.fileSizeBytes,
      snapshot.rawJson,
      snapshot.parseError,
      payloadPid,
      procStart,
      stringField(payload, 'sessionId'),
      stringField(payload, 'cwd'),
      saneEpochField(payload, 'startedAt'),
      saneEpochField(payload, 'updatedAt'),
      saneEpochField(payload, 'statusUpdatedAt'),
      stringField(payload, 'version'),
      integerField(payload, 'peerProtocol'),
      stringField(payload, 'kind'),
      stringField(payload, 'entrypoint'),
      stringField(payload, 'name'),
      stringField(payload, 'nameSource'),
      stringField(payload, 'status'),
      stringField(payload, 'waitingFor'),
      stringField(payload, 'tempo'),
      stringField(payload, 'state'),
      stringField(payload, 'detail'),
      stringField(payload, 'needs'),
      stringField(payload, 'agent'),
      stringField(payload, 'messagingSocketPath'),
      stringField(payload, 'jobId'),
      stringField(payload, 'parkedJobId'),
      stringField(payload, 'bridgeSessionId'),
      stringField(payload, 'logPath'),
      stringField(payload, 'tmux'),
      processAlive(payloadPid ?? snapshot.filePid),
      await linuxProcessStartMatches(payloadPid ?? snapshot.filePid, procStart),
    )
  }

  private migrate(): void {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_registry_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_kind TEXT NOT NULL CHECK (event_kind IN ('snapshot', 'create', 'change', 'delete')),
        observed_at_ms INTEGER NOT NULL,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_pid INTEGER,
        file_mtime_ms INTEGER,
        file_size_bytes INTEGER,
        raw_json TEXT NOT NULL,
        parse_error TEXT,
        payload_pid INTEGER,
        proc_start TEXT,
        session_id TEXT,
        cwd TEXT,
        started_at_ms INTEGER,
        updated_at_ms INTEGER,
        status_updated_at_ms INTEGER,
        version TEXT,
        peer_protocol INTEGER,
        kind TEXT,
        entrypoint TEXT,
        name TEXT,
        name_source TEXT,
        status TEXT,
        waiting_for TEXT,
        tempo TEXT,
        state TEXT,
        detail TEXT,
        needs TEXT,
        agent TEXT,
        messaging_socket_path TEXT,
        job_id TEXT,
        parked_job_id TEXT,
        bridge_session_id TEXT,
        log_path TEXT,
        tmux TEXT,
        pid_alive INTEGER,
        proc_start_matches INTEGER
      );
      CREATE INDEX IF NOT EXISTS session_registry_observations_by_session ON session_registry_observations(session_id, observed_at_ms, id);
      CREATE INDEX IF NOT EXISTS session_registry_observations_by_file_pid ON session_registry_observations(file_pid, observed_at_ms, id);
      CREATE INDEX IF NOT EXISTS session_registry_observations_by_status ON session_registry_observations(kind, status, tempo, observed_at_ms, id);
    `)
    if (version < 1) {
      this.db.exec(`
        DELETE FROM session_registry_observations
        WHERE id NOT IN (
          SELECT MIN(id)
          FROM session_registry_observations
          GROUP BY file_name, raw_json
        );
        PRAGMA user_version = 1;
      `)
    }
  }
}

export async function createClaudeSessionRegistry(options?: ClaudeSessionRegistryOptions): Promise<ClaudeSessionRegistry> {
  const observer = new ClaudeSessionRegistry(options)
  await observer.start()
  return observer
}
