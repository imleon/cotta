import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'

const LATEST_SCHEMA_VERSION = 2

type Migration = {
  version: number
  apply: (db: Database.Database) => void
}

function hasTable(db: Database.Database, tableName: string): boolean {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName) as { name?: string } | undefined
  return row?.name === tableName
}

function ensureSchemaVersionTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );
  `)
}

function hasUserTables(db: Database.Database): boolean {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name != 'schema_version'
    LIMIT 1
  `).get() as { name?: string } | undefined
  return typeof row?.name === 'string'
}

function getSchemaVersion(db: Database.Database): number {
  const schemaVersionTableExists = hasTable(db, 'schema_version')
  if (!schemaVersionTableExists) {
    if (hasUserTables(db)) {
      throw new Error('Unsupported SQLite schema: schema_version table is required for non-empty databases')
    }
    ensureSchemaVersionTable(db)
  }
  const rows = db.prepare('SELECT version FROM schema_version').all() as Array<{ version?: number }>
  if (rows.length > 1) {
    throw new Error('Invalid SQLite schema: schema_version must contain exactly one row')
  }

  if (rows.length === 1) {
    const version = rows[0]?.version
    if (!Number.isInteger(version) || (version as number) < 0) {
      throw new Error(`Invalid SQLite schema_version value: ${String(version)}`)
    }
    return version as number
  }

  if (hasUserTables(db)) {
    throw new Error('Invalid SQLite schema: schema_version must contain exactly one row')
  }

  db.prepare('INSERT INTO schema_version (version) VALUES (0)').run()
  return 0
}

function setSchemaVersion(db: Database.Database, version: number): void {
  db.prepare('DELETE FROM schema_version').run()
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version)
}

const migrations: Migration[] = [
  {
    version: 1,
    apply: (db) => {
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
    },
  },
  {
    version: 2,
    apply: (db) => {
      db.exec(`
        ALTER TABLE channels ADD COLUMN current_sdk_session_id TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_current_sdk_session_id_unique
        ON channels(current_sdk_session_id)
        WHERE current_sdk_session_id IS NOT NULL;
      `)
    },
  },
]

function applyMigrations(db: Database.Database): void {
  let currentVersion = getSchemaVersion(db)
  if (currentVersion > LATEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported SQLite schema version ${currentVersion}; runtime supports up to ${LATEST_SCHEMA_VERSION}`)
  }

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue
    const runMigration = db.transaction(() => {
      migration.apply(db)
      setSchemaVersion(db, migration.version)
    })
    runMigration()
    currentVersion = migration.version
  }
}

export function createSqliteDatabase(dbPath: string): Database.Database {
  const resolvedPath = resolve(dbPath)
  mkdirSync(dirname(resolvedPath), { recursive: true })

  const db = new Database(resolvedPath)
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  applyMigrations(db)

  return db
}
