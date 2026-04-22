import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'

export function createSqliteDatabase(dbPath: string): Database.Database {
  const resolvedPath = resolve(dbPath)
  mkdirSync(dirname(resolvedPath), { recursive: true })

  const db = new Database(resolvedPath)
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')

  db.exec(`
    CREATE TABLE IF NOT EXISTS connectors (
      connector_id TEXT PRIMARY KEY,
      connector_type TEXT NOT NULL,
      connector_config_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY,
      agent_name TEXT,
      project_dir TEXT NOT NULL,
      model_json TEXT NOT NULL,
      permission_mode TEXT,
      allow_tools_json TEXT,
      allow_skills_json TEXT,
      mcp_servers_json TEXT,
      env_json TEXT,
      prompt_config_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channels (
      channel_id TEXT PRIMARY KEY,
      channel_key TEXT NOT NULL,
      channel_name TEXT,
      connector_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      current_sdk_session_id TEXT,
      enabled INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (connector_id) REFERENCES connectors(connector_id) ON DELETE RESTRICT,
      FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
      UNIQUE (connector_id, channel_key)
    );

    CREATE INDEX IF NOT EXISTS idx_channels_agent_id ON channels(agent_id);
    CREATE INDEX IF NOT EXISTS idx_channels_connector_id ON channels(connector_id);
  `)

  // Lightweight migration for older DB files.
  try {
    db.exec('ALTER TABLE channels ADD COLUMN current_sdk_session_id TEXT;')
  } catch {
    // Column already exists.
  }

  // Enforce global uniqueness when set (NULL is allowed for "auto-allocate").
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_current_sdk_session_id_unique
    ON channels(current_sdk_session_id)
    WHERE current_sdk_session_id IS NOT NULL;
  `)

  return db
}
