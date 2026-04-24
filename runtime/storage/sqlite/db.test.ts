import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteDatabase } from './db.js'

const tempDirs: string[] = []

function createTempDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cotta-db-test-'))
  tempDirs.push(dir)
  return join(dir, `${name}.sqlite`)
}

function getColumns(db: Database.Database, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>
  return rows.map((row) => row.name).filter((name): name is string => typeof name === 'string')
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

describe('createSqliteDatabase', () => {
  it('creates the latest schema for a fresh database', () => {
    const db = createSqliteDatabase(createTempDbPath('fresh'))

    try {
      const schemaVersion = db.prepare('SELECT version FROM schema_version').get() as { version: number }

      expect(schemaVersion.version).toBe(3)
      expect(getColumns(db, 'channels')).toContain('current_sdk_session_id')
    } finally {
      db.close()
    }
  })

  it('migrates an explicit v1 database to the latest schema', () => {
    const dbPath = createTempDbPath('legacy-v1')
    const legacy = new Database(dbPath)
    legacy.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (1);

      CREATE TABLE connectors (
        connector_id TEXT PRIMARY KEY,
        connector_type TEXT NOT NULL,
        connector_config_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE agents (
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

      CREATE TABLE channels (
        channel_id TEXT PRIMARY KEY,
        channel_key TEXT NOT NULL,
        channel_name TEXT,
        connector_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    legacy.close()

    const db = createSqliteDatabase(dbPath)

    try {
      const schemaVersion = db.prepare('SELECT version FROM schema_version').get() as { version: number }
      expect(schemaVersion.version).toBe(3)
      expect(getColumns(db, 'channels')).toContain('current_sdk_session_id')
    } finally {
      db.close()
    }
  })

  it('rejects non-empty databases that do not have a schema_version table', () => {
    const dbPath = createTempDbPath('missing-schema-version')
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE connectors (
        connector_id TEXT PRIMARY KEY
      );
    `)
    db.close()

    expect(() => createSqliteDatabase(dbPath)).toThrow(
      'Unsupported SQLite schema: schema_version table is required for non-empty databases',
    )
  })

  it('rejects databases newer than the runtime supports', () => {
    const dbPath = createTempDbPath('future')
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (99);
    `)
    db.close()

    expect(() => createSqliteDatabase(dbPath)).toThrow(
      'Unsupported SQLite schema version 99; runtime supports up to 3',
    )
  })

  it('rejects schema_version tables with multiple rows', () => {
    const dbPath = createTempDbPath('duplicate-schema-version')
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (1);
      INSERT INTO schema_version (version) VALUES (2);
    `)
    db.close()

    expect(() => createSqliteDatabase(dbPath)).toThrow(
      'Invalid SQLite schema: schema_version must contain exactly one row',
    )
  })

  it('rejects invalid schema_version values', () => {
    const dbPath = createTempDbPath('invalid-schema-version')
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (-1);
    `)
    db.close()

    expect(() => createSqliteDatabase(dbPath)).toThrow(
      'Invalid SQLite schema_version value: -1',
    )
  })
})
