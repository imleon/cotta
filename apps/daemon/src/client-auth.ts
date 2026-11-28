import { randomBytes } from 'node:crypto'
import type { Hono } from 'hono'
import { z } from 'zod'
import type { MachineIdentity } from './machine-identity.js'
import { verifyEd25519 } from './machine-identity.js'
import { formatPairingCode, PairingError, type TrustedClient, type TrustedClientStore } from './trusted-clients.js'

const CHALLENGE_TTL_MS = 60 * 1000
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const MAX_OUTSTANDING_CHALLENGES = 1000

/** Domain-separated bytes a client signs to prove key possession to this specific machine. */
export function clientAuthMessage(machineFingerprint: string, clientId: string, nonce: string): Buffer {
  return Buffer.from(`cotta-client-auth:v1\n${machineFingerprint}\n${clientId}\n${nonce}`, 'utf8')
}

const pairingRequestSchema = z.strictObject({ publicKey: z.string(), name: z.string() })
const challengeRequestSchema = z.strictObject({ clientId: z.string().min(1).max(64) })
const sessionRequestSchema = z.strictObject({ clientId: z.string().min(1).max(64), nonce: z.string().min(1).max(128), signature: z.string().min(1).max(256) })

/** Paths a client must reach before it holds a session token. */
export function isClientAuthPublicPath(path: string): boolean {
  return path === '/api/clients/pairings' || path.startsWith('/api/clients/pairings/') || path === '/api/clients/challenge' || path === '/api/clients/session'
}

/**
 * Challenge-response authentication of trusted clients, the way SSH authenticates a user key: the daemon issues a nonce,
 * the client signs it (bound to this machine's fingerprint) with its private key, and the daemon verifies against the
 * key it approved. A short-lived bearer token then carries the authenticated client; the client's trust is re-checked
 * on every request, so a revoke takes effect immediately. Tokens live in memory and do not survive a daemon restart.
 */
export class ClientAuthenticator {
  private readonly challenges = new Map<string, { clientId: string; expiresAtMs: number }>()
  private readonly sessions = new Map<string, { clientId: string; expiresAtMs: number }>()

  constructor(
    private readonly store: TrustedClientStore,
    private readonly machine: Pick<MachineIdentity, 'fingerprint' | 'publicKey'>,
    private readonly now: () => number = Date.now,
  ) {}

  private sweep(): void {
    const now = this.now()
    for (const [nonce, challenge] of this.challenges) if (challenge.expiresAtMs <= now) this.challenges.delete(nonce)
    for (const [token, session] of this.sessions) if (session.expiresAtMs <= now) this.sessions.delete(token)
  }

  /** A single-use nonce. Issued only for a trusted client, so unknown keys learn nothing beyond "not trusted". */
  challenge(clientId: string): { nonce: string; expiresAtMs: number } | null {
    this.sweep()
    if (!this.store.activeClient(clientId) || this.challenges.size >= MAX_OUTSTANDING_CHALLENGES) return null
    const nonce = randomBytes(32).toString('base64url')
    const expiresAtMs = this.now() + CHALLENGE_TTL_MS
    this.challenges.set(nonce, { clientId, expiresAtMs })
    return { nonce, expiresAtMs }
  }

  /** Verifies a signed challenge and opens a session. The nonce is consumed whether or not the signature is valid. */
  openSession(input: { clientId: string; nonce: string; signature: string }): { token: string; expiresAtMs: number } | null {
    const challenge = this.challenges.get(input.nonce)
    this.challenges.delete(input.nonce)
    if (!challenge || challenge.clientId !== input.clientId || challenge.expiresAtMs <= this.now()) return null
    const client = this.store.activeClient(input.clientId)
    if (!client) return null
    const signature = Buffer.from(input.signature, 'base64url')
    if (!verifyEd25519(client.publicKey, clientAuthMessage(this.machine.fingerprint, client.clientId, input.nonce), signature)) return null
    const token = randomBytes(32).toString('base64url')
    const expiresAtMs = this.now() + SESSION_TTL_MS
    this.sessions.set(token, { clientId: client.clientId, expiresAtMs })
    return { token, expiresAtMs }
  }

  /** The trusted client behind a bearer token, or null when the token is unknown, expired or its client was revoked. */
  authenticate(token: string): TrustedClient | null {
    const session = this.sessions.get(token)
    if (!session) return null
    if (session.expiresAtMs <= this.now()) {
      this.sessions.delete(token)
      return null
    }
    const client = this.store.activeClient(session.clientId)
    if (!client) this.sessions.delete(token)
    return client
  }

  registerRoutes(app: Hono): void {
    const machine = { publicKey: this.machine.publicKey, fingerprint: this.machine.fingerprint }

    app.post('/api/clients/pairings', async (c) => {
      const parsed = pairingRequestSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return c.json({ error: 'invalid_pairing_request' }, 400)
      try {
        const request = this.store.requestPairing(parsed.data)
        return c.json({ code: formatPairingCode(request.code), clientId: request.clientId, fingerprint: request.fingerprint, expiresAtMs: request.expiresAtMs, machine }, 201)
      } catch (error) {
        if (error instanceof PairingError) return c.json({ error: error.code }, error.code === 'too_many_pending_pairings' ? 429 : error.code === 'client_revoked' ? 403 : 400)
        throw error
      }
    })

    app.get('/api/clients/pairings/:code', (c) => {
      const request = this.store.pairing(c.req.param('code'))
      if (!request) return c.json({ error: 'pairing_not_found' }, 404)
      const status = request.approvedAtMs !== null ? (this.store.activeClient(request.clientId) ? 'approved' : 'revoked') : request.expiresAtMs <= this.now() ? 'expired' : 'pending'
      return c.json({ status, clientId: request.clientId, machine })
    })

    app.post('/api/clients/challenge', async (c) => {
      const parsed = challengeRequestSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return c.json({ error: 'invalid_challenge_request' }, 400)
      const challenge = this.challenge(parsed.data.clientId)
      if (!challenge) return c.json({ error: 'client_not_trusted' }, 403)
      return c.json({ ...challenge, machine })
    })

    app.post('/api/clients/session', async (c) => {
      const parsed = sessionRequestSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return c.json({ error: 'invalid_session_request' }, 400)
      const session = this.openSession(parsed.data)
      if (!session) return c.json({ error: 'client_authentication_failed' }, 401)
      return c.json(session)
    })
  }
}

/** Bearer token from an `Authorization: Bearer …` header, if present. */
export function bearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+([A-Za-z0-9_-]{16,128})$/)
  return match?.[1] ?? null
}
