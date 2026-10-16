import type { DatabaseSync } from 'node:sqlite'

export type StoredSessionPin = {
  projectId: string
  sessionId: string
  pinnedAtMs: number
}

type SessionIdentity = Pick<StoredSessionPin, 'projectId' | 'sessionId'>

export class SessionPinStore {
  constructor(private readonly db: DatabaseSync) {}

  listPins(): StoredSessionPin[] {
    return (
      this.db
        .prepare(`
      SELECT COALESCE(session_index.current_project_id, '') AS project_id,
        session_pins.session_id,
        session_pins.pinned_at_ms
      FROM session_pins
      LEFT JOIN session_index ON session_index.session_id = session_pins.session_id
      ORDER BY session_pins.pinned_at_ms DESC, session_pins.session_id
    `)
        .all() as Array<{ project_id: string; session_id: string; pinned_at_ms: number }>
    ).map((row) => ({
      projectId: row.project_id,
      sessionId: row.session_id,
      pinnedAtMs: row.pinned_at_ms,
    }))
  }

  pin(_projectId: string, sessionId: string, pinnedAtMs = Date.now()): void {
    this.db
      .prepare(`
      INSERT INTO session_pins (session_id, pinned_at_ms)
      VALUES (?, ?)
      ON CONFLICT(session_id) DO UPDATE SET pinned_at_ms = excluded.pinned_at_ms
    `)
      .run(sessionId, pinnedAtMs)
  }

  unpin(_projectId: string, sessionId: string): void {
    this.db.prepare('DELETE FROM session_pins WHERE session_id = ?').run(sessionId)
  }

  unpinMany(identities: readonly SessionIdentity[]): void {
    if (identities.length === 0) return
    const statement = this.db.prepare('DELETE FROM session_pins WHERE session_id = ?')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const identity of identities) statement.run(identity.sessionId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
