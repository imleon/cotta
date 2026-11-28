import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { MACHINE_HEARTBEAT_SIGNATURE_HEADER, machineHeartbeatMessage, machineRegistrationMessage } from '@cotta/shared/cloud-protocol'
import { describe, expect, it } from 'vitest'
import { createCloudApp } from './app.js'
import type { GitHubClient, GitHubTokenPoll } from './github.js'
import { testDatabase } from './test-database.js'

function machineKey(): { privateKey: KeyObject; publicKey: string; fingerprint: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const raw = (publicKey.export({ format: 'jwk' }) as { x: string }).x
  return { privateKey, publicKey: raw, fingerprint: `SHA256:${createHash('sha256').update(Buffer.from(raw, 'base64url')).digest('base64url')}` }
}

function signed(key: KeyObject, message: string): string {
  return sign(null, Buffer.from(message), key).toString('base64url')
}

function fakeGitHub(user = { id: 42, login: 'octo' }) {
  const polls: GitHubTokenPoll[] = []
  const github: GitHubClient = {
    startDeviceFlow: async () => ({ deviceCode: 'device-code', userCode: 'GH-CODE', verificationUri: 'https://github.com/login/device', expiresInS: 900, intervalS: 5 }),
    pollToken: async () => polls.shift() ?? { status: 'pending' },
    user: async () => user,
  }
  return { github, polls }
}

function setup(user?: { id: number; login: string }) {
  let now = 1_000_000
  const db = testDatabase()
  const { github, polls } = fakeGitHub(user)
  const app = createCloudApp({ db, github, now: () => now })
  const json = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(`https://cloud.test${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return {
    app,
    db,
    polls,
    json,
    advance: (ms: number) => {
      now += ms
    },
    now: () => now,
  }
}

async function signIn(context: ReturnType<typeof setup>): Promise<string> {
  const { flowId } = (await (await context.json('/v1/auth/github/start', {})).json()) as { flowId: string }
  context.polls.push({ status: 'approved', accessToken: 'gh-token' })
  const response = await context.json('/v1/auth/github/poll', { flowId })
  expect(await response.json()).toEqual({ status: 'approved', account: { githubLogin: 'octo' } })
  const cookie = response.headers.get('Set-Cookie')?.split(';')[0]
  if (!cookie) throw new Error('no session cookie')
  return cookie
}

async function register(context: ReturnType<typeof setup>, key = machineKey(), name = 'mac-mini') {
  const timestampMs = context.now()
  const response = await context.json('/v1/machines/registrations', {
    publicKey: key.publicKey,
    name,
    platform: 'darwin',
    timestampMs,
    signature: signed(key.privateKey, machineRegistrationMessage(key.publicKey, timestampMs)),
  })
  return { response, key }
}

describe('account login', () => {
  it('signs in through the GitHub device flow, keyed by the numeric GitHub id', async () => {
    const context = setup()
    const { flowId, userCode } = (await (await context.json('/v1/auth/github/start', {})).json()) as { flowId: string; userCode: string }
    expect(userCode).toBe('GH-CODE')

    // Polls earlier than GitHub's interval are answered locally.
    expect(await (await context.json('/v1/auth/github/poll', { flowId })).json()).toEqual({ status: 'pending' })
    context.advance(5000)
    context.polls.push({ status: 'approved', accessToken: 'gh-token' })
    const approved = await context.json('/v1/auth/github/poll', { flowId })
    const cookie = approved.headers.get('Set-Cookie') ?? ''

    expect(cookie).toMatch(/cotta_cloud_session=.+HttpOnly/)
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Secure')
    expect(await (await context.app.request('https://cloud.test/v1/auth/session', { headers: { Cookie: cookie.split(';')[0] ?? '' } })).json()).toEqual({ account: { githubLogin: 'octo' } })
    expect(context.db.raw.prepare('SELECT github_id, github_login FROM accounts').all()).toEqual([{ github_id: 42, github_login: 'octo' }])
  })

  it('keeps one account when the GitHub login is renamed', async () => {
    const context = setup()
    await signIn(context)
    const renamed = fakeGitHub({ id: 42, login: 'octo-renamed' })
    const app = createCloudApp({ db: context.db, github: renamed.github, now: context.now })
    const post = (path: string, body: unknown) => app.request(`https://cloud.test${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const { flowId } = (await (await post('/v1/auth/github/start', {})).json()) as { flowId: string }
    renamed.polls.push({ status: 'approved', accessToken: 'gh-token' })
    await post('/v1/auth/github/poll', { flowId })

    expect(context.db.raw.prepare('SELECT github_id, github_login FROM accounts').all()).toEqual([{ github_id: 42, github_login: 'octo-renamed' }])
  })

  it('rejects account routes without a session', async () => {
    const context = setup()
    expect((await context.app.request('https://cloud.test/v1/machines')).status).toBe(401)
  })
})

describe('machine registration', () => {
  it('registers a machine through a code approved by a signed-in account', async () => {
    const context = setup()
    const cookie = await signIn(context)
    const { response, key } = await register(context)
    expect(response.status).toBe(201)
    const registration = (await response.json()) as { registrationId: string; userCode: string; verificationUrl: string }
    expect(registration.userCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(registration.verificationUrl).toBe(`https://cloud.test/activate?code=${registration.userCode}`)
    expect(await (await context.json(`/v1/machines/registrations/${registration.registrationId}/poll`, {})).json()).toEqual({ status: 'pending' })

    const lookup = await context.app.request(`https://cloud.test/v1/machines/registrations/lookup/${registration.userCode.toLowerCase()}`, { headers: { Cookie: cookie } })
    expect(await lookup.json()).toMatchObject({ name: 'mac-mini', platform: 'darwin', fingerprint: key.fingerprint, status: 'pending' })
    const approved = await context.json('/v1/machines/registrations/approve', { userCode: registration.userCode }, { Cookie: cookie })
    expect(approved.status).toBe(201)
    const { machineId } = (await approved.json()) as { machineId: string }

    expect(await (await context.json(`/v1/machines/registrations/${registration.registrationId}/poll`, {})).json()).toEqual({ status: 'approved', machineId })
    const machines = (await (await context.app.request('https://cloud.test/v1/machines', { headers: { Cookie: cookie } })).json()) as { machines: unknown[] }
    expect(machines.machines).toEqual([
      { machineId, name: 'mac-mini', platform: 'darwin', fingerprint: key.fingerprint, version: null, registeredAtMs: context.now(), lastSeenAtMs: null, online: false },
    ])
  })

  it('requires proof of the machine key, a fresh timestamp and an unregistered key', async () => {
    const context = setup()
    const key = machineKey()
    const other = machineKey()
    const timestampMs = context.now()
    const forged = await context.json('/v1/machines/registrations', {
      publicKey: key.publicKey,
      name: 'm',
      platform: 'linux',
      timestampMs,
      signature: signed(other.privateKey, machineRegistrationMessage(key.publicKey, timestampMs)),
    })
    const stale = await context.json('/v1/machines/registrations', {
      publicKey: key.publicKey,
      name: 'm',
      platform: 'linux',
      timestampMs: timestampMs - 10 * 60 * 1000,
      signature: signed(key.privateKey, machineRegistrationMessage(key.publicKey, timestampMs - 10 * 60 * 1000)),
    })
    expect(forged.status).toBe(401)
    expect(stale.status).toBe(400)

    const cookie = await signIn(context)
    const { response } = await register(context, key)
    const { userCode } = (await response.json()) as { userCode: string }
    await context.json('/v1/machines/registrations/approve', { userCode }, { Cookie: cookie })
    expect((await register(context, key)).response.status).toBe(409)
  })

  it('expires unapproved codes and refuses form posts', async () => {
    const context = setup()
    const cookie = await signIn(context)
    const { response } = await register(context)
    const { registrationId, userCode } = (await response.json()) as { registrationId: string; userCode: string }

    const formPost = await context.app.request('https://cloud.test/v1/machines/registrations/approve', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `userCode=${userCode}`,
    })
    expect(formPost.status).toBe(415)
    context.advance(15 * 60 * 1000)
    expect((await context.json('/v1/machines/registrations/approve', { userCode }, { Cookie: cookie })).status).toBe(404)
    expect(await (await context.json(`/v1/machines/registrations/${registrationId}/poll`, {})).json()).toEqual({ status: 'expired' })
  })
})

describe('heartbeat and directory', () => {
  async function registeredMachine() {
    const context = setup()
    const cookie = await signIn(context)
    const { response, key } = await register(context)
    const { userCode } = (await response.json()) as { userCode: string }
    const { machineId } = (await (await context.json('/v1/machines/registrations/approve', { userCode }, { Cookie: cookie })).json()) as { machineId: string }
    const heartbeat = (body: string, signingKey = key.privateKey, id = machineId) =>
      context.app.request(`https://cloud.test/v1/machines/${id}/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [MACHINE_HEARTBEAT_SIGNATURE_HEADER]: signed(signingKey, machineHeartbeatMessage(id, createHash('sha256').update(body).digest('hex'))),
        },
        body,
      })
    return { context, cookie, machineId, heartbeat, key }
  }

  it('marks a machine online from a signed heartbeat and offline once it goes quiet', async () => {
    const { context, cookie, heartbeat } = await registeredMachine()
    const response = await heartbeat(JSON.stringify({ timestampMs: context.now(), version: '0.2.0', platform: 'darwin' }))
    expect(await response.json()).toEqual({ ok: true, serverTimeMs: context.now() })

    const list = async () =>
      ((await (await context.app.request('https://cloud.test/v1/machines', { headers: { Cookie: cookie } })).json()) as { machines: Array<{ online: boolean; version: string }> }).machines[0]
    expect(await list()).toMatchObject({ online: true, version: '0.2.0' })
    context.advance(150 * 1000)
    expect(await list()).toMatchObject({ online: false })
  })

  it('rejects heartbeats signed by another key, with a tampered body, or for an unknown machine', async () => {
    const { context, heartbeat, machineId, key } = await registeredMachine()
    const body = JSON.stringify({ timestampMs: context.now(), version: '0.2.0', platform: 'darwin' })

    expect((await heartbeat(body, machineKey().privateKey)).status).toBe(401)
    expect((await heartbeat(body, undefined, 'm_unknown')).status).toBe(404)
    const tampered = await context.app.request(`https://cloud.test/v1/machines/${machineId}/heartbeat`, {
      method: 'POST',
      headers: { [MACHINE_HEARTBEAT_SIGNATURE_HEADER]: signed(key.privateKey, machineHeartbeatMessage(machineId, createHash('sha256').update(body).digest('hex'))) },
      body: body.replace('0.2.0', '9.9.9'),
    })
    expect(tampered.status).toBe(401)
  })

  it('lets the owner remove a machine, after which its heartbeats are refused', async () => {
    const { context, cookie, machineId, heartbeat } = await registeredMachine()
    const removed = await context.app.request(`https://cloud.test/v1/machines/${machineId}`, { method: 'DELETE', headers: { Cookie: cookie, 'Content-Type': 'application/json' } })
    expect(removed.status).toBe(200)
    expect((await heartbeat(JSON.stringify({ timestampMs: context.now(), version: '0.2.0', platform: 'darwin' }))).status).toBe(404)
  })
})
