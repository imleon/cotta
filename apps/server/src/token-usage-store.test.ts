import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createCottaDatabase } from './database.js'
import type { ParsedTranscriptLine } from './session-raw-transcript-cache.js'
import { TokenUsageStore } from './token-usage-store.js'

const databases: DatabaseSync[] = []
const roots: string[] = []
afterEach(async () => {
  databases.splice(0).forEach((db) => void db.close())
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function line(input: { id?: string; uuid?: string; timestamp: string; input?: unknown; create?: unknown; read?: unknown; output?: unknown }): ParsedTranscriptLine {
  const usage = {
    ...(Object.hasOwn(input, 'input') ? { input_tokens: input.input } : {}),
    ...(Object.hasOwn(input, 'create') ? { cache_creation_input_tokens: input.create } : {}),
    ...(Object.hasOwn(input, 'read') ? { cache_read_input_tokens: input.read } : {}),
    ...(Object.hasOwn(input, 'output') ? { output_tokens: input.output } : {}),
  }
  const value = {
    type: 'assistant',
    uuid: input.uuid,
    timestamp: input.timestamp,
    message: { id: input.id, model: 'claude-test', usage },
  }
  return { offset: 0, byteLength: 1, raw: JSON.stringify(value), value }
}

describe('TokenUsageStore', () => {
  it('defaults missing usage token fields to zero and rejects present invalid fields', () => {
    const db = createCottaDatabase(':memory:')
    databases.push(db)
    const store = new TokenUsageStore(db)
    store.ingestLines('/a.jsonl', 'session', false, [
      line({ id: 'missing', timestamp: '2026-09-07T01:00:00Z' }),
      line({ id: 'invalid-input', timestamp: '2026-09-07T02:00:00Z', input: '0' }),
      line({ id: 'invalid-create', timestamp: '2026-09-07T03:00:00Z', create: '0' }),
      line({ id: 'invalid-read', timestamp: '2026-09-07T04:00:00Z', read: -1 }),
      line({ id: 'invalid-output', timestamp: '2026-09-07T05:00:00Z', output: null }),
    ])

    expect(db.prepare('SELECT response_key, total_tokens FROM token_usage_stats ORDER BY response_key').all()).toEqual([{ response_key: 'claude-code:missing', total_tokens: 0 }])
  })

  it('requires a nonempty message id instead of falling back to uuid or a fingerprint', () => {
    const db = createCottaDatabase(':memory:')
    databases.push(db)
    const store = new TokenUsageStore(db)
    store.ingestLines('/a.jsonl', 'session', false, [
      line({ uuid: 'uuid-only', timestamp: '2026-09-07T01:00:00Z', input: 10 }),
      line({ id: '', uuid: 'empty-id', timestamp: '2026-09-07T02:00:00Z', input: 20 }),
    ])

    expect((db.prepare('SELECT COUNT(*) count FROM token_usage_stats').get() as { count: number }).count).toBe(0)
  })

  it('keeps per-field maxima in the same file and deduplicates per-field maxima across files', () => {
    const db = createCottaDatabase(':memory:')
    databases.push(db)
    const store = new TokenUsageStore(db)
    store.ingestLines('/a.jsonl', 'session-a', false, [line({ id: 'msg-1', timestamp: '2026-09-07T01:00:00Z', input: 10, read: 20, output: 5 })])
    store.ingestLines('/a.jsonl', 'session-a', false, [line({ id: 'msg-1', timestamp: '2026-09-07T01:00:00Z', input: 8, read: 10, output: 10 })])
    store.ingestLines('/fork.jsonl', 'session-b', false, [line({ id: 'msg-1', timestamp: '2026-09-07T01:00:00Z', input: 12, read: 15, output: 8 })])

    const result = store.query('today', 'UTC', Date.parse('2026-09-07T12:00:00Z'))
    expect(result).toEqual({
      range: 'today',
      timeZone: 'UTC',
      totals: { totalTokens: 42, inputTokens: 32, outputTokens: 10, cacheReadTokens: 20, cacheHitRate: 20 / 32, sessions: 0, userMessages: 0 },
    })
    expect((db.prepare('SELECT COUNT(*) count FROM token_usage_stats').get() as { count: number }).count).toBe(2)
  })

  it('deduplicates responses globally before filtering the requested range', () => {
    const db = createCottaDatabase(':memory:')
    databases.push(db)
    const store = new TokenUsageStore(db)
    store.ingestLines('/old.jsonl', 'session-a', false, [line({ id: 'forked', timestamp: '2026-09-06T01:00:00Z', input: 10 })])
    store.ingestLines('/new.jsonl', 'session-b', false, [line({ id: 'forked', timestamp: '2026-09-07T01:00:00Z', output: 5 })])

    expect(store.query('today', 'UTC', Date.parse('2026-09-07T12:00:00Z')).totals).toEqual({
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheHitRate: 0,
      sessions: 0,
      userMessages: 0,
    })
  })

  it('counts primary user messages and distinct sessions in the requested local date range', () => {
    const db = createCottaDatabase(':memory:')
    databases.push(db)
    const store = new TokenUsageStore(db)
    const insert = db.prepare(`INSERT INTO turn_meta_transcript (
      project_key, transcript_path, session_id, primary_user_uuid, primary_timestamp_ms, primary_byte_offset,
      file_mtime_ms, file_size, scan_byte_offset, scan_line_no, created_at_ms, updated_at_ms
    ) VALUES ('project', ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0)`)
    insert.run('/a.jsonl', 'session-a', 'turn-1', Date.parse('2026-09-06T23:30:00Z'))
    insert.run('/a.jsonl', 'session-a', 'turn-2', Date.parse('2026-09-07T02:00:00Z'))
    insert.run('/b.jsonl', 'session-b', 'turn-3', Date.parse('2026-09-07T03:00:00Z'))

    const result = store.query('today', 'Asia/Kathmandu', Date.parse('2026-09-07T12:00:00Z'))
    expect(result.totals).toMatchObject({ cacheHitRate: 0, sessions: 2, userMessages: 3 })
  })

  it('authoritatively repairs rewritten and deleted main transcript usage', async () => {
    const db = createCottaDatabase(':memory:')
    databases.push(db)
    const store = new TokenUsageStore(db)
    const root = await mkdtemp(join(tmpdir(), 'cotta-token-usage-'))
    roots.push(root)
    const path = join(root, 'session.jsonl')
    const first = line({ id: 'old', timestamp: '2026-09-07T01:00:00Z', input: 10, output: 5 })
    const replacement = line({ id: 'new', timestamp: '2026-09-07T01:00:00Z', input: 2, output: 1 })
    const originalRaw = `${first.raw}\n${replacement.raw}\n`
    await writeFile(path, originalRaw)
    await store.repairTranscript(path, 'session', Buffer.byteLength(originalRaw))
    store.ingestLines('/stale-main.jsonl', 'session', false, [line({ id: 'stale-main', timestamp: '2026-09-07T01:00:00Z', input: 100 })])
    store.ingestLines('/subagent.jsonl', 'session', true, [line({ id: 'subagent', timestamp: '2026-09-07T01:00:00Z', input: 7 })])

    const rewrittenRaw = `${replacement.raw}\n${' '.repeat(Buffer.byteLength(originalRaw) - Buffer.byteLength(replacement.raw) - 1)}`
    expect(Buffer.byteLength(rewrittenRaw)).toBe(Buffer.byteLength(originalRaw))
    await writeFile(path, rewrittenRaw)
    await store.repairTranscript(path, 'session', Buffer.byteLength(rewrittenRaw))

    expect(db.prepare('SELECT response_key, is_subagent, total_tokens FROM token_usage_stats ORDER BY response_key').all()).toEqual([
      { response_key: 'claude-code:new', is_subagent: 0, total_tokens: 3 },
      { response_key: 'claude-code:subagent', is_subagent: 1, total_tokens: 7 },
    ])
  })

  it('authoritatively repairs rewritten subagent usage', async () => {
    const db = createCottaDatabase(':memory:')
    databases.push(db)
    const store = new TokenUsageStore(db)
    const root = await mkdtemp(join(tmpdir(), 'cotta-token-usage-'))
    roots.push(root)
    const path = join(root, 'agent.jsonl')
    const first = line({ id: 'old', timestamp: '2026-09-07T01:00:00Z', input: 10, output: 5 })
    const replacement = line({ id: 'new', timestamp: '2026-09-07T01:00:00Z', input: 2, output: 1 })
    const originalRaw = `${first.raw}\n${replacement.raw}\n`
    await writeFile(path, originalRaw)
    db.prepare(`INSERT INTO session_subagents (
      session_id, subagent_id, owner_turn_id, transcript_path, transcript_file_size, transcript_file_mtime_ms, observed_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('session', 'agent', 'turn', path, Buffer.byteLength(originalRaw), 1, 1)
    await store.syncSubagents('session')

    const rewrittenRaw = `${replacement.raw}\n${' '.repeat(Buffer.byteLength(originalRaw) - Buffer.byteLength(replacement.raw) - 1)}`
    await writeFile(path, rewrittenRaw)
    db.prepare('UPDATE session_subagents SET transcript_file_mtime_ms = ? WHERE session_id = ?').run(2, 'session')
    await store.syncSubagents('session', true)

    expect(db.prepare('SELECT response_key, total_tokens FROM token_usage_stats').all()).toEqual([{ response_key: 'claude-code:new', total_tokens: 3 }])
  })

  it('returns the requested consecutive daily window with zero-filled dates and local timezone boundaries', () => {
    const db = createCottaDatabase(':memory:')
    databases.push(db)
    const store = new TokenUsageStore(db)
    store.ingestLines('/a.jsonl', 'session', false, [
      line({ id: 'included', timestamp: '2026-09-05T18:30:00Z', input: 2, read: 3, output: 5 }),
      line({ id: 'too-old', timestamp: '2026-09-04T18:14:59Z', input: 100 }),
    ])

    expect(store.queryDaily(3, 'Asia/Kathmandu', Date.parse('2026-09-07T12:00:00Z'))).toEqual({
      days: 3,
      timeZone: 'Asia/Kathmandu',
      daily: [
        { date: '2026-09-05', uncachedInputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, totalTokens: 0 },
        { date: '2026-09-06', uncachedInputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 3, outputTokens: 5, totalTokens: 10 },
        { date: '2026-09-07', uncachedInputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, totalTokens: 0 },
      ],
    })
  })

  it('uses the requested IANA timezone for summary date boundaries', () => {
    const db = createCottaDatabase(':memory:')
    databases.push(db)
    const store = new TokenUsageStore(db)
    store.ingestLines('/subagent.jsonl', 'session', true, [line({ id: 'subagent-message', timestamp: '2026-09-06T23:30:00Z', input: 2, create: 3, output: 5 })])

    const result = store.query('today', 'Asia/Kathmandu', Date.parse('2026-09-07T12:00:00Z'))
    expect(result.totals).toMatchObject({ totalTokens: 10, inputTokens: 5, outputTokens: 5 })
  })
})
