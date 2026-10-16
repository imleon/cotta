import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createCottaDatabase } from './database.js'
import { repairTranscriptOwnership } from './repair-transcript-ownership.js'
import { SessionSearchStore } from './session-search-store.js'
import { TranscriptIndexStore } from './transcript-index-store.js'

function insertLine(db: DatabaseSync, sessionId: string, byteOffset: number, value: unknown, ownerTurnId: string | null): void {
  const record = value as { uuid?: unknown; type?: unknown }
  db.prepare(`
    INSERT INTO session_raw_transcript_lines
      (session_id, byte_offset, byte_length, line_no, uuid, type, owner_turn_id, raw_json, created_at_ms)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, 0)
  `).run(sessionId, byteOffset, byteOffset + 1, typeof record.uuid === 'string' ? record.uuid : null, typeof record.type === 'string' ? record.type : null, ownerTurnId, JSON.stringify(value))
}

function user(uuid: string): unknown {
  return { type: 'user', uuid, message: { role: 'user', content: uuid } }
}

function assistant(uuid: string): unknown {
  return { type: 'assistant', uuid, message: { role: 'assistant', content: [] } }
}

describe('repairTranscriptOwnership', () => {
  it('repairs ownership independently across multiple sessions', () => {
    const db = createCottaDatabase(':memory:')
    insertLine(db, 'session-b', 0, user('user-b'), null)
    insertLine(db, 'session-a', 0, user('user-a'), null)
    insertLine(db, 'session-b', 1, assistant('assistant-b'), null)
    insertLine(db, 'session-a', 1, assistant('assistant-a'), null)

    expect(repairTranscriptOwnership(db)).toEqual({ sessions: 2, rows: 4, changed: 4 })
    expect(db.prepare('SELECT session_id, owner_turn_id FROM session_raw_transcript_lines ORDER BY session_id, byte_offset').all()).toEqual([
      { session_id: 'session-a', owner_turn_id: 'user-a' },
      { session_id: 'session-a', owner_turn_id: 'user-a' },
      { session_id: 'session-b', owner_turn_id: 'user-b' },
      { session_id: 'session-b', owner_turn_id: 'user-b' },
    ])
    db.close()
  })

  it('does not update already-correct ownership', () => {
    const db = createCottaDatabase(':memory:')
    insertLine(db, 'session', 0, user('user-1'), 'user-1')
    insertLine(db, 'session', 1, assistant('assistant-1'), 'user-1')
    db.exec(`
      CREATE TRIGGER reject_owner_update
      BEFORE UPDATE OF owner_turn_id ON session_raw_transcript_lines
      BEGIN
        SELECT RAISE(ABORT, 'unexpected owner update');
      END;
    `)

    expect(repairTranscriptOwnership(db)).toEqual({ sessions: 1, rows: 2, changed: 0 })
    db.close()
  })

  it('rebuilds search documents with repaired ownership', () => {
    const db = createCottaDatabase(':memory:')
    const index = new TranscriptIndexStore(db)
    index.upsertSession({ sessionId: 'session', transcriptPath: '/repo/session.jsonl', fileSize: 1, fileMtimeMs: 1, currentCwd: '/repo', customTitle: 'Repair me', isValidSessionId: true })
    insertLine(db, 'session', 0, user('user-1'), null)
    insertLine(db, 'session', 1, assistant('assistant-1'), null)
    const searchStore = new SessionSearchStore(db, index)
    searchStore.rebuildSession('session')
    expect(searchStore.hasIndexedSession('session')).toBe(true)

    expect(repairTranscriptOwnership(db)).toEqual({ sessions: 1, rows: 2, changed: 2 })
    expect(searchStore.hasIndexedSession('session')).toBe(true)
    expect(searchStore.search({ query: 'user-1' }).results[0]?.matches[0]?.locator?.turnId).toBe('user-1')
    db.close()
  })

  it('rolls back prior updates when a later update fails', () => {
    const db = createCottaDatabase(':memory:')
    insertLine(db, 'session', 0, user('user-1'), 'stale-1')
    insertLine(db, 'session', 1, assistant('assistant-1'), 'stale-2')
    db.exec(`
      CREATE TRIGGER fail_second_owner_update
      BEFORE UPDATE OF owner_turn_id ON session_raw_transcript_lines
      WHEN OLD.byte_offset = 1
      BEGIN
        SELECT RAISE(ABORT, 'induced owner update failure');
      END;
    `)

    expect(() => repairTranscriptOwnership(db)).toThrow(/induced owner update failure/)
    expect(db.prepare('SELECT owner_turn_id FROM session_raw_transcript_lines ORDER BY byte_offset').all()).toEqual([{ owner_turn_id: 'stale-1' }, { owner_turn_id: 'stale-2' }])
    db.close()
  })
})
