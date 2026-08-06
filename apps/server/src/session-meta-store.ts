import type { DatabaseSync } from 'node:sqlite'
import type { EffortLevel, ModelSelection, PermissionMode, SessionMetaUpdateRequest } from '@cotta/shared'

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

  setSessionMeta(projectId: string, sessionId: string, meta: SessionMetaUpdateRequest, observedAtMs = Date.now()): void {
    const now = Date.now()
    const hasPermission = meta.permissionMode !== undefined
    const hasModelEffort = meta.model !== undefined
    this.db.prepare(`
      INSERT INTO session_meta (project_id, session_id, permission_mode, model, effort, observed_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, session_id) DO UPDATE SET
        permission_mode = CASE WHEN ? THEN excluded.permission_mode ELSE session_meta.permission_mode END,
        model = CASE WHEN ? THEN excluded.model ELSE session_meta.model END,
        effort = CASE WHEN ? THEN excluded.effort ELSE session_meta.effort END,
        observed_at_ms = excluded.observed_at_ms,
        updated_at_ms = excluded.updated_at_ms
      WHERE excluded.observed_at_ms >= session_meta.observed_at_ms
    `).run(
      projectId,
      sessionId,
      meta.permissionMode ?? null,
      meta.model ?? null,
      meta.effort ?? null,
      observedAtMs,
      now,
      hasPermission ? 1 : 0,
      hasModelEffort ? 1 : 0,
      hasModelEffort ? 1 : 0,
    )
  }

  timelineVersion(projectId: string, sessionId: string): string {
    const row = this.db.prepare(`
      SELECT updated_at_ms FROM session_meta WHERE project_id = ? AND session_id = ?
    `).get(projectId, sessionId) as { updated_at_ms: number } | undefined
    return `session-meta=${row?.updated_at_ms ?? 0}`
  }
}
