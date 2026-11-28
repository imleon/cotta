import { randomBytes } from 'node:crypto'
import { detailResponseSchema } from '@cotta/shared'
import { describe, expect, it } from 'vitest'
import { encodeDetailToken } from '../detail-token.js'
import { createTestApp, memorySettingsStore, messages, project } from './project-routes-test-helpers.js'

const key = randomBytes(32)

function token(turnId: string, overrides: { projectId?: string; sessionId?: string } = {}) {
  return encodeDetailToken({ projectId: overrides.projectId ?? project.id, sessionId: overrides.sessionId ?? 'session-newest', turnId }, key)
}

describe('detail routes', () => {
  it('returns the single targeted turn for a valid token', async () => {
    const response = await createTestApp({}, messages, { detailTokenKey: key }).request(`/api/detail/${token('user-1')}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const body = detailResponseSchema.parse(await response.json())
    expect(body.turn.primaryUserUuid).toBe('user-1')
  })

  it('does not leak project/session/activity fields', async () => {
    const response = await createTestApp({}, messages, { detailTokenKey: key }).request(`/api/detail/${token('user-1')}`)
    const body = (await response.json()) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['turn'])
    expect(JSON.stringify(body)).not.toContain(project.id)
  })

  it('returns an indistinguishable unavailable response for malformed, forged, and unknown-turn tokens', async () => {
    const app = createTestApp({}, messages, { detailTokenKey: key })
    const forged = token('user-1')
    const tampered = `${forged.slice(0, -2)}${forged.slice(-2) === 'AA' ? 'BB' : 'AA'}`
    for (const value of ['not-a-token', tampered, token('turn-does-not-exist'), token('user-1', { sessionId: 'missing' })]) {
      const response = await app.request(`/api/detail/${value}`)
      expect(response.status).toBe(404)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(await response.json()).toEqual({ error: 'detail_unavailable' })
    }
  })

  it('is unavailable when no instance key is configured', async () => {
    const response = await createTestApp({}, messages).request(`/api/detail/${token('user-1')}`)
    expect(response.status).toBe(404)
  })

  it('is unavailable when sharing is off (no public base URL configured)', async () => {
    const app = createTestApp({}, messages, { detailTokenKey: key, settingsStore: memorySettingsStore() } as never)
    const response = await app.request(`/api/detail/${token('user-1')}`)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'detail_unavailable' })
  })
})
