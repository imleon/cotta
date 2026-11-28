import { createPrivateKey, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuth } from './auth.js'
import { ClientAuthenticator, clientAuthMessage } from './client-auth.js'
import { createCottaDatabase } from './database.js'
import { keyFingerprint, keyId, loadOrCreateMachineIdentity, machineKeyPath, rawPublicKey, verifyEd25519 } from './machine-identity.js'
import { createTestApp } from './routes/project-routes-test-helpers.js'
import { PAIRING_TTL_MS, PairingError, TrustedClientStore } from './trusted-clients.js'

const roots: string[] = []
const databases: DatabaseSync[] = []

afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cotta-client-auth-'))
  roots.push(root)
  return root
}

async function store(now: () => number = Date.now) {
  const db = createCottaDatabase(join(await tempDir(), 'cotta.sqlite'))
  databases.push(db)
  return new TrustedClientStore(db, now)
}

function clientKey(): { privateKey: KeyObject; publicKey: string; clientId: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const raw = rawPublicKey(publicKey)
  return { privateKey, publicKey: raw, clientId: keyId(raw) }
}

describe('machine identity', () => {
  it('creates a private Ed25519 key once and reloads the same identity', async () => {
    const dir = join(await tempDir(), 'identity')

    const first = loadOrCreateMachineIdentity(dir)
    const second = loadOrCreateMachineIdentity(dir)

    expect(second.publicKey).toBe(first.publicKey)
    expect(first.fingerprint).toBe(keyFingerprint(first.publicKey))
    expect(first.fingerprint).toMatch(/^SHA256:[A-Za-z0-9_-]{43}$/)
    expect((await stat(machineKeyPath(dir))).mode & 0o777).toBe(0o600)
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    const data = Buffer.from('hello')
    expect(verifyEd25519(first.publicKey, data, first.sign(data))).toBe(true)
    expect(verifyEd25519(first.publicKey, Buffer.from('other'), first.sign(data))).toBe(false)
  })

  it('refuses a key file that is not Ed25519 instead of replacing it', async () => {
    const dir = join(await tempDir(), 'identity')
    loadOrCreateMachineIdentity(dir)
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    await writeFile(machineKeyPath(dir), privateKey.export({ format: 'pem', type: 'pkcs8' }))

    expect(() => loadOrCreateMachineIdentity(dir)).toThrow('is not an Ed25519 key')
    expect(createPrivateKey(await import('node:fs').then((fs) => fs.readFileSync(machineKeyPath(dir)))).asymmetricKeyType).toBe('ec')
  })
})

describe('TrustedClientStore', () => {
  it('approves a pairing request into a trusted client with every capability', async () => {
    const clients = await store()
    const key = clientKey()

    const request = clients.requestPairing({ publicKey: key.publicKey, name: ' MacBook ' })
    const again = clients.requestPairing({ publicKey: key.publicKey, name: 'MacBook' })
    const client = clients.approvePairing(request.code.toLowerCase().replace(/^(.{4})/, '$1-'))

    expect(again.code).toBe(request.code)
    expect(request.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
    expect(client).toMatchObject({ clientId: key.clientId, name: 'MacBook', approvalMethod: 'local', revokedAtMs: null, capabilities: ['sessions', 'files', 'terminal', 'settings'] })
    expect(clients.activeClient(key.clientId)).toEqual(client)
  })

  it('rejects invalid keys and names, expired requests, and floods of pending requests', async () => {
    let now = 1_000
    const clients = await store(() => now)

    expect(() => clients.requestPairing({ publicKey: 'not-a-key', name: 'x' })).toThrow(PairingError)
    expect(() => clients.requestPairing({ publicKey: clientKey().publicKey, name: '  ' })).toThrow('invalid_client_name')
    const request = clients.requestPairing({ publicKey: clientKey().publicKey, name: 'late' })
    now += PAIRING_TTL_MS
    expect(() => clients.approvePairing(request.code)).toThrow('pairing_expired')
    for (let index = 0; index < 20; index += 1) clients.requestPairing({ publicKey: clientKey().publicKey, name: `client ${index}` })
    expect(() => clients.requestPairing({ publicKey: clientKey().publicKey, name: 'one too many' })).toThrow('too_many_pending_pairings')
  })

  it('revokes by unambiguous prefix and never re-trusts a revoked key', async () => {
    const clients = await store()
    const key = clientKey()
    clients.approvePairing(clients.requestPairing({ publicKey: key.publicKey, name: 'Phone' }).code)

    expect(clients.revoke(key.clientId.slice(0, 7))).toBeNull()
    expect(clients.revoke(key.clientId.slice(0, 8))?.revokedAtMs).not.toBeNull()
    expect(clients.activeClient(key.clientId)).toBeNull()
    expect(() => clients.requestPairing({ publicKey: key.publicKey, name: 'Phone' })).toThrow('client_revoked')
    expect(clients.list()).toEqual([])
    expect(clients.list({ includeRevoked: true })).toHaveLength(1)
  })
})

describe('client authentication over HTTP', () => {
  async function setup() {
    const clients = await store()
    const machine = loadOrCreateMachineIdentity(join(await tempDir(), 'identity'))
    const authenticator = new ClientAuthenticator(clients, machine)
    const app = createTestApp({}, undefined, {
      auth: createAuth({ github: { allowedUsers: 'someone', sessionSecret: 'test-secret' }, clientAuthenticator: authenticator }),
      clientAuthenticator: authenticator,
    })
    const json = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { app, clients, machine, json }
  }

  async function signIn(context: Awaited<ReturnType<typeof setup>>, key: ReturnType<typeof clientKey>, machineFingerprint = context.machine.fingerprint) {
    const challenge = (await (await context.json('/api/clients/challenge', { clientId: key.clientId })).json()) as { nonce: string }
    const signature = sign(null, clientAuthMessage(machineFingerprint, key.clientId, challenge.nonce), key.privateKey).toString('base64url')
    return context.json('/api/clients/session', { clientId: key.clientId, nonce: challenge.nonce, signature })
  }

  it('pairs, approves locally, signs a challenge and then reaches protected routes until revoked', async () => {
    const context = await setup()
    const key = clientKey()
    expect((await context.app.request('/api/projects')).status).toBe(401)

    const pairing = await context.json('/api/clients/pairings', { publicKey: key.publicKey, name: 'Desktop' })
    expect(pairing.status).toBe(201)
    const paired = (await pairing.json()) as { code: string; clientId: string; machine: { fingerprint: string } }
    expect(paired).toMatchObject({ clientId: key.clientId, machine: { fingerprint: context.machine.fingerprint } })
    expect(await (await context.app.request(`/api/clients/pairings/${paired.code}`)).json()).toMatchObject({ status: 'pending' })
    expect((await context.json('/api/clients/challenge', { clientId: key.clientId })).status).toBe(403)

    context.clients.approvePairing(paired.code)
    expect(await (await context.app.request(`/api/clients/pairings/${paired.code}`)).json()).toMatchObject({ status: 'approved' })
    const session = await signIn(context, key)
    expect(session.status).toBe(200)
    const { token } = (await session.json()) as { token: string }
    const authorized = { headers: { Authorization: `Bearer ${token}` } }
    expect((await context.app.request('/api/projects', authorized)).status).toBe(200)

    context.clients.revoke(key.clientId)
    expect((await context.app.request('/api/projects', authorized)).status).toBe(401)
    expect((await context.json('/api/clients/challenge', { clientId: key.clientId })).status).toBe(403)
  })

  it('rejects signatures bound to another machine, replayed nonces and unknown tokens', async () => {
    const context = await setup()
    const key = clientKey()
    context.clients.approvePairing(context.clients.requestPairing({ publicKey: key.publicKey, name: 'Desktop' }).code)

    expect((await signIn(context, key, 'SHA256:another-machine')).status).toBe(401)
    const challenge = (await (await context.json('/api/clients/challenge', { clientId: key.clientId })).json()) as { nonce: string }
    const signature = sign(null, clientAuthMessage(context.machine.fingerprint, key.clientId, challenge.nonce), key.privateKey).toString('base64url')
    expect((await context.json('/api/clients/session', { clientId: key.clientId, nonce: challenge.nonce, signature })).status).toBe(200)
    expect((await context.json('/api/clients/session', { clientId: key.clientId, nonce: challenge.nonce, signature })).status).toBe(401)
    expect((await context.app.request('/api/projects', { headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' } })).status).toBe(401)
  })
})
