import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createCottaDatabase } from './database.js'

const roots: string[] = []

async function tempRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function database() {
  const root = await tempRoot('cotta-database-')
  return createCottaDatabase(join(root, 'cotta.sqlite'), join(root, 'missing-settings.sqlite'))
}

function createLegacySettingsDatabase(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE settings (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (scope, key)
    );
    CREATE TABLE session_settings (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      permission_mode TEXT NOT NULL,
      model TEXT,
      effort TEXT,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (project_id, session_id)
    );
    CREATE TABLE auth_sessions (
      session_id TEXT PRIMARY KEY,
      login TEXT NOT NULL,
      name TEXT,
      avatar_url TEXT,
      expires_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    INSERT INTO settings VALUES ('global', 'showDebugNav', 'false', 1);
    INSERT INTO settings VALUES ('global', 'defaultModel', '"sonnet"', 2);
    INSERT INTO session_settings VALUES ('project', 'session', 'plan', 'model', 'high', 3);
    INSERT INTO auth_sessions VALUES ('auth', 'login', 'Name', NULL, 123, 4);
    PRAGMA user_version = 4;
  `)
  db.close()
}

const insertTurn = `
  INSERT INTO turn_meta_transcript (
    project_key, transcript_path, session_id, primary_user_uuid,
    primary_timestamp_ms, primary_byte_offset, primary_entrypoint,
    file_mtime_ms, file_size, scan_byte_offset, created_at_ms, updated_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

describe('Cotta database', () => {
  it('creates the versioned schema idempotently', async () => {
    const db = await database()
    const path = db.prepare('PRAGMA database_list').get() as { file: string }
    db.close()
    const reopened = createCottaDatabase(path.file, join(await tempRoot('cotta-missing-settings-'), 'settings.sqlite'))

    expect((reopened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(8)
    expect(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).toEqual([
      { name: 'auth_sessions' },
      { name: 'session_meta' },
      { name: 'settings' },
      { name: 'turn_meta_transcript' },
    ])
    expect(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'turn_meta_transcript' AND sql IS NOT NULL ORDER BY name").all()).toEqual([
      { name: 'turn_meta_transcript_by_duration_uuid' },
      { name: 'turn_meta_transcript_by_path_offset' },
      { name: 'turn_meta_transcript_by_session_time' },
    ])
    reopened.close()
  })

  it('imports legacy settings and auth sessions once then deletes the legacy file', async () => {
    const root = await tempRoot('cotta-database-')
    const dbPath = join(root, 'cotta.sqlite')
    const legacyPath = join(root, 'cotta-settings.sqlite')
    createLegacySettingsDatabase(legacyPath)

    const db = createCottaDatabase(dbPath, legacyPath)

    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(8)
    expect(db.prepare('SELECT scope, key, value_json, updated_at_ms FROM settings ORDER BY key').all()).toEqual([
      { scope: 'global', key: 'defaultModel', value_json: '"sonnet"', updated_at_ms: 2 },
      { scope: 'global', key: 'showDebugNav', value_json: 'false', updated_at_ms: 1 },
    ])
    expect(db.prepare('SELECT session_id, login, name, avatar_url, expires_at_ms, updated_at_ms FROM auth_sessions').all()).toEqual([
      { session_id: 'auth', login: 'login', name: 'Name', avatar_url: null, expires_at_ms: 123, updated_at_ms: 4 },
    ])
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_settings'").get()).toBeUndefined()
    db.prepare("DELETE FROM auth_sessions WHERE session_id = 'auth'").run()
    db.close()

    expect(existsSync(legacyPath)).toBe(false)
    expect(existsSync(`${legacyPath}-wal`)).toBe(false)
    expect(existsSync(`${legacyPath}-shm`)).toBe(false)

    const reopened = createCottaDatabase(dbPath, legacyPath)
    expect(reopened.prepare("SELECT session_id FROM auth_sessions WHERE session_id = 'auth'").get()).toBeUndefined()
    reopened.close()
  })

  it('keeps destination settings and auth sessions on legacy conflicts', async () => {
    const root = await tempRoot('cotta-database-')
    const dbPath = join(root, 'cotta.sqlite')
    const legacyPath = join(root, 'cotta-settings.sqlite')
    createLegacySettingsDatabase(legacyPath)
    const db = createCottaDatabase(dbPath, join(root, 'missing-settings.sqlite'))
    db.exec(`
      INSERT INTO settings VALUES ('global', 'showDebugNav', 'true', 10);
      INSERT INTO auth_sessions VALUES ('auth', 'new-login', NULL, 'avatar', 456, 10);
      PRAGMA user_version = 7;
    `)
    db.close()

    const migrated = createCottaDatabase(dbPath, legacyPath)

    expect(migrated.prepare('SELECT key, value_json, updated_at_ms FROM settings ORDER BY key').all()).toEqual([
      { key: 'defaultModel', value_json: '"sonnet"', updated_at_ms: 2 },
      { key: 'showDebugNav', value_json: 'true', updated_at_ms: 10 },
    ])
    expect(migrated.prepare('SELECT session_id, login, avatar_url, expires_at_ms, updated_at_ms FROM auth_sessions').all()).toEqual([
      { session_id: 'auth', login: 'new-login', avatar_url: 'avatar', expires_at_ms: 456, updated_at_ms: 10 },
    ])
    migrated.close()
  })

  it('no-ops legacy import when source is missing or equals destination', async () => {
    const root = await tempRoot('cotta-database-')
    const dbPath = join(root, 'cotta.sqlite')
    const missing = createCottaDatabase(dbPath, join(root, 'missing-settings.sqlite'))
    expect((missing.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(8)
    missing.close()

    const samePath = createCottaDatabase(dbPath, dbPath)
    expect((samePath.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(8)
    samePath.close()
  })

  it.each([1, 2])('migrates v%i to v3 and resets only transcripts with incomplete CLI turns', async (version) => {
    const db = await database()
    const path = (db.prepare('PRAGMA database_list').get() as { file: string }).file
    const insert = db.prepare(insertTurn)
    insert.run('project', '/incomplete-cli.jsonl', 'session', 'open', 100, 0, 'cli', 100, 500, 500, 100, 100)
    insert.run('project', '/incomplete-cli.jsonl', 'session', 'done', 200, 100, 'sdk', 100, 500, 500, 100, 100)
    insert.run('project', '/complete-cli.jsonl', 'session', 'complete', 100, 0, 'cli', 100, 300, 300, 100, 100)
    insert.run('project', '/incomplete-sdk.jsonl', 'session', 'sdk', 100, 0, 'sdk', 100, 400, 400, 100, 100)
    db.prepare('UPDATE turn_meta_transcript SET duration_uuid = primary_user_uuid WHERE primary_user_uuid IN (?, ?)').run('done', 'complete')
    if (version === 1) db.exec('ALTER TABLE turn_meta_transcript DROP COLUMN scan_line_no')
    db.exec(`PRAGMA user_version = ${version}`)
    db.close()

    const migrated = createCottaDatabase(path, join(await tempRoot('cotta-missing-settings-'), 'settings.sqlite'))
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(8)
    expect(migrated.prepare(`
      SELECT transcript_path, primary_user_uuid, scan_byte_offset, scan_line_no
      FROM turn_meta_transcript ORDER BY transcript_path, primary_user_uuid
    `).all()).toEqual([
      { transcript_path: '/complete-cli.jsonl', primary_user_uuid: 'complete', scan_byte_offset: 300, scan_line_no: 0 },
      { transcript_path: '/incomplete-cli.jsonl', primary_user_uuid: 'done', scan_byte_offset: 0, scan_line_no: 0 },
      { transcript_path: '/incomplete-cli.jsonl', primary_user_uuid: 'open', scan_byte_offset: 0, scan_line_no: 0 },
      { transcript_path: '/incomplete-sdk.jsonl', primary_user_uuid: 'sdk', scan_byte_offset: 400, scan_line_no: 0 },
    ])
    migrated.close()
  })

  it('repairs v7 session_meta tables that required permission_mode', async () => {
    const db = await database()
    const path = (db.prepare('PRAGMA database_list').get() as { file: string }).file
    db.exec(`
      DROP TABLE session_meta;
      CREATE TABLE session_meta (
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
        PRIMARY KEY (project_id, session_id)
      );
      INSERT INTO session_meta VALUES ('project', 'session', 'default', NULL, NULL, 1, 1);
      PRAGMA user_version = 7;
    `)
    db.close()

    const migrated = createCottaDatabase(path, join(await tempRoot('cotta-missing-settings-'), 'settings.sqlite'))

    expect(migrated.prepare("SELECT name, \"notnull\" FROM pragma_table_info('session_meta') WHERE name = 'permission_mode'").all()).toEqual([{ name: 'permission_mode', notnull: 0 }])
    migrated.prepare("INSERT INTO session_meta (project_id, session_id, permission_mode, model, effort, observed_at_ms, updated_at_ms) VALUES ('project', 'model-only', NULL, 'claude-opus-5', NULL, 2, 2)").run()
    migrated.close()
  })

  it('adds away_summary and session_meta to existing v5 databases that missed them', async () => {
    const db = await database()
    const path = (db.prepare('PRAGMA database_list').get() as { file: string }).file
    db.exec('ALTER TABLE turn_meta_transcript DROP COLUMN away_summary; DROP TABLE session_meta; PRAGMA user_version = 5;')
    db.close()

    const migrated = createCottaDatabase(path, join(await tempRoot('cotta-missing-settings-'), 'settings.sqlite'))

    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(8)
    expect(migrated.prepare("SELECT name FROM pragma_table_info('turn_meta_transcript') WHERE name = 'away_summary'").all()).toEqual([{ name: 'away_summary' }])
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_meta'").all()).toEqual([{ name: 'session_meta' }])
    migrated.close()
  })

  it('stores one logical turn per transcript and allows completion later', async () => {
    const db = await database()
    const insert = db.prepare(insertTurn)
    insert.run('project', '/a/session.jsonl', 'session', 'user', 100, 0, 'cli', 100, 200, 200, 100, 100)
    insert.run('project', '/b/session.jsonl', 'session', 'user', 100, 0, 'cli', 100, 200, 200, 100, 100)

    db.prepare(`
      UPDATE turn_meta_transcript SET
        duration_uuid = ?, duration_parent_uuid = ?, duration_timestamp_ms = ?, duration_ms = ?,
        duration_message_count = ?, duration_line_no = ?, duration_byte_offset = ?, duration_byte_length = ?,
        duration_payload_json = ?, updated_at_ms = ?
      WHERE transcript_path = ? AND primary_user_uuid = ?
    `).run('duration', 'assistant', 150, 50, 2, 3, 150, 50, '{}', 150, '/a/session.jsonl', 'user')

    expect(db.prepare('SELECT transcript_path, duration_ms FROM turn_meta_transcript ORDER BY transcript_path').all()).toEqual([
      { transcript_path: '/a/session.jsonl', duration_ms: 50 },
      { transcript_path: '/b/session.jsonl', duration_ms: null },
    ])
    expect(() => insert.run('project', '/a/session.jsonl', 'session', 'user', 100, 0, 'cli', 100, 200, 200, 100, 100)).toThrow()
    db.close()
  })
})
