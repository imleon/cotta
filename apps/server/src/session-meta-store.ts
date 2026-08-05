import type { DatabaseSync } from 'node:sqlite'
import type { EffortLevel, ModelSelection, PermissionMode } from '@cotta/shared'

export type SessionMeta = {
  permissionMode: PermissionMode | null
  model: ModelSelection | null
  effort: EffortLevel | null
}

export class SessionMetaStore {
  constructor(private readonly db: DatabaseSync) {}

  getSessionMeta(projectId: string, sessionId: string): SessionMeta | null {
    const row = this.db.prepare(`
      SELECT permission_mode, model, effort
      FROM session_meta
      WHERE project_id = ? AND session_id = ?
    `).get(projectId, sessionId) as { permission_mode: PermissionMode | null; model: ModelSelection | null; effort: EffortLevel | null } | undefined
    return row ? { permissionMode: row.permission_mode, model: row.model, effort: row.effort } : null
  }

  setSessionMeta(projectId: string, sessionId: string, meta: SessionMeta, observedAtMs = Date.now()): void {
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO session_meta (project_id, session_id, permission_mode, model, effort, observed_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, session_id) DO UPDATE SET
        permission_mode = excluded.permission_mode,
        model = excluded.model,
        effort = excluded.effort,
        observed_at_ms = excluded.observed_at_ms,
        updated_at_ms = excluded.updated_at_ms
      WHERE excluded.observed_at_ms >= session_meta.observed_at_ms
    `).run(projectId, sessionId, meta.permissionMode, meta.model, meta.effort, observedAtMs, now)
  }

  timelineVersion(projectId: string, sessionId: string): string {
    const row = this.db.prepare(`
      SELECT updated_at_ms FROM session_meta WHERE project_id = ? AND session_id = ?
    `).get(projectId, sessionId) as { updated_at_ms: number } | undefined
    return `session-meta=${row?.updated_at_ms ?? 0}`
  }
}
