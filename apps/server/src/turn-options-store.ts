import type { DatabaseSync } from 'node:sqlite'
import type { EffortLevel, ModelSelection, PermissionMode, TurnOptionsUpdateRequest } from '@cotta/shared'

export type StoredTurnOptions = {
  permissionMode: PermissionMode | null
  model: ModelSelection | null
  effort: EffortLevel | null
}

export class TurnOptionsStore {
  constructor(private readonly db: DatabaseSync) {}

  getSessionTurnOptions(sessionId: string): StoredTurnOptions | null {
    const row = this.db
      .prepare(`
      SELECT permission_mode, model, effort
      FROM session_index
      WHERE session_id = ?
    `)
      .get(sessionId) as { permission_mode: PermissionMode | null; model: ModelSelection | null; effort: EffortLevel | null } | undefined
    return row ? { permissionMode: row.permission_mode, model: row.model, effort: row.effort } : null
  }

  setSessionTurnOptions(sessionId: string, options: TurnOptionsUpdateRequest, observedAtMs = Date.now()): boolean {
    const now = Date.now()
    const hasPermission = options.permissionMode !== undefined
    const hasModelEffort = options.model !== undefined
    const result = this.db
      .prepare(`
      INSERT INTO session_index (session_id, permission_mode, model, effort, turn_options_observed_at_ms, is_valid_session_id, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        permission_mode = CASE WHEN ? THEN excluded.permission_mode ELSE session_index.permission_mode END,
        model = CASE WHEN ? THEN excluded.model ELSE session_index.model END,
        effort = CASE WHEN ? THEN excluded.effort ELSE session_index.effort END,
        turn_options_observed_at_ms = excluded.turn_options_observed_at_ms,
        updated_at_ms = excluded.updated_at_ms
      WHERE excluded.turn_options_observed_at_ms >= COALESCE(session_index.turn_options_observed_at_ms, -1)
    `)
      .run(sessionId, options.permissionMode ?? null, options.model ?? null, options.effort ?? null, observedAtMs, now, hasPermission ? 1 : 0, hasModelEffort ? 1 : 0, hasModelEffort ? 1 : 0)
    return result.changes > 0
  }

  timelineVersion(_projectId: string, sessionId: string): string {
    const row = this.db
      .prepare(`
      SELECT turn_options_observed_at_ms, permission_mode, model, effort FROM session_index WHERE session_id = ?
    `)
      .get(sessionId) as { turn_options_observed_at_ms: number | null; permission_mode: PermissionMode | null; model: ModelSelection | null; effort: EffortLevel | null } | undefined
    return `turn-options=${row?.turn_options_observed_at_ms ?? 0}:${row?.permission_mode ?? ''}:${row?.model ?? ''}:${row?.effort ?? ''}`
  }
}
