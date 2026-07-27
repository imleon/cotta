import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { DatabaseSync } from 'node:sqlite'
import type { AuthUser, EffortLevel, ModelSelection, PermissionMode } from '@cotta/shared'

export type SessionSettings = {
  permissionMode: PermissionMode
  model: ModelSelection | null
  effort: EffortLevel | null
}

export type AuthSession = {
  user: AuthUser
  expiresAt: number
}

export interface SettingsStore {
  getAll(scope?: string): Record<string, unknown>
  setMany(scope: string, settings: Record<string, unknown>): void
  getSessionSettings(projectId: string, sessionId: string): SessionSettings | null
  setSessionSettings(projectId: string, sessionId: string, settings: SessionSettings): void
  getAuthSession(sessionId: string): AuthSession | null
  setAuthSession(sessionId: string, session: AuthSession): void
  deleteAuthSession(sessionId: string): void
}

const SCHEMA_VERSION = 3
const GLOBAL_SCOPE = 'global'

function settingsDbPath(): string {
  return resolve(process.cwd(), process.env.COTTA_SETTINGS_DB_PATH ?? 'data/cotta-settings.sqlite')
}

export class SqliteSettingsStore implements SettingsStore {
  private readonly db: DatabaseSync
  private readonly getAllStatement
  private readonly setStatement
  private readonly getSessionSettingsStatement
  private readonly setSessionSettingsStatement
  private readonly getAuthSessionStatement
  private readonly setAuthSessionStatement
  private readonly deleteAuthSessionStatement

  constructor(dbPath = settingsDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.migrate()
    this.getAllStatement = this.db.prepare('SELECT key, value_json FROM settings WHERE scope = ?')
    this.setStatement = this.db.prepare(`
      INSERT INTO settings (scope, key, value_json, updated_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(scope, key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at_ms = excluded.updated_at_ms
    `)
    this.getSessionSettingsStatement = this.db.prepare('SELECT permission_mode, model, effort FROM session_settings WHERE project_id = ? AND session_id = ?')
    this.setSessionSettingsStatement = this.db.prepare(`
      INSERT INTO session_settings (project_id, session_id, permission_mode, model, effort, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, session_id) DO UPDATE SET
        permission_mode = excluded.permission_mode,
        model = excluded.model,
        effort = excluded.effort,
        updated_at_ms = excluded.updated_at_ms
    `)
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

  setMany(scope: string, settings: Record<string, unknown>): void {
    const updatedAt = Date.now()
    for (const [key, value] of Object.entries(settings)) {
      this.setStatement.run(scope, key, JSON.stringify(value), updatedAt)
    }
  }

  getSessionSettings(projectId: string, sessionId: string): SessionSettings | null {
    const row = this.getSessionSettingsStatement.get(projectId, sessionId) as { permission_mode: PermissionMode; model: ModelSelection | null; effort: EffortLevel | null } | undefined
    return row ? { permissionMode: row.permission_mode, model: row.model, effort: row.effort } : null
  }

  setSessionSettings(projectId: string, sessionId: string, settings: SessionSettings): void {
    this.setSessionSettingsStatement.run(projectId, sessionId, settings.permissionMode, settings.model, settings.effort, Date.now())
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

  private migrate(): void {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE IF NOT EXISTS session_settings (
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (project_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        session_id TEXT PRIMARY KEY,
        login TEXT NOT NULL,
        name TEXT,
        avatar_url TEXT,
        expires_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `)
    if (version < SCHEMA_VERSION) this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
  }
}

export function createSettingsStore(dbPath?: string): SettingsStore {
  return new SqliteSettingsStore(dbPath)
}
