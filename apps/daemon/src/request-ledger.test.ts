import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createCottaDatabase } from './database.js'
import { canonicalJson, REQUEST_RECEIPT_RETENTION_MS, RequestIdConflictError, RequestLedger } from './request-ledger.js'

const roots: string[] = []
const databases: DatabaseSync[] = []

afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function ledger(now: () => number = Date.now) {
  const root = await mkdtemp(join(tmpdir(), 'cotta-request-ledger-'))
  roots.push(root)
  const db = createCottaDatabase(join(root, 'cotta.sqlite'))
  databases.push(db)
  return { db, ledger: new RequestLedger(db, { now }) }
}

describe('RequestLedger', () => {
  it('keeps the first recorded result for a request', async () => {
    const { ledger: store } = await ledger(() => 5)

    store.record('turn', 'u1', 's1', { attempt: 1 })
    const second = store.record('turn', 'u1', 's1', { attempt: 2 })

    expect(second).toEqual({ sessionId: 's1', result: { attempt: 1 }, createdAtMs: 5 })
    expect(store.receipt('turn', 'u1')).toEqual(second)
    expect(store.receipt('permission', 'u1')).toBeNull()
  })

  it('stops answering from receipts after the retention window and prunes them', async () => {
    let now = 0
    const { db, ledger: store } = await ledger(() => now)
    store.record('turn', 'u1', 's1', { attempt: 1 })

    now = REQUEST_RECEIPT_RETENTION_MS + 1
    expect(store.receipt('turn', 'u1')).toBeNull()
    expect(store.record('turn', 'u1', 's1', { attempt: 2 }).result).toEqual({ attempt: 2 })
    now = 2 * REQUEST_RECEIPT_RETENTION_MS + 2
    expect(store.prune()).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS count FROM request_receipts').get()).toEqual({ count: 0 })
  })

  it('shares an in-flight attempt with duplicates, including its failure, and frees the slot afterwards', async () => {
    const { ledger: store } = await ledger()
    let runs = 0
    let fail!: (error: Error) => void
    const operation = () => {
      runs += 1
      return new Promise<string>((_resolve, reject) => {
        fail = reject
      })
    }

    const first = store.once('turn', 'u1', 's1', operation)
    const duplicate = store.once('turn', 'u1', 's1', operation)
    const conflicting = store.once('turn', 'u1', 's2', operation)
    fail(new Error('rejected'))

    await expect(first).rejects.toThrow('rejected')
    await expect(duplicate).rejects.toThrow('rejected')
    await expect(conflicting).rejects.toBeInstanceOf(RequestIdConflictError)
    expect(runs).toBe(1)
    await expect(store.once('turn', 'u1', 's1', async () => 'again')).resolves.toBe('again')
  })

  it('finds transcript or live-result evidence of a submission', async () => {
    const { db, ledger: store } = await ledger()
    db.prepare(
      `INSERT INTO turn_meta_transcript (project_key, transcript_path, session_id, primary_user_uuid, primary_timestamp_ms, primary_byte_offset, file_mtime_ms, file_size, scan_byte_offset, created_at_ms, updated_at_ms)
       VALUES ('p', '/t.jsonl', 's1', 'u1', 0, 0, 0, 0, 0, 0, 0)`,
    ).run()
    db.prepare(
      `INSERT INTO turn_meta_live (session_id, primary_user_uuid, result_uuid, result_subtype, is_error, duration_ms, result_recorded_at_ms, payload_json, updated_at_ms)
       VALUES ('s1', 'u2', 'r2', 'success', 0, 0, 0, '{}', 0)`,
    ).run()

    expect(store.hasTranscriptTurn('s1', 'u1')).toBe(true)
    expect(store.hasTranscriptTurn('s1', 'u2')).toBe(true)
    expect(store.hasTranscriptTurn('s2', 'u1')).toBe(false)
  })
})

describe('canonicalJson', () => {
  it('ignores object key order but not array order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [2, 1] } })).toBe(canonicalJson({ a: { c: [2, 1], d: 2 }, b: 1 }))
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }))
  })
})
