import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { ed25519PublicKey, keyFingerprint, keyId } from './machine-identity.js'

/**
 * What an approved client may use on this machine. Recorded per client at approval; local approval grants all of them.
 * Enforcement lands with the routes each one guards — authentication alone is checked today.
 */
export const CLIENT_CAPABILITIES = ['sessions', 'files', 'terminal', 'settings'] as const
export type ClientCapability = (typeof CLIENT_CAPABILITIES)[number]

export type ApprovalMethod = 'local'

export type TrustedClient = {
  clientId: string
  publicKey: string
  fingerprint: string
  name: string
  capabilities: ClientCapability[]
  approvalMethod: ApprovalMethod
  approvedAtMs: number
  revokedAtMs: number | null
}

export type PairingRequest = {
  code: string
  clientId: string
  publicKey: string
  fingerprint: string
  name: string
  createdAtMs: number
  expiresAtMs: number
  approvedAtMs: number | null
}

export const PAIRING_TTL_MS = 10 * 60 * 1000
const MAX_PENDING_PAIRINGS = 20
const MAX_CLIENT_NAME_LENGTH = 100
// Crockford base32 without I, L, O, U: unambiguous to read aloud and type from another screen.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export class PairingError extends Error {
  constructor(readonly code: 'invalid_public_key' | 'invalid_client_name' | 'too_many_pending_pairings' | 'pairing_not_found' | 'pairing_expired' | 'client_revoked') {
    super(code)
  }
}

/** Normalizes user-typed codes: case-insensitive, separators and spaces ignored. */
export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '')
}

export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

function newPairingCode(): string {
  const bytes = randomBytes(8)
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte & 31]).join('')
}

type ClientRow = {
  client_id: string
  public_key: string
  name: string
  capabilities_json: string
  approval_method: ApprovalMethod
  approved_at_ms: number
  revoked_at_ms: number | null
}

type PairingRow = { code: string; public_key: string; name: string; created_at_ms: number; expires_at_ms: number; approved_at_ms: number | null }

const clientColumns = 'client_id, public_key, name, capabilities_json, approval_method, approved_at_ms, revoked_at_ms'
const pairingColumns = 'code, public_key, name, created_at_ms, expires_at_ms, approved_at_ms'

function clientRecord(row: ClientRow): TrustedClient {
  return {
    clientId: row.client_id,
    publicKey: row.public_key,
    fingerprint: keyFingerprint(row.public_key),
    name: row.name,
    capabilities: JSON.parse(row.capabilities_json) as ClientCapability[],
    approvalMethod: row.approval_method,
    approvedAtMs: row.approved_at_ms,
    revokedAtMs: row.revoked_at_ms,
  }
}

function pairingRecord(row: PairingRow): PairingRequest {
  return {
    code: row.code,
    clientId: keyId(row.public_key),
    publicKey: row.public_key,
    fingerprint: keyFingerprint(row.public_key),
    name: row.name,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    approvedAtMs: row.approved_at_ms,
  }
}

/**
 * The daemon's `authorized_keys`: the clients allowed to act on this machine, plus short-lived pairing requests waiting
 * for approval on the machine itself. Both the running daemon and the local `cotta clients` CLI use this store on the
 * same database, so a local revoke is seen by the very next request.
 */
export class TrustedClientStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  /** Opens a pairing request for a client key. Re-requesting for a key that already has a live request returns that one. */
  requestPairing(input: { publicKey: string; name: string }): PairingRequest {
    try {
      ed25519PublicKey(input.publicKey)
    } catch {
      throw new PairingError('invalid_public_key')
    }
    const name = input.name.trim()
    if (!name || name.length > MAX_CLIENT_NAME_LENGTH || /[\p{Cc}]/u.test(name)) throw new PairingError('invalid_client_name')
    const now = this.now()
    this.db.prepare('DELETE FROM client_pairing_requests WHERE expires_at_ms <= ?').run(now)
    const revoked = this.client(keyId(input.publicKey))
    if (revoked?.revokedAtMs != null) throw new PairingError('client_revoked')
    const existing = this.db.prepare(`SELECT ${pairingColumns} FROM client_pairing_requests WHERE public_key = ? AND approved_at_ms IS NULL`).get(input.publicKey) as PairingRow | undefined
    if (existing) return pairingRecord(existing)
    const pending = (this.db.prepare('SELECT COUNT(*) AS count FROM client_pairing_requests WHERE approved_at_ms IS NULL').get() as { count: number }).count
    if (pending >= MAX_PENDING_PAIRINGS) throw new PairingError('too_many_pending_pairings')
    for (;;) {
      const code = newPairingCode()
      const inserted = this.db
        .prepare('INSERT INTO client_pairing_requests (code, public_key, name, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT (code) DO NOTHING')
        .run(code, input.publicKey, name, now, now + PAIRING_TTL_MS)
      if (inserted.changes) return this.pairing(code) as PairingRequest
    }
  }

  pairing(code: string): PairingRequest | null {
    const row = this.db.prepare(`SELECT ${pairingColumns} FROM client_pairing_requests WHERE code = ?`).get(normalizePairingCode(code)) as PairingRow | undefined
    return row ? pairingRecord(row) : null
  }

  /** Approves a live pairing request on this machine, making its key a trusted client with every capability. */
  approvePairing(code: string, capabilities: readonly ClientCapability[] = CLIENT_CAPABILITIES): TrustedClient {
    const request = this.pairing(code)
    const now = this.now()
    if (!request) throw new PairingError('pairing_not_found')
    if (request.approvedAtMs !== null) return this.client(request.clientId) as TrustedClient
    if (request.expiresAtMs <= now) throw new PairingError('pairing_expired')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `INSERT INTO trusted_clients (${clientColumns}) VALUES (?, ?, ?, ?, 'local', ?, NULL)
           ON CONFLICT (client_id) DO UPDATE SET name = excluded.name, capabilities_json = excluded.capabilities_json WHERE trusted_clients.revoked_at_ms IS NULL`,
        )
        .run(request.clientId, request.publicKey, request.name, JSON.stringify([...capabilities]), now)
      this.db.prepare('UPDATE client_pairing_requests SET approved_at_ms = ? WHERE code = ?').run(now, request.code)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    const client = this.client(request.clientId) as TrustedClient
    if (client.revokedAtMs !== null) throw new PairingError('client_revoked')
    return client
  }

  client(clientId: string): TrustedClient | null {
    const row = this.db.prepare(`SELECT ${clientColumns} FROM trusted_clients WHERE client_id = ?`).get(clientId) as ClientRow | undefined
    return row ? clientRecord(row) : null
  }

  /** The client only while it is trusted (approved and not revoked). */
  activeClient(clientId: string): TrustedClient | null {
    const client = this.client(clientId)
    return client && client.revokedAtMs === null ? client : null
  }

  list(options: { includeRevoked?: boolean } = {}): TrustedClient[] {
    const rows = this.db.prepare(`SELECT ${clientColumns} FROM trusted_clients ${options.includeRevoked ? '' : 'WHERE revoked_at_ms IS NULL'} ORDER BY approved_at_ms`).all() as ClientRow[]
    return rows.map(clientRecord)
  }

  /**
   * Revokes a client permanently; its key can never be re-approved (a new key must pair again). Accepts the full client
   * id or an unambiguous prefix of at least 8 characters. Returns the revoked client, or null when nothing matched.
   */
  revoke(clientIdOrPrefix: string): TrustedClient | null {
    const matches = this.list({ includeRevoked: true }).filter((client) => client.clientId === clientIdOrPrefix || (clientIdOrPrefix.length >= 8 && client.clientId.startsWith(clientIdOrPrefix)))
    if (matches.length !== 1) return null
    const [target] = matches as [TrustedClient]
    if (target.revokedAtMs === null) this.db.prepare('UPDATE trusted_clients SET revoked_at_ms = ? WHERE client_id = ?').run(this.now(), target.clientId)
    return this.client(target.clientId)
  }
}
