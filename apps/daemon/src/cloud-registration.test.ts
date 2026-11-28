import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MACHINE_HEARTBEAT_SIGNATURE_HEADER, machineHeartbeatMessage, machineRegistrationMessage } from '@cotta/shared/cloud-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { machineRecordPath, readMachineRecord, registerMachine, sendHeartbeat, startCloudHeartbeat } from './cloud-registration.js'
import { loadOrCreateMachineIdentity, verifyEd25519 } from './machine-identity.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function identityFixture() {
  const root = await mkdtemp(join(tmpdir(), 'cotta-cloud-registration-'))
  roots.push(root)
  const dir = join(root, 'identity')
  return { dir, identity: loadOrCreateMachineIdentity(dir) }
}

function io() {
  const lines: string[] = []
  return { lines, log: (line: string) => lines.push(line), error: (line: string) => lines.push(`error: ${line}`), sleep: vi.fn(async () => {}) }
}

/** A cloud stand-in that checks every signature the way the real backend does. */
function fakeCloud(identity: { publicKey: string }, polls: Array<Record<string, unknown>>) {
  const requests: Array<{ url: string; body: string }> = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : ''
    requests.push({ url: String(url), body })
    if (String(url).endsWith('/v1/machines/registrations')) {
      const request = JSON.parse(body) as { publicKey: string; timestampMs: number; signature: string }
      const valid =
        request.publicKey === identity.publicKey &&
        verifyEd25519(request.publicKey, Buffer.from(machineRegistrationMessage(request.publicKey, request.timestampMs)), Buffer.from(request.signature, 'base64url'))
      if (!valid) return Response.json({ error: 'invalid_signature' }, { status: 401 })
      return Response.json(
        { registrationId: 'reg-1', userCode: 'ABCD-EFGH', verificationUrl: 'http://cloud.test/activate?code=ABCD-EFGH', expiresAtMs: Date.now() + 60_000, pollIntervalMs: 10 },
        { status: 201 },
      )
    }
    if (String(url).endsWith('/poll')) return Response.json(polls.shift() ?? { status: 'pending' })
    if (String(url).includes('/heartbeat')) {
      const signature = new Headers(init?.headers).get(MACHINE_HEARTBEAT_SIGNATURE_HEADER) ?? ''
      const digest = createHash('sha256').update(body).digest('hex')
      return verifyEd25519(identity.publicKey, Buffer.from(machineHeartbeatMessage('m_1', digest)), Buffer.from(signature, 'base64url'))
        ? Response.json({ ok: true, serverTimeMs: Date.now() })
        : Response.json({ error: 'invalid_signature' }, { status: 401 })
    }
    return new Response(null, { status: 404 })
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests }
}

describe('cotta register', () => {
  it('proves the machine key, prints the code, and records the machine once approved', async () => {
    const { dir, identity } = await identityFixture()
    const cloud = fakeCloud(identity, [{ status: 'pending' }, { status: 'approved', machineId: 'm_1' }])
    const output = io()

    const code = await registerMachine({ identity, cloudUrl: 'http://cloud.test', name: 'mac-mini', io: output, fetch: cloud.fetchImpl, dir })

    expect(code).toBe(0)
    expect(output.lines.join('\n')).toContain('http://cloud.test/activate?code=ABCD-EFGH')
    expect(output.lines.join('\n')).toContain(identity.fingerprint)
    expect(readMachineRecord(dir)).toMatchObject({ machineId: 'm_1', cloudUrl: 'http://cloud.test' })
    expect((await stat(machineRecordPath(dir))).mode & 0o777).toBe(0o600)
    expect(JSON.parse(cloud.requests[0]?.body ?? '{}')).toMatchObject({ name: 'mac-mini', publicKey: identity.publicKey })
  })

  it('does nothing when already registered and stops when the code expires', async () => {
    const { dir, identity } = await identityFixture()
    const expired = fakeCloud(identity, [{ status: 'expired' }])
    const failed = io()
    expect(await registerMachine({ identity, cloudUrl: 'http://cloud.test', io: failed, fetch: expired.fetchImpl, dir })).toBe(1)
    expect(failed.lines.at(-1)).toContain('expired')

    await registerMachine({ identity, cloudUrl: 'http://cloud.test', io: io(), fetch: fakeCloud(identity, [{ status: 'approved', machineId: 'm_1' }]).fetchImpl, dir })
    const again = fakeCloud(identity, [])
    const output = io()
    expect(await registerMachine({ identity, cloudUrl: 'http://cloud.test', io: output, fetch: again.fetchImpl, dir })).toBe(0)
    expect(again.requests).toEqual([])
    expect(output.lines[0]).toContain('already registered')
  })
})

describe('cloud heartbeat', () => {
  it('signs the exact body and reports unreachable clouds as status 0', async () => {
    const { identity } = await identityFixture()
    const record = { machineId: 'm_1', cloudUrl: 'http://cloud.test', registeredAtMs: 0 }
    const cloud = fakeCloud(identity, [])

    expect(await sendHeartbeat({ identity, record, version: '0.2.0', fetch: cloud.fetchImpl })).toBe(200)
    expect(JSON.parse(cloud.requests[0]?.body ?? '{}')).toMatchObject({ version: '0.2.0' })
    expect(await sendHeartbeat({ identity, record, version: '0.2.0', fetch: (async () => Promise.reject(new Error('offline'))) as typeof fetch })).toBe(0)
  })

  it('logs only transitions between reachable and unreachable', async () => {
    const { identity } = await identityFixture()
    const record = { machineId: 'm_1', cloudUrl: 'http://cloud.test', registeredAtMs: 0 }
    let online = false
    const cloud = fakeCloud(identity, [])
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => (online ? cloud.fetchImpl(url, init) : Promise.reject(new Error('offline')))) as typeof fetch
    const log = vi.fn()

    const stop = startCloudHeartbeat({ identity, record, version: '0.2.0', fetch: fetchImpl, intervalMs: 5, log })
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 30))
    online = true
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 30))
    stop()

    expect(log.mock.calls.map(([message]) => message)).toEqual(['Cloud heartbeat failed (unreachable); local operation continues.', 'Cloud heartbeat ok (m_1)'])
  })
})
