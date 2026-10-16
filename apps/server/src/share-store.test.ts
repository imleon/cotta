import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TurnSummary } from '@cotta/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createCottaDatabase } from './database.js'
import { newShareToken, ShareStore } from './share-store.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function store() {
  const root = await mkdtemp(join(tmpdir(), 'cotta-share-'))
  roots.push(root)
  return new ShareStore(createCottaDatabase(join(root, 'cotta.sqlite')))
}

const snapshot = (turnId: string): TurnSummary => ({ primaryUserUuid: turnId, messages: [{ type: 'user', message: { role: 'user', content: 'hi' } }] }) as never
const base = { projectId: 'p', sessionId: 's', assets: [] }

describe('ShareStore', () => {
  it('creates then reuses the same token for a turn', async () => {
    const s = await store()
    const a = s.createOrReuse({ token: newShareToken(), ...base, turnId: 't', snapshot: snapshot('t') })
    const b = s.createOrReuse({ token: newShareToken(), ...base, turnId: 't', snapshot: snapshot('t') })
    expect(a.reused).toBe(false)
    expect(b.reused).toBe(true)
    expect(b.record.token).toBe(a.record.token)
    expect(s.list(null).items).toHaveLength(1)
  })

  it('reads a snapshot back by token', async () => {
    const s = await store()
    const { record } = s.createOrReuse({ token: newShareToken(), ...base, turnId: 't', snapshot: snapshot('t') })
    expect(s.getByToken(record.token)?.snapshot.primaryUserUuid).toBe('t')
    expect(s.getByToken('nope')).toBeNull()
  })

  it('inserts the snapshot and asset manifest together; a reused create keeps the first row', async () => {
    const s = await store()
    const assets = [
      { src: 'cotta-asset/0', file: '0.png' },
      { src: 'cotta-asset/1', file: null },
    ]
    const { record } = s.createOrReuse({ token: newShareToken(), ...base, turnId: 't', snapshot: snapshot('t'), assets })
    expect(s.getByToken(record.token)?.assets).toEqual(assets)
    const again = s.createOrReuse({ token: newShareToken(), ...base, turnId: 't', snapshot: snapshot('t2') })
    expect(again.record.token).toBe(record.token)
    expect(again.record.snapshot.primaryUserUuid).toBe('t')
    expect(s.getByTurn('s', 't')?.token).toBe(record.token)
  })

  it('lists newest first with cursor pagination', async () => {
    const s = await store()
    for (let i = 0; i < 3; i++) s.createOrReuse({ token: newShareToken(), ...base, turnId: `t${i}`, snapshot: snapshot(`t${i}`), createdAtMs: 1000 + i })
    const first = s.list(null, 2)
    expect(first.items.map((x) => x.turnId)).toEqual(['t2', 't1'])
    expect(first.nextCursor).toBe(1001)
    const second = s.list(first.nextCursor === null ? null : Number(first.nextCursor), 2)
    expect(second.items.map((x) => x.turnId)).toEqual(['t0'])
    expect(second.nextCursor).toBeNull()
  })

  it('derives promptPreview, awaySummary and entrypoint from the snapshot in list rows', async () => {
    const s = await store()
    const snap = { primaryUserUuid: 't', entrypoint: 'cli', awaySummary: ' did stuff ', messages: [{ type: 'user', message: { role: 'user', content: 'hello  there' } }] } as never
    s.createOrReuse({ token: newShareToken(), ...base, turnId: 't', snapshot: snap })
    const [row] = s.list(null).items
    expect(row.promptPreview).toBe('hello there')
    expect(row.awaySummary).toBe('did stuff')
    expect(row.entrypoint).toBe('cli')
  })

  it('revokes a token', async () => {
    const s = await store()
    const { record } = s.createOrReuse({ token: newShareToken(), ...base, turnId: 't', snapshot: snapshot('t') })
    expect(s.revoke(record.token)?.token).toBe(record.token)
    expect(s.getByToken(record.token)).toBeNull()
    expect(s.revoke(record.token)).toBeNull()
  })

  it('deletes all shares for a session', async () => {
    const s = await store()
    s.createOrReuse({ token: newShareToken(), ...base, turnId: 't1', snapshot: snapshot('t1') })
    s.createOrReuse({ token: newShareToken(), ...base, turnId: 't2', snapshot: snapshot('t2') })
    s.createOrReuse({ token: newShareToken(), projectId: 'p', sessionId: 'other', assets: [], turnId: 't3', snapshot: snapshot('t3') })
    expect(s.deleteBySession('s')).toHaveLength(2)
    expect(s.list(null).items.map((x) => x.sessionId)).toEqual(['other'])
  })
})
