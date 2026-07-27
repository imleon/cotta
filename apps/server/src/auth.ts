import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Context, Hono, Next } from 'hono'
import type { AuthUser } from '@cotta/shared'
import type { SettingsStore } from './settings-store.js'

const SESSION_COOKIE = 'cotta_session'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const SESSION_MAX_AGE_SECONDS = SESSION_TTL_MS / 1000

type Session = {
  user: AuthUser
  expiresAt: number
}

type DeviceFlow = {
  deviceCode: string
  expiresAt: number
  interval: number
}

type GitHubAuthConfig = {
  clientId?: string
  allowedUsers?: string
  allowedOrgs?: string
  allowedTeams?: string
  sessionSecret?: string
  cookieSecure?: string
}

function splitList(value: string | undefined): string[] {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? []
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

function randomId(): string {
  return base64Url(randomBytes(32))
}

function safeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a)
  const bBuffer = Buffer.from(b)
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer)
}

function githubHeaders(accessToken: string): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': 'cotta',
  }
}

function cookieSecure(c: Context, override?: string): boolean {
  return override === 'true' || new URL(c.req.url).protocol === 'https:'
}

export type CottaAuth = ReturnType<typeof createAuth>

export function createAuth(input: { github?: GitHubAuthConfig; settingsStore?: SettingsStore } = {}) {
  const sessions = new Map<string, Session>()
  const deviceFlows = new Map<string, DeviceFlow>()
  const sessionSecret = input.github?.sessionSecret || process.env.COTTA_SESSION_SECRET || randomId()
  const githubClientId = input.github?.clientId ?? process.env.COTTA_GITHUB_CLIENT_ID
  const allowedUsers = splitList(input.github?.allowedUsers ?? process.env.COTTA_GITHUB_ALLOWED_USERS).map((user) => user.toLowerCase())
  const allowedOrgs = splitList(input.github?.allowedOrgs ?? process.env.COTTA_GITHUB_ALLOWED_ORGS)
  const allowedTeams = splitList(input.github?.allowedTeams ?? process.env.COTTA_GITHUB_ALLOWED_TEAMS)
  const cookieSecureOverride = input.github?.cookieSecure ?? process.env.COTTA_COOKIE_SECURE

  function getSession(sessionId: string): Session | null {
    return input.settingsStore?.getAuthSession(sessionId) ?? sessions.get(sessionId) ?? null
  }

  function setSession(sessionId: string, session: Session): void {
    if (input.settingsStore) input.settingsStore.setAuthSession(sessionId, session)
    else sessions.set(sessionId, session)
  }

  function deleteSession(sessionId: string): void {
    if (input.settingsStore) input.settingsStore.deleteAuthSession(sessionId)
    else sessions.delete(sessionId)
  }

  function sign(sessionId: string): string {
    return base64Url(createHmac('sha256', sessionSecret).update(sessionId).digest())
  }

  function sessionIdFromCookie(c: Context): string | null {
    const value = getCookie(c, SESSION_COOKIE)
    if (!value) return null
    const [sessionId, signature] = value.split('.')
    if (!sessionId || !signature || !safeEqual(signature, sign(sessionId))) return null
    return sessionId
  }

  function currentUser(c: Context): AuthUser | null {
    const sessionId = sessionIdFromCookie(c)
    if (!sessionId) return null
    const session = getSession(sessionId)
    if (!session || session.expiresAt <= Date.now()) {
      deleteSession(sessionId)
      return null
    }
    return session.user
  }

  function setSessionCookie(c: Context, user: AuthUser): void {
    const sessionId = randomId()
    setSession(sessionId, { user, expiresAt: Date.now() + SESSION_TTL_MS })
    setCookie(c, SESSION_COOKIE, `${sessionId}.${sign(sessionId)}`, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_MAX_AGE_SECONDS,
      secure: cookieSecure(c, cookieSecureOverride),
    })
  }

  function clearSessionCookie(c: Context): void {
    const sessionId = sessionIdFromCookie(c)
    if (sessionId) deleteSession(sessionId)
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
  }

  const middleware = async (c: Context, next: Next) => {
    if (!githubClientId || c.req.path === '/api/health' || c.req.path.startsWith('/api/auth/')) {
      await next()
      return
    }
    if (currentUser(c)) {
      await next()
      return
    }
    return c.json({ error: 'unauthorized' }, 401)
  }

  async function githubJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await fetch(url, init)
    return await response.json() as Record<string, unknown>
  }

  async function fetchGitHubUser(accessToken: string): Promise<AuthUser> {
    const body = await githubJson('https://api.github.com/user', { headers: githubHeaders(accessToken) })
    return {
      login: String(body.login ?? ''),
      name: typeof body.name === 'string' ? body.name : null,
      avatarUrl: typeof body.avatar_url === 'string' ? body.avatar_url : null,
    }
  }

  async function hasActiveOrgMembership(accessToken: string, org: string): Promise<boolean> {
    const response = await fetch(`https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`, { headers: githubHeaders(accessToken) })
    if (!response.ok) return false
    const body = await response.json() as { state?: string }
    return body.state === 'active'
  }

  async function hasActiveTeamMembership(accessToken: string, team: string, login: string): Promise<boolean> {
    const [org, teamSlug] = team.split('/')
    if (!org || !teamSlug) return false
    const response = await fetch(`https://api.github.com/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}/memberships/${encodeURIComponent(login)}`, { headers: githubHeaders(accessToken) })
    if (!response.ok) return false
    const body = await response.json() as { state?: string }
    return body.state === 'active'
  }

  async function isAllowed(accessToken: string, user: AuthUser): Promise<boolean | 'not_configured'> {
    if (!allowedUsers.length && !allowedOrgs.length && !allowedTeams.length) return 'not_configured'
    if (allowedUsers.includes(user.login.toLowerCase())) return true
    for (const org of allowedOrgs) if (await hasActiveOrgMembership(accessToken, org)) return true
    for (const team of allowedTeams) if (await hasActiveTeamMembership(accessToken, team, user.login)) return true
    return false
  }

  function registerRoutes(app: Hono): void {
    app.get('/api/auth/session', (c) => {
      const user = currentUser(c)
      return c.json({
        authenticated: Boolean(user),
        user,
        githubConfigured: Boolean(githubClientId),
      })
    })

    app.post('/api/auth/github/device/start', async (c) => {
      if (!githubClientId) return c.json({ error: 'github_login_not_configured' }, 400)
      const scope = ['read:user', ...(allowedOrgs.length || allowedTeams.length ? ['read:org'] : [])].join(' ')
      const body = await githubJson('https://github.com/login/device/code', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: githubClientId, scope }),
      })
      if (typeof body.device_code !== 'string' || typeof body.user_code !== 'string' || typeof body.verification_uri !== 'string') {
        return c.json({ error: 'github_device_start_failed' }, 502)
      }
      const flowId = randomId()
      const expiresIn = Number(body.expires_in ?? 900)
      const interval = Number(body.interval ?? 5)
      deviceFlows.set(flowId, { deviceCode: body.device_code, expiresAt: Date.now() + expiresIn * 1000, interval })
      return c.json({
        flowId,
        userCode: body.user_code,
        verificationUri: body.verification_uri,
        verificationUriComplete: typeof body.verification_uri_complete === 'string' ? body.verification_uri_complete : undefined,
        expiresIn,
        interval,
      })
    })

    app.post('/api/auth/github/device/poll', async (c) => {
      if (!githubClientId) return c.json({ error: 'github_login_not_configured' }, 400)
      const { flowId } = await c.req.json() as { flowId?: string }
      const flow = flowId ? deviceFlows.get(flowId) : null
      if (!flow || flow.expiresAt <= Date.now()) return c.json({ error: 'expired_token' }, 400)
      const body = await githubJson('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: githubClientId, device_code: flow.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
      })
      if (body.error === 'authorization_pending') return c.json({ status: 'pending', interval: flow.interval }, 202)
      if (body.error === 'slow_down') {
        flow.interval += 5
        return c.json({ status: 'slow_down', interval: flow.interval }, 202)
      }
      if (body.error === 'access_denied') return c.json({ error: 'access_denied' }, 403)
      if (body.error === 'expired_token') return c.json({ error: 'expired_token' }, 400)
      if (typeof body.access_token !== 'string') return c.json({ error: 'github_device_poll_failed' }, 502)
      const user = await fetchGitHubUser(body.access_token)
      const allowed = await isAllowed(body.access_token, user)
      if (allowed === 'not_configured') return c.json({ error: 'authorization_not_configured' }, 403)
      if (!allowed) return c.json({ error: 'forbidden' }, 403)
      deviceFlows.delete(flowId!)
      setSessionCookie(c, user)
      return c.json({ status: 'authorized', user })
    })

    app.post('/api/auth/logout', (c) => {
      clearSessionCookie(c)
      return c.json({ ok: true })
    })
  }

  return { middleware, registerRoutes, currentUser }
}
