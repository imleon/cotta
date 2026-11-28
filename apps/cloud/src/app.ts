import {
  CLOUD_SIGNATURE_MAX_SKEW_MS,
  type CloudMachine,
  MACHINE_HEARTBEAT_SIGNATURE_HEADER,
  MACHINE_ONLINE_WINDOW_MS,
  machineHeartbeatMessage,
  machineHeartbeatRequestSchema,
  machineRegistrationMessage,
  machineRegistrationRequestSchema,
} from '@cotta/shared/cloud-protocol'
import { type Context, Hono, type Next } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { formatUserCode, keyFingerprint, newUserCode, normalizeUserCode, randomToken, sha256Hex, verifyEd25519 } from './crypto.js'
import type { GitHubClient } from './github.js'

/** The slice of the D1 API the backend uses; satisfied by a real D1 binding and by the test adapter. */
export type Database = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
      run(): Promise<{ meta: { changes: number } }>
    }
  }
}

const SESSION_COOKIE = 'cotta_cloud_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const REGISTRATION_TTL_MS = 15 * 60 * 1000
const REGISTRATION_POLL_INTERVAL_MS = 3000

type Account = { accountId: string; githubId: number; githubLogin: string }
type Env = { Variables: { account: Account } }

export type CloudAppOptions = { db: Database; github: GitHubClient; now?: () => number }

const loginPollSchema = z.strictObject({ flowId: z.string().min(1).max(128) })
const approveSchema = z.strictObject({ userCode: z.string().min(1).max(32) })

export function createCloudApp(options: CloudAppOptions): Hono<Env> {
  const { db, github } = options
  const now = options.now ?? Date.now
  const app = new Hono<Env>()

  async function accountFromSession(c: Context<Env>): Promise<Account | null> {
    const token = getCookie(c, SESSION_COOKIE)
    if (!token) return null
    const row = await db
      .prepare(
        `SELECT a.account_id, a.github_id, a.github_login FROM account_sessions s JOIN accounts a ON a.account_id = s.account_id
         WHERE s.token_hash = ? AND s.expires_at_ms > ?`,
      )
      .bind(await sha256Hex(token), now())
      .first<{ account_id: string; github_id: number; github_login: string }>()
    return row ? { accountId: row.account_id, githubId: row.github_id, githubLogin: row.github_login } : null
  }

  /** Signed-in account required. State-changing requests must be JSON, which a cross-site form cannot send. */
  const requireAccount = async (c: Context<Env>, next: Next) => {
    const account = await accountFromSession(c)
    if (!account) return c.json({ error: 'unauthorized' }, 401)
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: 'json_required' }, 415)
    c.set('account', account)
    await next()
  }

  app.onError((error, c) => {
    console.error('cloud: request failed', error)
    return c.json({ error: 'internal_server_error' }, 500)
  })

  app.get('/v1/health', (c) => c.json({ ok: true }))

  // ---- Account login (GitHub device flow; the cloud talks to GitHub, the browser only shows the code) ----

  app.post('/v1/auth/github/start', async (c) => {
    const flow = await github.startDeviceFlow()
    const flowId = randomToken()
    const start = now()
    await db
      .prepare('INSERT INTO login_flows (flow_id, device_code, interval_ms, next_poll_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?)')
      .bind(flowId, flow.deviceCode, flow.intervalS * 1000, start, start + flow.expiresInS * 1000)
      .run()
    return c.json({ flowId, userCode: flow.userCode, verificationUri: flow.verificationUri, expiresAtMs: start + flow.expiresInS * 1000, pollIntervalMs: flow.intervalS * 1000 })
  })

  app.post('/v1/auth/github/poll', async (c) => {
    const parsed = loginPollSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_poll_request' }, 400)
    const flow = await db
      .prepare('SELECT device_code, interval_ms, next_poll_at_ms, expires_at_ms FROM login_flows WHERE flow_id = ?')
      .bind(parsed.data.flowId)
      .first<{ device_code: string; interval_ms: number; next_poll_at_ms: number; expires_at_ms: number }>()
    const current = now()
    if (!flow || flow.expires_at_ms <= current) return c.json({ status: 'expired' })
    // GitHub penalizes polling faster than the interval; answer from our side instead of forwarding early polls.
    if (current < flow.next_poll_at_ms) return c.json({ status: 'pending' })
    const result = await github.pollToken(flow.device_code)
    if (result.status === 'pending' || result.status === 'slow_down') {
      const intervalMs = result.status === 'slow_down' ? result.intervalS * 1000 : flow.interval_ms
      await db
        .prepare('UPDATE login_flows SET interval_ms = ?, next_poll_at_ms = ? WHERE flow_id = ?')
        .bind(intervalMs, current + intervalMs, parsed.data.flowId)
        .run()
      return c.json({ status: 'pending' })
    }
    await db.prepare('DELETE FROM login_flows WHERE flow_id = ?').bind(parsed.data.flowId).run()
    if (result.status !== 'approved') return c.json({ status: result.status })
    const user = await github.user(result.accessToken)
    await db
      .prepare(
        `INSERT INTO accounts (account_id, github_id, github_login, created_at_ms, last_login_at_ms) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (github_id) DO UPDATE SET github_login = excluded.github_login, last_login_at_ms = excluded.last_login_at_ms`,
      )
      .bind(`acct_${randomToken(16)}`, user.id, user.login, current, current)
      .run()
    const account = await db.prepare('SELECT account_id FROM accounts WHERE github_id = ?').bind(user.id).first<{ account_id: string }>()
    if (!account) throw new Error('account upsert failed')
    const token = randomToken()
    await db.prepare('DELETE FROM account_sessions WHERE expires_at_ms <= ?').bind(current).run()
    await db
      .prepare('INSERT INTO account_sessions (token_hash, account_id, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?)')
      .bind(await sha256Hex(token), account.account_id, current, current + SESSION_TTL_MS)
      .run()
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: SESSION_TTL_MS / 1000, secure: new URL(c.req.url).protocol === 'https:' })
    return c.json({ status: 'approved', account: { githubLogin: user.login } })
  })

  app.get('/v1/auth/session', async (c) => {
    const account = await accountFromSession(c)
    return account ? c.json({ account: { githubLogin: account.githubLogin } }) : c.json({ error: 'unauthorized' }, 401)
  })

  app.post('/v1/auth/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE)
    if (token)
      await db
        .prepare('DELETE FROM account_sessions WHERE token_hash = ?')
        .bind(await sha256Hex(token))
        .run()
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  // ---- Machine registration (device code: the daemon starts it, a signed-in browser approves it) ----

  app.post('/v1/machines/registrations', async (c) => {
    const parsed = machineRegistrationRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_registration_request' }, 400)
    const request = parsed.data
    const current = now()
    if (Math.abs(current - request.timestampMs) > CLOUD_SIGNATURE_MAX_SKEW_MS) return c.json({ error: 'stale_signature' }, 400)
    if (!(await verifyEd25519(request.publicKey, machineRegistrationMessage(request.publicKey, request.timestampMs), request.signature))) return c.json({ error: 'invalid_signature' }, 401)
    if (await db.prepare('SELECT 1 AS found FROM machines WHERE public_key = ?').bind(request.publicKey).first()) return c.json({ error: 'machine_already_registered' }, 409)
    await db.prepare('DELETE FROM machine_registrations WHERE expires_at_ms <= ? AND machine_id IS NULL').bind(current).run()
    const registrationId = randomToken()
    for (;;) {
      const userCode = newUserCode()
      const inserted = await db
        .prepare(
          `INSERT INTO machine_registrations (registration_id, user_code, public_key, name, platform, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_code) DO NOTHING`,
        )
        .bind(registrationId, userCode, request.publicKey, request.name, request.platform, current, current + REGISTRATION_TTL_MS)
        .run()
      if (!inserted.meta.changes) continue
      const origin = new URL(c.req.url).origin
      return c.json(
        {
          registrationId,
          userCode: formatUserCode(userCode),
          verificationUrl: `${origin}/activate?code=${formatUserCode(userCode)}`,
          expiresAtMs: current + REGISTRATION_TTL_MS,
          pollIntervalMs: REGISTRATION_POLL_INTERVAL_MS,
        },
        201,
      )
    }
  })

  // The registration id is a 256-bit secret only the daemon received, so holding it is enough to poll.
  app.post('/v1/machines/registrations/:registrationId/poll', async (c) => {
    const row = await db
      .prepare('SELECT expires_at_ms, machine_id FROM machine_registrations WHERE registration_id = ?')
      .bind(c.req.param('registrationId'))
      .first<{ expires_at_ms: number; machine_id: string | null }>()
    if (row?.machine_id) return c.json({ status: 'approved', machineId: row.machine_id })
    if (!row || row.expires_at_ms <= now()) return c.json({ status: 'expired' })
    return c.json({ status: 'pending' })
  })

  app.get('/v1/machines/registrations/lookup/:userCode', requireAccount, async (c) => {
    const row = await db
      .prepare('SELECT public_key, name, platform, expires_at_ms, machine_id FROM machine_registrations WHERE user_code = ?')
      .bind(normalizeUserCode(c.req.param('userCode') ?? ''))
      .first<{ public_key: string; name: string; platform: string; expires_at_ms: number; machine_id: string | null }>()
    if (!row || (row.machine_id === null && row.expires_at_ms <= now())) return c.json({ error: 'registration_not_found' }, 404)
    return c.json({ name: row.name, platform: row.platform, fingerprint: await keyFingerprint(row.public_key), status: row.machine_id ? 'approved' : 'pending', expiresAtMs: row.expires_at_ms })
  })

  app.post('/v1/machines/registrations/approve', requireAccount, async (c) => {
    const parsed = approveSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_approve_request' }, 400)
    const account = c.get('account')
    const current = now()
    const registration = await db
      .prepare('SELECT registration_id, public_key, name, platform, expires_at_ms, machine_id FROM machine_registrations WHERE user_code = ?')
      .bind(normalizeUserCode(parsed.data.userCode))
      .first<{ registration_id: string; public_key: string; name: string; platform: string; expires_at_ms: number; machine_id: string | null }>()
    if (!registration || (registration.machine_id === null && registration.expires_at_ms <= current)) return c.json({ error: 'registration_not_found' }, 404)
    if (registration.machine_id) {
      const owner = await db.prepare('SELECT account_id FROM machines WHERE machine_id = ?').bind(registration.machine_id).first<{ account_id: string }>()
      return owner?.account_id === account.accountId ? c.json({ machineId: registration.machine_id }) : c.json({ error: 'registration_not_found' }, 404)
    }
    const machineId = `m_${randomToken(16)}`
    const inserted = await db
      .prepare(
        `INSERT INTO machines (machine_id, account_id, public_key, name, platform, registered_at_ms) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (public_key) DO NOTHING`,
      )
      .bind(machineId, account.accountId, registration.public_key, registration.name, registration.platform, current)
      .run()
    if (!inserted.meta.changes) return c.json({ error: 'machine_already_registered' }, 409)
    await db.prepare('UPDATE machine_registrations SET machine_id = ? WHERE registration_id = ?').bind(machineId, registration.registration_id).run()
    return c.json({ machineId }, 201)
  })

  // ---- Heartbeat (signed by the machine key over the exact body) ----

  app.post('/v1/machines/:machineId/heartbeat', async (c) => {
    const machineId = c.req.param('machineId')
    const body = await c.req.text()
    const signature = c.req.header(MACHINE_HEARTBEAT_SIGNATURE_HEADER) ?? ''
    const machine = await db.prepare('SELECT public_key FROM machines WHERE machine_id = ?').bind(machineId).first<{ public_key: string }>()
    if (!machine) return c.json({ error: 'machine_not_registered' }, 404)
    if (!(await verifyEd25519(machine.public_key, machineHeartbeatMessage(machineId, await sha256Hex(body)), signature))) return c.json({ error: 'invalid_signature' }, 401)
    let json: unknown = null
    try {
      json = JSON.parse(body)
    } catch {}
    const parsed = machineHeartbeatRequestSchema.safeParse(json)
    if (!parsed.success) return c.json({ error: 'invalid_heartbeat' }, 400)
    const current = now()
    if (Math.abs(current - parsed.data.timestampMs) > CLOUD_SIGNATURE_MAX_SKEW_MS) return c.json({ error: 'stale_signature' }, 400)
    await db.prepare('UPDATE machines SET last_seen_at_ms = ?, version = ?, platform = ? WHERE machine_id = ?').bind(current, parsed.data.version, parsed.data.platform, machineId).run()
    return c.json({ ok: true, serverTimeMs: current })
  })

  // ---- Machine directory (the account's view; the cloud can remove a machine, never grant access to one) ----

  app.get('/v1/machines', requireAccount, async (c) => {
    const current = now()
    const { results } = await db
      .prepare('SELECT machine_id, name, platform, public_key, version, registered_at_ms, last_seen_at_ms FROM machines WHERE account_id = ? ORDER BY registered_at_ms')
      .bind(c.get('account').accountId)
      .all<{ machine_id: string; name: string; platform: 'darwin' | 'linux'; public_key: string; version: string | null; registered_at_ms: number; last_seen_at_ms: number | null }>()
    const machines: CloudMachine[] = await Promise.all(
      results.map(async (row) => ({
        machineId: row.machine_id,
        name: row.name,
        platform: row.platform,
        fingerprint: await keyFingerprint(row.public_key),
        version: row.version,
        registeredAtMs: row.registered_at_ms,
        lastSeenAtMs: row.last_seen_at_ms,
        online: row.last_seen_at_ms !== null && current - row.last_seen_at_ms < MACHINE_ONLINE_WINDOW_MS,
      })),
    )
    return c.json({ machines })
  })

  app.delete('/v1/machines/:machineId', requireAccount, async (c) => {
    const removed = await db.prepare('DELETE FROM machines WHERE machine_id = ? AND account_id = ?').bind(c.req.param('machineId'), c.get('account').accountId).run()
    return removed.meta.changes ? c.json({ ok: true }) : c.json({ error: 'machine_not_found' }, 404)
  })

  return app
}
