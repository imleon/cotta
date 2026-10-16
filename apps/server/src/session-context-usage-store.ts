import type { DatabaseSync } from 'node:sqlite'
import { type SessionContextUsage, sessionContextUsageSchema } from '@cotta/shared'

export class SessionContextUsageStore {
  constructor(private readonly db: DatabaseSync) {}

  getContextUsage(sessionId: string): SessionContextUsage | null {
    const row = this.db
      .prepare(`
      SELECT context_usage_json, context_usage_updated_at_ms FROM session_index
      WHERE session_id = ? AND context_usage_json IS NOT NULL AND context_usage_updated_at_ms IS NOT NULL
    `)
      .get(sessionId) as { context_usage_json: string; context_usage_updated_at_ms: number } | undefined
    if (!row) return null
    const usage = sessionContextUsageSchema.safeParse({ ...JSON.parse(row.context_usage_json), updatedAtMs: row.context_usage_updated_at_ms })
    return usage.success ? usage.data : null
  }

  setContextUsage(sessionId: string, usage: SessionContextUsage, updatedAtMs = Date.now()): void {
    this.db
      .prepare(`
      INSERT INTO session_index (session_id, context_usage_json, context_usage_updated_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        context_usage_json = excluded.context_usage_json,
        context_usage_updated_at_ms = excluded.context_usage_updated_at_ms
      WHERE excluded.context_usage_updated_at_ms >= COALESCE(session_index.context_usage_updated_at_ms, -1)
    `)
      .run(sessionId, JSON.stringify(usage), updatedAtMs, updatedAtMs)
  }
}
