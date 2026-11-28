import { randomBytes } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeDetailToken } from '../detail-token.js'
import { createTestApp, project, type TimestampedSessionMessage } from './project-routes-test-helpers.js'

// Minimal valid 1x1 PNG.
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex')
const key = randomBytes(32)
const root = project.path!

const messagesWith = (text: string): TimestampedSessionMessage[] => [
  { type: 'user', uuid: 'user-1', session_id: 'session-newest', parent_tool_use_id: null, parent_agent_id: null, timestamp: '2026-07-14T08:00:00.000Z', message: { role: 'user', content: 'go' } },
  {
    type: 'assistant',
    uuid: 'assistant-1',
    session_id: 'session-newest',
    parent_tool_use_id: null,
    parent_agent_id: null,
    timestamp: '2026-07-14T08:00:10.000Z',
    cwd: root,
    message: { id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'text', text }] },
  } as unknown as TimestampedSessionMessage,
]

beforeEach(async () => {
  await mkdir(join(root, 'sub'), { recursive: true })
  await writeFile(join(root, 'shot.png'), PNG)
  await writeFile(join(root, 'sub', 'nested.png'), PNG)
})
afterEach(async () => {
  await rm(join(root, 'shot.png'), { force: true })
  await rm(join(root, 'sub'), { recursive: true, force: true })
})

describe('detail asset endpoint', () => {
  const token = (turnId = 'user-1') => encodeDetailToken({ projectId: project.id, sessionId: 'session-newest', turnId }, key)
  const app = (text: string) => createTestApp({}, messagesWith(text), { detailTokenKey: key })

  it('serves bytes for an in-turn in-project image', async () => {
    const response = await app('![s](shot.png)').request(`/api/detail/${token()}/asset?src=shot.png`)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true)
  })

  it('is unavailable for a src the turn does not reference', async () => {
    const response = await app('![s](shot.png)').request(`/api/detail/${token()}/asset?src=sub/nested.png`)
    expect(response.status).toBe(404)
  })

  it('requires confirmation for an out-of-project image, then serves it', async () => {
    await writeFile('/tmp/outside.png', PNG)
    const detail = app('![s](/tmp/outside.png)')
    const url = `/api/detail/${token()}/asset?src=${encodeURIComponent('/tmp/outside.png')}`
    const probe = await detail.request(url)
    expect(probe.status).toBe(409)
    expect(await probe.json()).toEqual({ error: 'image_confirmation_required' })
    const confirmed = await detail.request(`${url}&confirmed=1`)
    expect(confirmed.status).toBe(200)
    expect(Buffer.from(await confirmed.arrayBuffer()).equals(PNG)).toBe(true)
    await rm('/tmp/outside.png', { force: true })
  })

  it('stays unavailable for an unreferenced src even when confirmed', async () => {
    const response = await app('![s](shot.png)').request(`/api/detail/${token()}/asset?src=sub/nested.png&confirmed=1`)
    expect(response.status).toBe(404)
  })

  it('is unavailable for a forged token', async () => {
    const forged = token()
    const response = await app('![s](shot.png)').request(`/api/detail/${forged.slice(0, -2)}XX/asset?src=shot.png`)
    expect(response.status).toBe(404)
  })
})
