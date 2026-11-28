import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCottaDatabase } from './database.js'
import { SessionContextUsageStore } from './session-context-usage-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function store() {
  const root = await mkdtemp(join(tmpdir(), 'cotta-context-usage-'))
  roots.push(root)
  const db = createCottaDatabase(join(root, 'cotta.sqlite'))
  return { db, store: new SessionContextUsageStore(db) }
}

describe('SessionContextUsageStore', () => {
  it('stores and replaces the last successful snapshot', async () => {
    const context = await store()
    expect(context.store.getContextUsage('session')).toBeNull()

    context.store.setContextUsage(
      'session',
      { model: 'claude-sonnet-5', categories: [{ name: 'Messages', tokens: 10, kind: 'used' }], totalTokens: 10, autoCompactThreshold: 160, maxTokens: 200, percentage: 5, updatedAtMs: 1 },
      1,
    )
    expect(context.store.getContextUsage('session')).toMatchObject({ model: 'claude-sonnet-5', categories: [{ name: 'Messages', tokens: 10, kind: 'used' }], totalTokens: 10, percentage: 5 })
    expect(context.db.prepare('SELECT session_id FROM session_index WHERE session_id = ?').get('session')).toEqual({ session_id: 'session' })

    context.db
      .prepare(`UPDATE session_index SET context_usage_json = ?, updated_at_ms = ? WHERE session_id = ?`)
      .run(JSON.stringify({ categories: [{ name: 'Messages', tokens: 20 }], totalTokens: 20, autoCompactThreshold: null, maxTokens: 200, percentage: 10 }), 100, 'session')
    expect(context.store.getContextUsage('session')).toBeNull()

    context.store.setContextUsage('session', { model: null, categories: [], totalTokens: 30, autoCompactThreshold: null, maxTokens: 200, percentage: 15, updatedAtMs: 2 }, 2)
    expect(context.db.prepare('SELECT updated_at_ms FROM session_index WHERE session_id = ?').get('session')).toEqual({ updated_at_ms: 100 })

    context.store.setContextUsage('session', { model: null, categories: [], totalTokens: 30, autoCompactThreshold: null, maxTokens: 200, percentage: 15, updatedAtMs: 0 }, 0)
    expect(context.store.getContextUsage('session')).toEqual({ model: null, categories: [], totalTokens: 30, autoCompactThreshold: null, maxTokens: 200, percentage: 15, updatedAtMs: 2 })
    context.db.close()
  })
})
