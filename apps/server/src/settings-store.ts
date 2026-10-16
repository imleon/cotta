import type { DatabaseSync } from 'node:sqlite'
import type { AuthUser } from '@cotta/shared'

export type AuthSession = {
  user: AuthUser
  expiresAt: number
}

export interface SettingsStore {
  getAll(scope?: string): Record<string, unknown>
  setMany(scope: string, settings: Record<string, unknown>, options?: { clearAuthSessions?: boolean }): void
  getAuthSession(sessionId: string): AuthSession | null
  setAuthSession(sessionId: string, session: AuthSession): void
  deleteAuthSession(sessionId: string): void
}

const GLOBAL_SCOPE = 'global'

export class SqliteSettingsStore implements SettingsStore {
  private readonly getAllStatement
  private readonly setStatement
  private readonly deleteStatement
  private readonly getAuthSessionStatement
  private readonly setAuthSessionStatement
  private readonly deleteAuthSessionStatement

  constructor(private readonly db: DatabaseSync) {
    this.getAllStatement = this.db.prepare('SELECT key, value_json FROM settings WHERE scope = ?')
    this.setStatement = this.db.prepare(`
      INSERT INTO settings (scope, key, value_json, updated_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(scope, key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at_ms = excluded.updated_at_ms
    `)
    this.deleteStatement = this.db.prepare('DELETE FROM settings WHERE scope = ? AND key = ?')
    this.getAuthSessionStatement = this.db.prepare('SELECT login, name, avatar_url, expires_at_ms FROM auth_sessions WHERE session_id = ?')
    this.setAuthSessionStatement = this.db.prepare(`
      INSERT INTO auth_sessions (session_id, login, name, avatar_url, expires_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        login = excluded.login,
        name = excluded.name,
        avatar_url = excluded.avatar_url,
        expires_at_ms = excluded.expires_at_ms,
        updated_at_ms = excluded.updated_at_ms
    `)
    this.deleteAuthSessionStatement = this.db.prepare('DELETE FROM auth_sessions WHERE session_id = ?')
  }

  getAll(scope = GLOBAL_SCOPE): Record<string, unknown> {
    const rows = this.getAllStatement.all(scope) as Array<{ key: string; value_json: string }>
    return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value_json)]))
  }

  setMany(scope: string, settings: Record<string, unknown>, options: { clearAuthSessions?: boolean } = {}): void {
    const entries = Object.entries(settings)
    if (entries.length === 0 && !options.clearAuthSessions) return
    const updatedAt = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const [key, value] of entries) {
        if (value === undefined) this.deleteStatement.run(scope, key)
        else this.setStatement.run(scope, key, JSON.stringify(value), updatedAt)
      }
      if (options.clearAuthSessions) this.db.exec('DELETE FROM auth_sessions')
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getAuthSession(sessionId: string): AuthSession | null {
    const row = this.getAuthSessionStatement.get(sessionId) as { login: string; name: string | null; avatar_url: string | null; expires_at_ms: number } | undefined
    return row ? { user: { login: row.login, name: row.name, avatarUrl: row.avatar_url }, expiresAt: row.expires_at_ms } : null
  }

  setAuthSession(sessionId: string, session: AuthSession): void {
    this.setAuthSessionStatement.run(sessionId, session.user.login, session.user.name, session.user.avatarUrl, session.expiresAt, Date.now())
  }

  deleteAuthSession(sessionId: string): void {
    this.deleteAuthSessionStatement.run(sessionId)
  }
}
