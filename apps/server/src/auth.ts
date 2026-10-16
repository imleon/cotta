import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { type AuthUser, isSingleUser, normalizeAllowedUser } from '@cotta/shared'
import type { Context, Hono, Next } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { SettingsStore } from './settings-store.js'

const SESSION_COOKIE = 'cotta_session'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const SESSION_MAX_AGE_SECONDS = SESSION_TTL_MS / 1000
const SESSION_RENEW_THRESHOLD_MS = 24 * 60 * 60 * 1000
const GITHUB_RETRY_DELAYS_MS = [500, 1000]

type Session = {
  user: AuthUser
  expiresAt: number
}

type DeviceFlow = {
  clientId: string
  deviceCode: string
  expiresAt: number
  interval: number
}

type GitHubAuthConfig = {
  clientId?: string
  allowedUsers?: string
  sessionSecret?: string
  cookieSecure?: string
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

class GitHubRequestError extends Error {}

function loadSessionSecret(store: SettingsStore): string {
  const existing = store.getAll('secrets').sessionSecret
  if (typeof existing === 'string' && existing) return existing
  const secret = randomBytes(32).toString('base64')
  store.setMany('secrets', { sessionSecret: secret })
  return secret
}

/** GitHub login config lives in the private 'secrets' scope (never reaches the client via readSettings). */
export function loadGithubConfig(store: SettingsStore): { clientId: string | null; allowedUsers: string | null } {
  const secrets = store.getAll('secrets')
  return {
    clientId: typeof secrets.githubClientId === 'string' && secrets.githubClientId ? secrets.githubClientId : null,
    allowedUsers: typeof secrets.githubAllowedUsers === 'string' && secrets.githubAllowedUsers ? secrets.githubAllowedUsers : null,
  }
}

export function saveGithubConfig(store: SettingsStore, config: { clientId: string; allowedUsers: string }): void {
  // The allowed login is the whole security boundary: whenever it changes, every stored auth session
  // (snapshotted at login) becomes stale and is revoked atomically with the config write. Connections
  // already established (terminal WebSocket, SSE streams) were authorized at open and are not torn down.
  const allowedUserChanged = normalizeAllowedUser(loadGithubConfig(store).allowedUsers) !== normalizeAllowedUser(config.allowedUsers)
  store.setMany('secrets', { githubClientId: config.clientId, githubAllowedUsers: config.allowedUsers }, { clearAuthSessions: allowedUserChanged })
}

export type CottaAuth = ReturnType<typeof createAuth>

/** Pass-through auth for tests whose subject is not access control. */
export function noopAuth(): CottaAuth {
  return {
    middleware: async (_c: Context, next: Next) => {
      await next()
      return undefined
    },
    registerRoutes: () => {},
    currentUser: () => null,
    terminalAuthorized: () => true,
  }
}

export function createAuth(input: { github?: GitHubAuthConfig; settingsStore?: SettingsStore } = {}) {
  const sessions = new Map<string, Session>()
  const deviceFlows = new Map<string, DeviceFlow>()
  const cookieSecureOverride = input.github?.cookieSecure ?? process.env.COTTA_COOKIE_SECURE

  // Read GitHub config fresh on every use so Settings-UI edits take effect without a restart.
  // The explicit `input.github` wins (tests / direct injection); otherwise the store is the source of truth.
  function currentGithubConfig(): { clientId: string | null; allowedUser: string | null } {
    const stored = input.settingsStore ? loadGithubConfig(input.settingsStore) : { clientId: null, allowedUsers: null }
    const clientId = input.github?.clientId ?? stored.clientId ?? null
    const allowedUser = normalizeAllowedUser(input.github?.allowedUsers ?? stored.allowedUsers)
    return { clientId, allowedUser }
  }

  const startupConfig = currentGithubConfig()
  if (!startupConfig.clientId) throw new Error('GitHub client id is required')
  if (!isSingleUser(startupConfig.allowedUser)) throw new Error('GitHub login requires exactly one allowed user')
  const resolvedSecret = input.github?.sessionSecret ?? (input.settingsStore ? loadSessionSecret(input.settingsStore) : undefined)
  if (!resolvedSecret) throw new Error('session secret unavailable: provide settingsStore or github.sessionSecret')
  const sessionSecret: string = resolvedSecret

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
    const lastRenewedAt = session.expiresAt - SESSION_TTL_MS
    if (Date.now() - lastRenewedAt >= SESSION_RENEW_THRESHOLD_MS) renewSession(c, sessionId, session.user)
    return session.user
  }

  function writeSessionCookie(c: Context, sessionId: string): void {
    // Touch c.res so Hono instantiates its Response object before we set the cookie. Otherwise the
    // renewal Set-Cookie lands only in #preparedHeaders, which is discarded when a handler returns a
    // bare `new Response(stream, …)` (SSE endpoints) — the sliding session would never renew for
    // clients whose only long-lived traffic is a stream.
    void c.res
    setCookie(c, SESSION_COOKIE, `${sessionId}.${sign(sessionId)}`, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_MAX_AGE_SECONDS,
      secure: cookieSecure(c, cookieSecureOverride),
    })
  }

  function renewSession(c: Context, sessionId: string, user: AuthUser): void {
    setSession(sessionId, { user, expiresAt: Date.now() + SESSION_TTL_MS })
    writeSessionCookie(c, sessionId)
  }

  function setSessionCookie(c: Context, user: AuthUser): void {
    const sessionId = randomId()
    setSession(sessionId, { user, expiresAt: Date.now() + SESSION_TTL_MS })
    writeSessionCookie(c, sessionId)
  }

  function clearSessionCookie(c: Context): void {
    const sessionId = sessionIdFromCookie(c)
    if (sessionId) deleteSession(sessionId)
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
  }

  const middleware = async (c: Context, next: Next) => {
    // Anonymous token-scoped surfaces are exempt in every deployment mode; the token itself is the capability.
    // Share GET/create are anonymous; share management (/api/shares, /revoke) stays gated below.
    if (
      c.req.path.startsWith('/api/detail/') ||
      c.req.path.startsWith('/detail/') ||
      c.req.path.startsWith('/share/') ||
      c.req.path === '/api/share' ||
      (c.req.path.startsWith('/api/share/') && !c.req.path.endsWith('/revoke'))
    ) {
      await next()
      return
    }
    if (c.req.path === '/api/health' || c.req.path.startsWith('/api/auth/')) {
      await next()
      return
    }
    if (currentUser(c)) {
      await next()
      return
    }
    return c.json({ error: 'unauthorized' }, 401)
  }

  async function githubResponse(url: string, init: RequestInit): Promise<Response> {
    let lastError: unknown
    for (const delayMs of [0, ...GITHUB_RETRY_DELAYS_MS]) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
      try {
        return await fetch(url, init)
      } catch (error) {
        lastError = error
      }
    }
    throw new GitHubRequestError('github_request_failed', { cause: lastError })
  }

  async function githubResponseJson(response: Response): Promise<Record<string, unknown>> {
    try {
      return (await response.json()) as Record<string, unknown>
    } catch (error) {
      throw new GitHubRequestError('github_invalid_json', { cause: error })
    }
  }

  async function githubJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    return githubResponseJson(await githubResponse(url, init))
  }

  async function fetchGitHubUser(accessToken: string): Promise<AuthUser> {
    const body = await githubJson('https://api.github.com/user', { headers: githubHeaders(accessToken) })
    return {
      login: String(body.login ?? ''),
      name: typeof body.name === 'string' ? body.name : null,
      avatarUrl: typeof body.avatar_url === 'string' ? body.avatar_url : null,
    }
  }

  function isAllowed(user: AuthUser): boolean {
    const allowedUser = currentGithubConfig().allowedUser
    return allowedUser !== null && allowedUser === normalizeAllowedUser(user.login)
  }

  function cleanupExpiredFlows(): void {
    const now = Date.now()
    for (const [id, flow] of deviceFlows) if (flow.expiresAt <= now) deviceFlows.delete(id)
  }

  function registerRoutes(app: Hono): void {
    app.get('/api/auth/session', (c) => {
      const user = currentUser(c)
      return c.json({
        authenticated: Boolean(user),
        user,
        githubConfigured: true,
      })
    })

    app.post('/api/auth/github/device/start', async (c) => {
      try {
        cleanupExpiredFlows()
        const clientId = currentGithubConfig().clientId
        if (!clientId) return c.json({ error: 'github_not_configured' }, 502)
        const scope = 'read:user'
        const body = await githubJson('https://github.com/login/device/code', {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: clientId, scope }),
        })
        if (typeof body.device_code !== 'string' || typeof body.user_code !== 'string' || typeof body.verification_uri !== 'string') {
          return c.json({ error: 'github_device_start_failed' }, 502)
        }
        const flowId = randomId()
        const expiresIn = Number(body.expires_in ?? 900)
        const interval = Number(body.interval ?? 5)
        deviceFlows.set(flowId, { clientId, deviceCode: body.device_code, expiresAt: Date.now() + expiresIn * 1000, interval })
        return c.json({
          flowId,
          userCode: body.user_code,
          verificationUri: body.verification_uri,
          verificationUriComplete: typeof body.verification_uri_complete === 'string' ? body.verification_uri_complete : undefined,
          expiresIn,
          interval,
        })
      } catch (error) {
        if (error instanceof GitHubRequestError) return c.json({ error: error.message }, 502)
        throw error
      }
    })

    app.post('/api/auth/github/device/poll', async (c) => {
      try {
        cleanupExpiredFlows()
        const parsed = (await c.req.json().catch(() => null)) as { flowId?: string } | null
        if (!parsed || typeof parsed.flowId !== 'string') return c.json({ error: 'invalid_request' }, 400)
        const flowId = parsed.flowId
        const flow = deviceFlows.get(flowId)
        if (!flow || flow.expiresAt <= Date.now()) {
          deviceFlows.delete(flowId)
          return c.json({ error: 'expired_token' }, 400)
        }
        const body = await githubJson('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: flow.clientId, device_code: flow.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
        })
        if (body.error === 'authorization_pending') return c.json({ status: 'pending', interval: flow.interval }, 202)
        if (body.error === 'slow_down') {
          flow.interval += 5
          return c.json({ status: 'slow_down', interval: flow.interval }, 202)
        }
        if (body.error === 'access_denied') {
          deviceFlows.delete(flowId)
          return c.json({ error: 'access_denied' }, 403)
        }
        if (body.error === 'expired_token') {
          deviceFlows.delete(flowId)
          return c.json({ error: 'expired_token' }, 400)
        }
        if (typeof body.access_token !== 'string') return c.json({ error: 'github_device_poll_failed' }, 502)
        const user = await fetchGitHubUser(body.access_token)
        const allowed = isAllowed(user)
        if (!allowed) return c.json({ error: 'forbidden' }, 403)
        deviceFlows.delete(flowId)
        setSessionCookie(c, user)
        return c.json({ status: 'authorized', user })
      } catch (error) {
        if (error instanceof GitHubRequestError) return c.json({ error: error.message }, 502)
        throw error
      }
    })

    app.post('/api/auth/logout', (c) => {
      clearSessionCookie(c)
      return c.json({ ok: true })
    })
  }

  return {
    middleware,
    registerRoutes,
    currentUser,
    terminalAuthorized: (cookie: string | undefined) => {
      const signedSession = cookie
        ?.split(';')
        .map((value) => value.trim().split('='))
        .find(([name]) => name === SESSION_COOKIE)?.[1]
      if (!signedSession) return false
      const [sessionId, signature] = signedSession.split('.')
      if (!sessionId || !signature || !safeEqual(signature, sign(sessionId))) return false
      const session = getSession(sessionId)
      if (!session || session.expiresAt <= Date.now()) {
        deleteSession(sessionId)
        return false
      }
      return true
    },
  }
}
