import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type PersistedLiveEventRecord = {
  id: number
  projectId: string
  sessionId: string
  eventType: string
  source: string
  recordedAtMs: number
  payload: unknown
}

type PersistedLiveEventInsert = Omit<PersistedLiveEventRecord, 'id'>

export interface LiveEventStore {
  append(projectId: string, sessionId: string, message: unknown): void
  listSessionEvents(projectId: string, sessionId: string, limit: number): PersistedLiveEventRecord[]
}

const SCHEMA_VERSION = 2

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function liveEventsDbPath(): string {
  return resolve(process.cwd(), process.env.COTTA_LIVE_EVENTS_DB_PATH ?? 'data/cotta-live-events.sqlite')
}

function sdkMessageType(message: unknown): string {
  return isRecord(message) && typeof message.type === 'string' ? message.type : 'unknown'
}

function shouldSkipPersistedMessage(message: unknown): boolean {
  if (!isRecord(message)) return false
  if (message.type === 'system' && message.subtype === 'thinking_tokens') return true
  return message.type === 'stream_event'
    && isRecord(message.event)
    && message.event.type === 'content_block_delta'
}

function toPersistedLiveEvent(projectId: string, sessionId: string, message: unknown): PersistedLiveEventInsert {
  return {
    projectId,
    sessionId,
    eventType: sdkMessageType(message),
    source: 'sdk',
    recordedAtMs: Date.now(),
    payload: message,
  }
}

function parsePayload(payloadJson: string): unknown {
  return JSON.parse(payloadJson)
}

export class SqliteLiveEventStore implements LiveEventStore {
  private readonly db: DatabaseSync
  private readonly insertStatement
  private readonly listBySessionStatement

  constructor(dbPath = liveEventsDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.migrate()
    this.insertStatement = this.db.prepare(`
      INSERT INTO live_session_events (
        project_id,
        session_id,
        event_type,
        source,
        recorded_at_ms,
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    this.listBySessionStatement = this.db.prepare(`
      SELECT
        id,
        project_id,
        session_id,
        event_type,
        source,
        recorded_at_ms,
        payload_json
      FROM (
        SELECT *
        FROM live_session_events
        WHERE project_id = ? AND session_id = ?
        ORDER BY id DESC
        LIMIT ?
      )
      ORDER BY id ASC
    `)
  }

  append(projectId: string, sessionId: string, message: unknown): void {
    if (shouldSkipPersistedMessage(message)) return
    const record = toPersistedLiveEvent(projectId, sessionId, message)
    this.insertStatement.run(
      record.projectId,
      record.sessionId,
      record.eventType,
      record.source,
      record.recordedAtMs,
      JSON.stringify(record.payload),
    )
  }

  listSessionEvents(projectId: string, sessionId: string, limit: number): PersistedLiveEventRecord[] {
    const rows = this.listBySessionStatement.all(projectId, sessionId, Math.max(1, Math.min(1000, Math.trunc(limit)))) as Array<{
      id: number
      project_id: string
      session_id: string
      event_type: string
      source: string
      recorded_at_ms: number
      payload_json: string
    }>
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      sessionId: row.session_id,
      eventType: row.event_type,
      source: row.source,
      recordedAtMs: row.recorded_at_ms,
      payload: parsePayload(row.payload_json),
    }))
  }

  private migrate(): void {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0)
    if (version >= SCHEMA_VERSION) return
    this.db.exec(`
      DROP TABLE IF EXISTS live_session_events;
      CREATE TABLE live_session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        recorded_at_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX live_session_events_by_session ON live_session_events(project_id, session_id, id);
      CREATE INDEX live_session_events_by_event_type ON live_session_events(event_type, id);
      PRAGMA user_version = ${SCHEMA_VERSION};
    `)
  }
}

export function createLiveEventStore(dbPath?: string): LiveEventStore {
  return new SqliteLiveEventStore(dbPath)
}
