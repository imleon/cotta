import { describe, expect, it } from 'vitest'
import { createCottaDatabase } from './database.js'
import { SessionPinStore } from './session-pin-store.js'

describe('SessionPinStore', () => {
  function store() {
    const db = createCottaDatabase(':memory:')
    const index = db.prepare('INSERT INTO session_index (session_id, current_project_id, current_cwd, is_valid_session_id, updated_at_ms) VALUES (?, ?, ?, 1, 1)')
    index.run('session-1', 'project-a', '/repo/a')
    index.run('session-2', 'project-a', '/repo/a')
    index.run('session-3', 'project-b', '/repo/b')
    return { db, pins: new SessionPinStore(db) }
  }

  it('pins, sorts, and moves repeated pins to the front', () => {
    const { db, pins } = store()
    pins.pin('project-b', 'session-2', 20)
    pins.pin('project-a', 'session-1', 10)
    pins.pin('project-a', 'session-1', 30)

    expect(pins.listPins()).toEqual([
      { projectId: 'project-a', sessionId: 'session-1', pinnedAtMs: 30 },
      { projectId: 'project-a', sessionId: 'session-2', pinnedAtMs: 20 },
    ])
    db.close()
  })

  it('uses session-scoped identities and unpins idempotently', () => {
    const { db, pins } = store()
    pins.pin('project-a', 'session-1', 10)
    pins.pin('project-b', 'session-1', 20)
    expect(pins.listPins()).toEqual([{ projectId: 'project-a', sessionId: 'session-1', pinnedAtMs: 20 }])

    pins.unpin('project-a', 'session-1')
    pins.unpin('project-a', 'session-1')
    expect(pins.listPins()).toEqual([])
    db.close()
  })

  it('unpins multiple identities', () => {
    const { db, pins } = store()
    pins.pin('project-a', 'session-1', 30)
    pins.pin('project-a', 'session-2', 20)
    pins.pin('project-b', 'session-3', 10)
    pins.unpinMany([
      { projectId: 'project-a', sessionId: 'session-1' },
      { projectId: 'project-b', sessionId: 'session-3' },
    ])

    expect(pins.listPins()).toEqual([{ projectId: 'project-a', sessionId: 'session-2', pinnedAtMs: 20 }])
    db.close()
  })
})
