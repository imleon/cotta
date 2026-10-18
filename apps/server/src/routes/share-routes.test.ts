import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCottaDatabase } from '../database.js'
import { encodeDetailToken } from '../detail-token.js'
import { ShareStore } from '../share-store.js'
import { createTestApp, memorySettingsStore, messages, project } from './project-routes-test-helpers.js'

const key = randomBytes(32)

async function appWithShares() {
  const root = await mkdtemp(join(tmpdir(), 'cotta-share-routes-'))
  const shareStore = new ShareStore(createCottaDatabase(join(root, 'cotta.sqlite')))
  const liveStates = { 'session-newest': { phase: 'idle' as const, activeUserMessageUuid: null, lastTurn: { id: 'user-2', outcome: 'success' as const } } }
  // durationMs gives the turn terminal evidence → shareEligible.
  const timelineMetadataReader = async () => ({
    turnMetadata: new Map([
      ['user-1', { durationMs: 9_999, durationTimestampMs: 1_752_470_400_000 }],
      ['user-2', { durationMs: 12_345, durationTimestampMs: 1_752_470_490_000 }],
    ]),
    turnOptions: { permissionMode: null, model: null, effort: null },
  })
  const app = createTestApp(liveStates, messages, { detailTokenKey: key, shareStore, timelineMetadataReader })
  return { app, shareStore, cleanup: () => rm(root, { recursive: true, force: true }) }
}

const detailToken = (turnId: string) => encodeDetailToken({ projectId: project.id, sessionId: 'session-newest', turnId }, key)

describe('share routes', () => {
  it('creates a share for an eligible turn and reads the snapshot back', async () => {
    const { app, cleanup } = await appWithShares()
    try {
      const create = await app.request('/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ detailToken: detailToken('user-2') }) })
      expect(create.status).toBe(200)
      const { token } = (await create.json()) as { token: string }
      expect(token).toBeTruthy()

      const read = await app.request(`/api/share/${token}`)
      expect(read.status).toBe(200)
      expect(read.headers.get('Cache-Control')).toBe('no-store')
      const body = (await read.json()) as { turn: { primaryUserUuid: string } }
      expect(body.turn.primaryUserUuid).toBe('user-2')
    } finally {
      await cleanup()
    }
  })

  it('reuses the same token on repeat create', async () => {
    const { app, cleanup } = await appWithShares()
    try {
      const first = (await (
        await app.request('/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ detailToken: detailToken('user-2') }) })
      ).json()) as { token: string }
      const second = (await (
        await app.request('/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ detailToken: detailToken('user-2') }) })
      ).json()) as { token: string }
      expect(second.token).toBe(first.token)
    } finally {
      await cleanup()
    }
  })

  it('rejects create for a non-eligible turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cotta-share-routes-'))
    const shareStore = new ShareStore(createCottaDatabase(join(root, 'cotta.sqlite')))
    // running turn → not eligible (no idle run state)
    const app = createTestApp({ 'session-newest': { phase: 'running', activeUserMessageUuid: 'user-2' } }, messages, { detailTokenKey: key, shareStore })
    try {
      const create = await app.request('/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ detailToken: detailToken('user-2') }) })
      expect(create.status).toBe(409)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns indistinguishable unavailable for unknown/revoked tokens', async () => {
    const { app, cleanup } = await appWithShares()
    try {
      const unknown = await app.request('/api/share/does-not-exist')
      expect(unknown.status).toBe(404)
      expect(await unknown.json()).toEqual({ error: 'share_unavailable' })
      expect(unknown.headers.get('Cache-Control')).toBe('no-store')
    } finally {
      await cleanup()
    }
  })

  it('creates a share for a settled historical turn (not the session latest)', async () => {
    const { app, cleanup } = await appWithShares()
    try {
      // user-1 is an older turn with user-2 after it; it is settled (has durationMs) so it is shareable.
      const create = await app.request('/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ detailToken: detailToken('user-1') }) })
      expect(create.status).toBe(200)
      const { token } = (await create.json()) as { token: string }
      const read = await app.request(`/api/share/${token}`)
      expect(((await read.json()) as { turn: { primaryUserUuid: string } }).turn.primaryUserUuid).toBe('user-1')
    } finally {
      await cleanup()
    }
  })

  it('rejects create when sharing is off (no public base URL configured)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cotta-share-routes-'))
    const shareStore = new ShareStore(createCottaDatabase(join(root, 'cotta.sqlite')))
    const liveStates = { 'session-newest': { phase: 'idle' as const, activeUserMessageUuid: null, lastTurn: { id: 'user-2', outcome: 'success' as const } } }
    const timelineMetadataReader = async () => ({
      turnMetadata: new Map([['user-2', { durationMs: 12_345, durationTimestampMs: 1_752_470_490_000 }]]),
      turnOptions: { permissionMode: null, model: null, effort: null },
    })
    const app = createTestApp(liveStates, messages, { detailTokenKey: key, shareStore, timelineMetadataReader, settingsStore: memorySettingsStore() } as never)
    try {
      const create = await app.request('/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ detailToken: detailToken('user-2') }) })
      expect(create.status).toBe(403)
      expect(await create.json()).toEqual({ error: 'sharing_disabled' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('suspends access to an existing share when sharing is turned off', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cotta-share-routes-'))
    const shareStore = new ShareStore(createCottaDatabase(join(root, 'cotta.sqlite')))
    const liveStates = { 'session-newest': { phase: 'idle' as const, activeUserMessageUuid: null, lastTurn: { id: 'user-2', outcome: 'success' as const } } }
    const timelineMetadataReader = async () => ({
      turnMetadata: new Map([['user-2', { durationMs: 12_345, durationTimestampMs: 1_752_470_490_000 }]]),
      turnOptions: { permissionMode: null, model: null, effort: null },
    })
    try {
      const enabled = createTestApp(liveStates, messages, { detailTokenKey: key, shareStore, timelineMetadataReader })
      const create = await enabled.request('/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ detailToken: detailToken('user-2') }) })
      expect(create.status).toBe(200)
      const { token } = (await create.json()) as { token: string }
      expect((await enabled.request(`/api/share/${token}`)).status).toBe(200)

      // Same store, sharing now off → the already-shared page is suspended, not deleted.
      const disabled = createTestApp(liveStates, messages, { detailTokenKey: key, shareStore, timelineMetadataReader, settingsStore: memorySettingsStore() } as never)
      const read = await disabled.request(`/api/share/${token}`)
      expect(read.status).toBe(404)
      expect(await read.json()).toEqual({ error: 'share_unavailable' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
