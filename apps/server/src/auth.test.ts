import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuth } from './auth.js'

const GITHUB = { allowedUsers: 'imleon', sessionSecret: 'test-secret' }

/** Queue of fetch responses; each GitHub call shifts one. */
function mockFetch(responses: Array<Record<string, unknown>>) {
  const spy = vi.fn(async () => {
    const body = responses.shift() ?? {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(() => vi.unstubAllGlobals())

function sessionCookie(res: Response): string {
  const cookie = res.headers.get('set-cookie')
  if (!cookie) throw new Error('no session cookie issued')
  return cookie.split(';')[0]
}

describe('device login', () => {
  it('authorizes an allowed user and issues a session cookie', async () => {
    const auth = createAuth({ github: GITHUB })
    const app = new Hono()
    auth.registerRoutes(app)
    mockFetch([{ device_code: 'dc', user_code: 'UC', verification_uri: 'https://gh', expires_in: 900, interval: 5 }, { access_token: 'tok' }, { login: 'imleon', name: 'Leon', avatar_url: null }])

    const start = await app.request('/api/auth/github/device/start', { method: 'POST' })
    const { flowId } = (await start.json()) as { flowId: string }
    const res = await app.request('/api/auth/github/device/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flowId }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as { status: string }).toMatchObject({ status: 'authorized' })
    expect(sessionCookie(res)).toContain('cotta_session=')
  })

  it('rejects a GitHub user outside the allowlist', async () => {
    const auth = createAuth({ github: GITHUB })
    const app = new Hono()
    auth.registerRoutes(app)
    mockFetch([{ device_code: 'dc', user_code: 'UC', verification_uri: 'https://gh', expires_in: 900, interval: 5 }, { access_token: 'tok' }, { login: 'someone-else', name: null, avatar_url: null }])

    const start = await app.request('/api/auth/github/device/start', { method: 'POST' })
    const { flowId } = (await start.json()) as { flowId: string }
    const res = await app.request('/api/auth/github/device/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flowId }),
    })
    expect(res.status).toBe(403)
  })
})
