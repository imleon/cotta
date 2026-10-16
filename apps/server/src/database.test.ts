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
  return createCottaDatabase(join(root, 'cotta.sqlite'))
}

function expectRemoteBotSelectionSchema(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(remote_bots)').all() as Array<{ name: string; notnull: number }>
  expect(columns.find(({ name }) => name === 'selected_project_id')).toMatchObject({ notnull: 0 })
  expect(columns.find(({ name }) => name === 'selected_session_id')).toMatchObject({ notnull: 0 })
  expect((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'remote_bots'").get() as { sql: string }).sql).toContain(
    'CHECK (selected_session_id IS NULL OR selected_project_id IS NOT NULL)',
  )
}

const insertTurn = `
  INSERT INTO turn_meta_transcript (
    project_key, transcript_path, session_id, primary_user_uuid,
    primary_timestamp_ms, primary_byte_offset, primary_entrypoint,
    file_mtime_ms, file_size, scan_byte_offset, created_at_ms, updated_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

describe('Cotta database', () => {
  it('creates the current schema and reopens it unchanged', async () => {
    const db = await database()
    const path = db.prepare('PRAGMA database_list').get() as { file: string }
    db.close()
    const reopened = createCottaDatabase(path.file)

    await expect((await import('node:fs/promises')).stat(path.file).then((metadata) => metadata.mode & 0o777)).resolves.toBe(0o600)
    expect((reopened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(44)
    expect(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).toEqual([
      { name: 'auth_sessions' },
      { name: 'project_index' },
      { name: 'remote_bot_projects' },
      { name: 'remote_bots' },
      { name: 'session_index' },
      { name: 'session_pins' },
      { name: 'session_raw_transcript_lines' },
      { name: 'session_search_documents' },
      { name: 'session_search_fts' },
      { name: 'session_search_fts_config' },
      { name: 'session_search_fts_data' },
      { name: 'session_search_fts_docsize' },
      { name: 'session_search_fts_idx' },
      { name: 'session_search_state' },
      { name: 'session_subagents' },
      { name: 'settings' },
      { name: 'shares' },
      { name: 'token_usage_stats' },
      { name: 'turn_meta_live' },
      { name: 'turn_meta_transcript' },
    ])
    const sessionIndexColumns = reopened
      .prepare('PRAGMA table_info(session_index)')
      .all()
      .map((row) => (row as { name: string }).name)
    expect(sessionIndexColumns).toContain('last_visible_message_at_ms')
    expect(sessionIndexColumns).toContain('context_usage_json')
    expect(sessionIndexColumns).toContain('context_usage_updated_at_ms')
    expect(reopened.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'session_index_by_project_activity'").get()).toEqual({
      sql: 'CREATE INDEX session_index_by_project_activity\n      ON session_index(current_project_id, COALESCE(last_visible_message_at_ms, file_mtime_ms) DESC, session_id)',
    })
    expectRemoteBotSelectionSchema(reopened)
    expect(() =>
      reopened
        .prepare(`INSERT INTO remote_bots (
          bot_id, platform, app_id, app_secret, all_projects, enabled, config_version,
          selected_session_id, created_at_ms, updated_at_ms
        ) VALUES ('invalid-selection', 'lark', 'invalid-selection', 'secret', 1, 1, 1, 'session', 1, 1)`)
        .run(),
    ).toThrow()
    expect(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session_subagents' AND sql IS NOT NULL ORDER BY name").all()).toEqual([
      { name: 'session_subagents_by_session_parent' },
      { name: 'session_subagents_by_session_turn' },
    ])
    const subagentColumns = reopened
      .prepare('PRAGMA table_info(session_subagents)')
      .all()
      .map((row) => (row as { name: string }).name)
    expect(subagentColumns).toEqual([
      'session_id',
      'subagent_id',
      'owner_turn_id',
      'is_root',
      'parent_agent_id',
      'agent_type',
      'name',
      'description',
      'model',
      'meta_path',
      'meta_file_size',
      'meta_file_mtime_ms',
      'transcript_path',
      'transcript_file_size',
      'transcript_file_mtime_ms',
      'usage_transcript_path',
      'usage_parsed_byte_offset',
      'usage_file_mtime_ms',
      'observed_at_ms',
      'meta_json',
    ])
    expect(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session_search_documents' AND sql IS NOT NULL ORDER BY name").all()).toEqual([
      { name: 'session_search_documents_by_session' },
    ])
    expect(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_search_fts'").get()).toEqual({ name: 'session_search_fts' })
    const searchDocumentColumns = reopened
      .prepare('PRAGMA table_info(session_search_documents)')
      .all()
      .map((row) => (row as { name: string }).name)
    expect(searchDocumentColumns).toContain('content_block_index')
    expect(searchDocumentColumns).toContain('folded_content')
    expect(searchDocumentColumns).toContain('logical_message_id')
    const searchDocumentDdl = (reopened.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_search_documents'").get() as { sql: string }).sql
    expect(searchDocumentDdl).toContain('UNIQUE (session_id, field, logical_message_id, content_block_index)')
    expect(searchDocumentDdl).not.toMatch(/entrypoint|sessionKind/)
    expect(reopened.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'session_search_documents_%'").get()).toEqual({ count: 3 })
    expect(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session_raw_transcript_lines' AND sql IS NOT NULL ORDER BY name").all()).toEqual([
      { name: 'session_raw_transcript_lines_by_owner' },
      { name: 'session_raw_transcript_lines_by_session_line' },
      { name: 'session_raw_transcript_lines_by_uuid' },
    ])
    expect(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'turn_meta_transcript' AND sql IS NOT NULL ORDER BY name").all()).toEqual([
      { name: 'turn_meta_transcript_by_duration_uuid' },
      { name: 'turn_meta_transcript_by_path_offset' },
      { name: 'turn_meta_transcript_by_session_offset' },
      { name: 'turn_meta_transcript_by_session_time' },
      { name: 'turn_meta_transcript_by_session_uuid' },
      { name: 'turn_meta_transcript_by_time_session' },
    ])
    reopened.close()
  })

  it.each([26, 31, 32, 33, 34, 35, 37, 40, 41, 42])('rejects non-current schema version %s', async (version) => {
    const root = await tempRoot('cotta-database-')
    const path = join(root, 'cotta.sqlite')
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE stale_table (id INTEGER PRIMARY KEY); PRAGMA user_version = ${version};`)
    db.close()

    expect(() => createCottaDatabase(path)).toThrow(
      `Unsupported Cotta database schema version ${version}; preserve the database and apply a one-time transactional migration to version 44 based on the actual DDL differences`,
    )
  })

  it('migrates a version 43 database to 44 by adding the shares table', async () => {
    const root = await tempRoot('cotta-database-')
    const path = join(root, 'cotta.sqlite')
    const db = new DatabaseSync(path)
    db.exec('PRAGMA user_version = 43;')
    db.close()

    const migrated = createCottaDatabase(path)
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(44)
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shares'").get()).toEqual({ name: 'shares' })
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
