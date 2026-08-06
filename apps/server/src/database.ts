import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA_VERSION = 8

function databasePath(): string {
  return resolve(process.cwd(), process.env.COTTA_DB_PATH ?? 'data/cotta.sqlite')
}

function legacySettingsDatabasePath(): string {
  return resolve(process.cwd(), process.env.COTTA_SETTINGS_DB_PATH ?? 'data/cotta-settings.sqlite')
}

export function createCottaDatabase(dbPath = databasePath(), legacySettingsDbPath = legacySettingsDatabasePath()): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `)
  migrate(db, resolve(dbPath), resolve(legacySettingsDbPath))
  return db
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name))
}

function createSessionMetaTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_meta (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      permission_mode TEXT,
      model TEXT,
      effort TEXT,
      observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
      PRIMARY KEY (project_id, session_id)
    );
  `)
}

function createSettingsTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (scope, key)
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
}

function ensureSessionMetaAllowsPartialObservations(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(session_meta)').all() as Array<{ name: string; notnull: number }>
  if (columns.length === 0 || columns.find((column) => column.name === 'permission_mode')?.notnull !== 1) return
  db.exec(`
    CREATE TABLE session_meta_next (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      permission_mode TEXT,
      model TEXT,
      effort TEXT,
      observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
      PRIMARY KEY (project_id, session_id)
    );
    INSERT INTO session_meta_next (project_id, session_id, permission_mode, model, effort, observed_at_ms, updated_at_ms)
      SELECT project_id, session_id, permission_mode, model, effort, observed_at_ms, updated_at_ms FROM session_meta;
    DROP TABLE session_meta;
    ALTER TABLE session_meta_next RENAME TO session_meta;
  `)
}

function attachedTableExists(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT 1 FROM legacy_settings.sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined
}

function importLegacySettingsDatabase(db: DatabaseSync): void {
  if (attachedTableExists(db, 'settings')) {
    db.exec(`
      INSERT OR IGNORE INTO settings (scope, key, value_json, updated_at_ms)
        SELECT scope, key, value_json, updated_at_ms FROM legacy_settings.settings;
    `)
  }
  if (attachedTableExists(db, 'auth_sessions')) {
    db.exec(`
      INSERT OR IGNORE INTO auth_sessions (session_id, login, name, avatar_url, expires_at_ms, updated_at_ms)
        SELECT session_id, login, name, avatar_url, expires_at_ms, updated_at_ms FROM legacy_settings.auth_sessions;
    `)
  }
}

function removeLegacySettingsDatabase(legacySettingsDbPath: string): void {
  rmSync(legacySettingsDbPath, { force: true })
  rmSync(`${legacySettingsDbPath}-wal`, { force: true })
  rmSync(`${legacySettingsDbPath}-shm`, { force: true })
}

function migrateSettingsSchema(db: DatabaseSync, dbPath: string, legacySettingsDbPath: string): void {
  const importLegacy = dbPath !== legacySettingsDbPath && existsSync(legacySettingsDbPath)
  if (importLegacy) db.prepare('ATTACH DATABASE ? AS legacy_settings').run(legacySettingsDbPath)
  try {
    db.exec('BEGIN')
    try {
      createSettingsTables(db)
      if (importLegacy) importLegacySettingsDatabase(db)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    if (importLegacy) db.exec('DETACH DATABASE legacy_settings')
  }
  if (importLegacy) removeLegacySettingsDatabase(legacySettingsDbPath)
}

function migrate(db: DatabaseSync, dbPath: string, legacySettingsDbPath: string): void {
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0)
  if (version >= SCHEMA_VERSION) {
    ensureSessionMetaAllowsPartialObservations(db)
    createSettingsTables(db)
    return
  }
  if (version === 1) {
    db.exec(`
      ALTER TABLE turn_meta_transcript ADD COLUMN scan_line_no INTEGER NOT NULL DEFAULT 0 CHECK (scan_line_no >= 0);
      PRAGMA user_version = 2;
    `)
  }
  if (version === 1 || version === 2) {
    db.exec(`
      UPDATE turn_meta_transcript
      SET scan_byte_offset = 0, scan_line_no = 0
      WHERE transcript_path IN (
        SELECT transcript_path FROM turn_meta_transcript
        WHERE primary_entrypoint = 'cli' AND duration_uuid IS NULL
      );
      PRAGMA user_version = 3;
    `)
  }
  if (version <= 3 && version > 0) {
    const columns = tableColumns(db, 'turn_meta_transcript')
    if (!columns.has('permission_mode')) db.exec('ALTER TABLE turn_meta_transcript ADD COLUMN permission_mode TEXT;')
    if (!columns.has('model')) db.exec('ALTER TABLE turn_meta_transcript ADD COLUMN model TEXT;')
    if (!columns.has('effort')) db.exec('ALTER TABLE turn_meta_transcript ADD COLUMN effort TEXT;')
    db.exec('PRAGMA user_version = 4;')
  }
  if (version <= 5 && version > 0) {
    const columns = tableColumns(db, 'turn_meta_transcript')
    if (!columns.has('away_summary')) db.exec('ALTER TABLE turn_meta_transcript ADD COLUMN away_summary TEXT;')
    createSessionMetaTable(db)
    db.exec('PRAGMA user_version = 7;')
  } else if (version === 6) {
    createSessionMetaTable(db)
    db.exec('PRAGMA user_version = 7;')
  } else if (version === 0) {
    db.exec(`
      CREATE TABLE turn_meta_transcript (
        id INTEGER PRIMARY KEY,

        project_key TEXT NOT NULL,
        transcript_path TEXT NOT NULL,
        session_id TEXT NOT NULL,
        primary_user_uuid TEXT NOT NULL,

        primary_timestamp_ms INTEGER NOT NULL,
        primary_byte_offset INTEGER NOT NULL CHECK (primary_byte_offset >= 0),
        primary_entrypoint TEXT,

        permission_mode TEXT,
        model TEXT,
        effort TEXT,
        away_summary TEXT,

        duration_uuid TEXT,
        duration_parent_uuid TEXT,
        duration_timestamp_ms INTEGER,
        duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
        duration_message_count INTEGER CHECK (duration_message_count IS NULL OR duration_message_count >= 0),
        duration_line_no INTEGER CHECK (duration_line_no IS NULL OR duration_line_no >= 1),
        duration_byte_offset INTEGER CHECK (duration_byte_offset IS NULL OR duration_byte_offset >= 0),
        duration_byte_length INTEGER CHECK (duration_byte_length IS NULL OR duration_byte_length > 0),

        duration_is_sidechain INTEGER CHECK (duration_is_sidechain IS NULL OR duration_is_sidechain IN (0, 1)),
        duration_is_meta INTEGER CHECK (duration_is_meta IS NULL OR duration_is_meta IN (0, 1)),
        duration_user_type TEXT,
        duration_entrypoint TEXT,
        duration_cwd TEXT,
        duration_version TEXT,
        duration_git_branch TEXT,
        duration_slug TEXT,
        duration_pending_background_agent_count INTEGER CHECK (duration_pending_background_agent_count IS NULL OR duration_pending_background_agent_count >= 0),
        duration_session_kind TEXT,
        duration_forked_from_json TEXT CHECK (duration_forked_from_json IS NULL OR json_valid(duration_forked_from_json)),
        duration_pending_workflow_count INTEGER CHECK (duration_pending_workflow_count IS NULL OR duration_pending_workflow_count >= 0),
        duration_payload_json TEXT CHECK (duration_payload_json IS NULL OR json_valid(duration_payload_json)),

        file_mtime_ms INTEGER NOT NULL CHECK (file_mtime_ms >= 0),
        file_size INTEGER NOT NULL CHECK (file_size >= 0),
        scan_byte_offset INTEGER NOT NULL CHECK (scan_byte_offset >= 0),
        scan_line_no INTEGER NOT NULL DEFAULT 0 CHECK (scan_line_no >= 0),

        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),

        UNIQUE (transcript_path, primary_user_uuid)
      );

      CREATE INDEX turn_meta_transcript_by_session_time
        ON turn_meta_transcript(project_key, session_id, primary_timestamp_ms);

      CREATE INDEX turn_meta_transcript_by_path_offset
        ON turn_meta_transcript(transcript_path, scan_byte_offset);

      CREATE UNIQUE INDEX turn_meta_transcript_by_duration_uuid
        ON turn_meta_transcript(transcript_path, duration_uuid)
        WHERE duration_uuid IS NOT NULL;
    `)
    createSessionMetaTable(db)
  }
  ensureSessionMetaAllowsPartialObservations(db)
  migrateSettingsSchema(db, dbPath, legacySettingsDbPath)
}
