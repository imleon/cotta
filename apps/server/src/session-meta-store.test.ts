import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCottaDatabase } from './database.js'
import { SessionMetaStore } from './session-meta-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function store() {
  const root = await mkdtemp(join(tmpdir(), 'cotta-session-meta-'))
  roots.push(root)
  const db = createCottaDatabase(join(root, 'cotta.sqlite'))
  return { db, store: new SessionMetaStore(db) }
}

describe('SessionMetaStore', () => {
  it('stores and loads session meta', async () => {
    const { db, store: meta } = await store()

    meta.setSessionMeta('project', 'session', { permissionMode: 'plan', model: 'claude-opus-5', effort: 'high' }, 100)

    expect(meta.getSessionMeta('project', 'session')).toEqual({ permissionMode: 'plan', model: 'claude-opus-5', effort: 'high' })
    db.close()
  })

  it('patches permission independently from model and effort', async () => {
    const { db, store: meta } = await store()

    meta.setSessionMeta('project', 'session', { model: 'claude-opus-5', effort: 'high' }, 100)
    meta.setSessionMeta('project', 'session', { permissionMode: 'plan' }, 101)
    expect(meta.getSessionMeta('project', 'session')).toEqual({ permissionMode: 'plan', model: 'claude-opus-5', effort: 'high' })

    meta.setSessionMeta('project', 'session', { model: 'claude-sonnet-5', effort: 'medium' }, 102)
    expect(meta.getSessionMeta('project', 'session')).toEqual({ permissionMode: 'plan', model: 'claude-sonnet-5', effort: 'medium' })
    db.close()
  })

  it('ignores older observations and accepts newer ones', async () => {
    const { db, store: meta } = await store()

    meta.setSessionMeta('project', 'session', { permissionMode: 'plan', model: 'claude-opus-5', effort: 'high' }, 100)
    meta.setSessionMeta('project', 'session', { permissionMode: 'default', model: null, effort: null }, 99)
    expect(meta.getSessionMeta('project', 'session')).toEqual({ permissionMode: 'plan', model: 'claude-opus-5', effort: 'high' })

    meta.setSessionMeta('project', 'session', { permissionMode: 'acceptEdits', model: 'claude-sonnet-5', effort: 'xhigh' }, 101)
    expect(meta.getSessionMeta('project', 'session')).toEqual({ permissionMode: 'acceptEdits', model: 'claude-sonnet-5', effort: 'xhigh' })
    db.close()
  })
})
