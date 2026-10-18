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

// device/start returns flowId in its JSON; capture it between calls.
let lastFlowId = ''
async function startFlow(app: Hono, purpose: 'login' | 'stepup' = 'login'): Promise<string> {
  const res = await app.request(`/api/auth/github/device/start${purpose === 'stepup' ? '?purpose=stepup' : ''}`, { method: 'POST' })
  const body = (await res.json()) as { flowId: string }
  lastFlowId = body.flowId
  return body.flowId
}

function sessionCookie(res: Response): string {
  const cookie = res.headers.get('set-cookie')
  if (!cookie) throw new Error('no session cookie issued')
  return cookie.split(';')[0]
}

describe('step-up poll', () => {
  it('rejects without a session', async () => {
    const auth = createAuth({ github: GITHUB })
    const app = new Hono()
    auth.registerRoutes(app)
    mockFetch([{ device_code: 'dc', user_code: 'UC', verification_uri: 'https://gh/login/device', expires_in: 900, interval: 5 }])
    const flowId = await startFlow(app, 'stepup')
    const res = await app.request('/api/auth/github/stepup/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flowId }),
    })
    expect(res.status).toBe(401)
  })

  it('authorizes a matching allowed user and mints a one-time token', async () => {
    const auth = createAuth({ github: GITHUB })
    const app = new Hono()
    auth.registerRoutes(app)
    // login: device start (device code) + poll (access_token, then GET /user)
    mockFetch([{ device_code: 'dc', user_code: 'UC', verification_uri: 'https://gh', expires_in: 900, interval: 5 }, { access_token: 'tok' }, { login: 'imleon', name: 'Leon', avatar_url: null }])
    await startFlow(app)
    const loginRes = await app.request('/api/auth/github/device/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flowId: lastFlowId }),
    })
    const cookie = sessionCookie(loginRes)

    // step-up: fresh device start + poll with the session cookie
    mockFetch([{ device_code: 'dc2', user_code: 'UC2', verification_uri: 'https://gh', expires_in: 900, interval: 5 }, { access_token: 'tok2' }, { login: 'imleon', name: 'Leon', avatar_url: null }])
    await startFlow(app, 'stepup')
    const res = await app.request('/api/auth/github/stepup/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ flowId: lastFlowId }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; stepUpToken: string }
    expect(body.status).toBe('authorized')
    expect(body.stepUpToken).toBeTruthy()
  })

  it('rejects a step-up whose GitHub user differs from the session user', async () => {
    const auth = createAuth({ github: GITHUB })
    const app = new Hono()
    auth.registerRoutes(app)
    mockFetch([{ device_code: 'dc', user_code: 'UC', verification_uri: 'https://gh', expires_in: 900, interval: 5 }, { access_token: 'tok' }, { login: 'imleon', name: 'Leon', avatar_url: null }])
    await startFlow(app)
    const loginRes = await app.request('/api/auth/github/device/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flowId: lastFlowId }),
    })
    const cookie = sessionCookie(loginRes)
    // Allowlist is single-user, so a different GitHub login fails isAllowed first → 403 either way.
    mockFetch([
      { device_code: 'dc2', user_code: 'UC2', verification_uri: 'https://gh', expires_in: 900, interval: 5 },
      { access_token: 'tok2' },
      { login: 'someone-else', name: null, avatar_url: null },
    ])
    await startFlow(app, 'stepup')
    const res = await app.request('/api/auth/github/stepup/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ flowId: lastFlowId }),
    })
    expect(res.status).toBe(403)
  })

  it('does not redeem a flow across purposes', async () => {
    const auth = createAuth({ github: GITHUB })
    const app = new Hono()
    auth.registerRoutes(app)
    mockFetch([{ device_code: 'dc', user_code: 'UC', verification_uri: 'https://gh', expires_in: 900, interval: 5 }, { access_token: 'tok' }, { login: 'imleon', name: 'Leon', avatar_url: null }])
    await startFlow(app)
    const cookie = sessionCookie(await app.request('/api/auth/github/device/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flowId: lastFlowId }) }))

    mockFetch([
      { device_code: 'dc2', user_code: 'UC2', verification_uri: 'https://gh', expires_in: 900, interval: 5 },
      { device_code: 'dc3', user_code: 'UC3', verification_uri: 'https://gh', expires_in: 900, interval: 5 },
    ])
    const loginFlow = await startFlow(app)
    const stepUpFlow = await startFlow(app, 'stepup')
    const poll = (path: string, flowId: string) => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ flowId }) })
    expect((await poll('/api/auth/github/stepup/poll', loginFlow)).status).toBe(400)
    expect((await poll('/api/auth/github/device/poll', stepUpFlow)).status).toBe(400)
  })
})

describe('consumeStepUpToken', () => {
  it('is one-time and bound to the current session user', async () => {
    const auth = createAuth({ github: GITHUB })
    const app = new Hono()
    auth.registerRoutes(app)
    // Probe route to exercise consumeStepUpToken with a real Context.
    app.post('/__probe', (c) => c.json({ ok: auth.consumeStepUpToken(c, c.req.query('t') ?? '') }))

    mockFetch([{ device_code: 'dc', user_code: 'UC', verification_uri: 'https://gh', expires_in: 900, interval: 5 }, { access_token: 'tok' }, { login: 'imleon', name: 'Leon', avatar_url: null }])
    await startFlow(app)
    const loginRes = await app.request('/api/auth/github/device/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flowId: lastFlowId }),
    })
    const cookie = sessionCookie(loginRes)

    mockFetch([{ device_code: 'dc2', user_code: 'UC2', verification_uri: 'https://gh', expires_in: 900, interval: 5 }, { access_token: 'tok2' }, { login: 'imleon', name: 'Leon', avatar_url: null }])
    await startFlow(app, 'stepup')
    const stepRes = await app.request('/api/auth/github/stepup/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ flowId: lastFlowId }),
    })
    const token = ((await stepRes.json()) as { stepUpToken: string }).stepUpToken

    // Wrong token → false.
    expect((await (await app.request('/__probe?t=nope', { method: 'POST', headers: { Cookie: cookie } })).json()).ok).toBe(false)
    // Valid, bound to session user → true once.
    expect((await (await app.request(`/__probe?t=${token}`, { method: 'POST', headers: { Cookie: cookie } })).json()).ok).toBe(true)
    // Second use of the same token → false (consumed).
    expect((await (await app.request(`/__probe?t=${token}`, { method: 'POST', headers: { Cookie: cookie } })).json()).ok).toBe(false)
    // No session → false.
    expect((await (await app.request(`/__probe?t=${token}`, { method: 'POST' })).json()).ok).toBe(false)
  })
})
