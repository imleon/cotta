import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCottaDatabase, shareAssetsRoot } from '../database.js'
import { encodeDetailToken } from '../detail-token.js'
import { ShareStore } from '../share-store.js'
import { createTestApp, project, type TimestampedSessionMessage } from './project-routes-test-helpers.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex')
const key = randomBytes(32)
const root = project.path!

// Assistant for turn user-2 references a local image resolvable under the project root.
const imageMessages: TimestampedSessionMessage[] = [
  { type: 'user', uuid: 'user-2', session_id: 'session-newest', parent_tool_use_id: null, parent_agent_id: null, timestamp: '2026-07-14T08:01:00.000Z', message: { role: 'user', content: 'go' } },
  {
    type: 'assistant',
    uuid: 'assistant-2',
    session_id: 'session-newest',
    parent_tool_use_id: null,
    parent_agent_id: null,
    timestamp: '2026-07-14T08:01:15.000Z',
    cwd: root,
    message: { id: 'm2', type: 'message', role: 'assistant', content: [{ type: 'text', text: '![s](s-share.png) ![x](m-share.png)' }] },
  } as unknown as TimestampedSessionMessage,
]

const eligible = async () => ({ turnMetadata: new Map([['user-2', { durationMs: 1, durationTimestampMs: 1 }]]), turnOptions: { permissionMode: null, model: null, effort: null } })
const liveStates = { 'session-newest': { phase: 'idle' as const, activeUserMessageUuid: null, lastTurn: { id: 'user-2', outcome: 'success' as const } } }
const detailToken = encodeDetailToken({ projectId: project.id, sessionId: 'session-newest', turnId: 'user-2' }, key)

const dbRoots: string[] = []
async function appWithShares() {
  const dbRoot = await mkdtemp(join(tmpdir(), 'cotta-share-asset-'))
  dbRoots.push(dbRoot)
  const shareStore = new ShareStore(createCottaDatabase(join(dbRoot, 'cotta.sqlite')))
  const app = createTestApp(liveStates, imageMessages, { detailTokenKey: key, shareStore, timelineMetadataReader: eligible })
  return { app, shareStore }
}
const create = (app: Awaited<ReturnType<typeof appWithShares>>['app']) =>
  app.request('/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ detailToken }) })

beforeEach(async () => {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 's-share.png'), PNG)
})
afterEach(async () => {
  await rm(join(root, 's-share.png'), { force: true })
  await Promise.all(dbRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

describe('share asset materialization', () => {
  it('freezes referenced images under opaque keys, placeholdering the unresolvable one, and sanitizes the snapshot', async () => {
    const { app, shareStore } = await appWithShares()
    const { token } = (await (await create(app)).json()) as { token: string }
    const record = shareStore.getByToken(token)!
    expect(record.assets).toEqual([
      { src: 'cotta-asset/0', file: '0.png' },
      { src: 'cotta-asset/1', file: null },
    ])
    // The sanitized snapshot carries only the opaque keys — no local-image path and no cwd leaks into the public response.
    const snapshotText = JSON.stringify(record.snapshot)
    expect(snapshotText).not.toContain('s-share.png')
    expect(snapshotText).not.toContain('m-share.png')
    expect(snapshotText).not.toContain(root)
    expect(record.snapshot.responseCwd).toBeUndefined()
    expect(record.snapshot.userCwd).toBeUndefined()
    expect(snapshotText).toContain('cotta-asset/0')
    expect(snapshotText).toContain('cotta-asset/1')

    const hit = await app.request(`/api/share/${token}/asset?src=${encodeURIComponent('cotta-asset/0')}`)
    expect(hit.status).toBe(200)
    expect(hit.headers.get('Content-Type')).toBe('image/png')
    expect(hit.headers.get('Cache-Control')).toContain('immutable')
    expect(Buffer.from(await hit.arrayBuffer()).equals(PNG)).toBe(true)

    const placeholder = await app.request(`/api/share/${token}/asset?src=${encodeURIComponent('cotta-asset/1')}`)
    expect(placeholder.status).toBe(404)
    const unknown = await app.request(`/api/share/${token}/asset?src=other.png`)
    expect(unknown.status).toBe(404)
  })

  it('keeps the snapshot immutable: deleting the source file does not break a frozen share', async () => {
    const { app } = await appWithShares()
    const { token } = (await (await create(app)).json()) as { token: string }
    await rm(join(root, 's-share.png'), { force: true })
    const hit = await app.request(`/api/share/${token}/asset?src=${encodeURIComponent('cotta-asset/0')}`)
    expect(hit.status).toBe(200)
  })

  it('does not re-materialize when a share is reused', async () => {
    const { app, shareStore } = await appWithShares()
    const { token } = (await (await create(app)).json()) as { token: string }
    const assetDir = shareAssetsRoot(token)
    await rm(assetDir, { recursive: true, force: true })
    const again = (await (await create(app)).json()) as { token: string }
    expect(again.token).toBe(token)
    expect(existsSync(assetDir)).toBe(false) // reuse skipped materialization
    expect(shareStore.getByToken(token)!.assets).toHaveLength(2)
  })

  it('materializes the asset directory under the database directory so lifecycle cleanup can find it', async () => {
    const { app } = await appWithShares()
    const { token } = (await (await create(app)).json()) as { token: string }
    const assetDir = shareAssetsRoot(token)
    expect(existsSync(assetDir)).toBe(true)
    expect(existsSync(join(assetDir, '0.png'))).toBe(true)
  })
})
