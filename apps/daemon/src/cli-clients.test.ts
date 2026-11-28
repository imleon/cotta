import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clientsCommand, identityCommand } from './cli-clients.js'
import { createCottaDatabase } from './database.js'
import { keyId, rawPublicKey } from './machine-identity.js'
import { formatPairingCode, TrustedClientStore } from './trusted-clients.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cotta-cli-clients-'))
  vi.stubEnv('COTTA_DB_PATH', join(root, 'cotta.sqlite'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

function io(answer = false) {
  const lines: string[] = []
  return { lines, log: (line: string) => lines.push(line), error: (line: string) => lines.push(`error: ${line}`), confirm: vi.fn(async () => answer) }
}

function pendingPairing(name = 'Desktop') {
  const publicKey = rawPublicKey(generateKeyPairSync('ed25519').publicKey)
  const db = createCottaDatabase()
  try {
    return { code: formatPairingCode(new TrustedClientStore(db).requestPairing({ publicKey, name }).code), clientId: keyId(publicKey) }
  } finally {
    db.close()
  }
}

describe('cotta clients', () => {
  it('shows both fingerprints and approves only after confirmation', async () => {
    const { code, clientId } = pendingPairing()
    const declined = io(false)
    expect(await clientsCommand(['approve', code], { yes: false, all: false }, declined)).toBe(1)
    expect(declined.lines.join('\n')).toMatch(/Client fingerprint: SHA256:.*\nMachine fingerprint: SHA256:/)

    const accepted = io(true)
    expect(await clientsCommand(['approve', code], { yes: false, all: false }, accepted)).toBe(0)
    const listed = io()
    await clientsCommand(['list'], { yes: false, all: false }, listed)
    expect(listed.lines[0]).toContain(clientId.slice(0, 12))
    expect(listed.lines[0]).toContain('Desktop')
  })

  it('revokes by prefix, then hides the client unless --all is given', async () => {
    const { code, clientId } = pendingPairing('Phone')
    await clientsCommand(['approve', code], { yes: true, all: false }, io())

    expect(await clientsCommand(['revoke', clientId.slice(0, 10)], { yes: true, all: false }, io())).toBe(0)
    const active = io()
    await clientsCommand(['list'], { yes: false, all: false }, active)
    const all = io()
    await clientsCommand(['list'], { yes: false, all: true }, all)

    expect(active.lines).toEqual(['No trusted clients.'])
    expect(all.lines[0]).toContain('revoked')
  })

  it('reports unknown codes and clients', async () => {
    const output = io()
    expect(await clientsCommand(['approve', 'ZZZZ-ZZZZ'], { yes: true, all: false }, output)).toBe(1)
    expect(await clientsCommand(['revoke', 'unknown-client'], { yes: true, all: false }, output)).toBe(1)
    expect(output.lines).toEqual(['error: No pairing request with code ZZZZ-ZZZZ.', 'error: No client matches unknown-client.'])
  })

  it('prints a stable machine fingerprint', () => {
    const first = io()
    const second = io()
    identityCommand(first)
    identityCommand(second)
    expect(first.lines[0]).toMatch(/^Machine fingerprint: SHA256:[A-Za-z0-9_-]{43}$/)
    expect(second.lines).toEqual(first.lines)
  })
})
