import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCottaDatabase } from './database.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function database() {
  const root = await mkdtemp(join(tmpdir(), 'cotta-database-'))
  roots.push(root)
  return createCottaDatabase(join(root, 'cotta.sqlite'))
}

const insertTurn = `
  INSERT INTO turn_meta_transcript (
    project_key, transcript_path, session_id, primary_user_uuid,
    primary_timestamp_ms, primary_byte_offset, primary_entrypoint,
    file_mtime_ms, file_size, scan_byte_offset, created_at_ms, updated_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

describe('Cotta database', () => {
  it('creates the versioned turn metadata schema idempotently', async () => {
    const db = await database()
    const path = db.prepare('PRAGMA database_list').get() as { file: string }
    db.close()
    const reopened = createCottaDatabase(path.file)

    expect((reopened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(6)
    expect(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()).toEqual([{ name: 'turn_meta_transcript' }])
    expect(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'turn_meta_transcript' AND sql IS NOT NULL ORDER BY name").all()).toEqual([
      { name: 'turn_meta_transcript_by_duration_uuid' },
      { name: 'turn_meta_transcript_by_path_offset' },
      { name: 'turn_meta_transcript_by_session_time' },
    ])
    reopened.close()
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

    const migrated = createCottaDatabase(path)
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(6)
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

  it('adds away_summary to existing v5 databases that missed the column', async () => {
    const db = await database()
    const path = (db.prepare('PRAGMA database_list').get() as { file: string }).file
    db.exec('ALTER TABLE turn_meta_transcript DROP COLUMN away_summary; PRAGMA user_version = 5;')
    db.close()

    const migrated = createCottaDatabase(path)

    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(6)
    expect(migrated.prepare("SELECT name FROM pragma_table_info('turn_meta_transcript') WHERE name = 'away_summary'").all()).toEqual([{ name: 'away_summary' }])
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
