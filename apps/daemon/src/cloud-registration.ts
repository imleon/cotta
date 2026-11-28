import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  MACHINE_HEARTBEAT_INTERVAL_MS,
  MACHINE_HEARTBEAT_SIGNATURE_HEADER,
  type MachineHeartbeatRequest,
  machineHeartbeatMessage,
  machineRegistrationMessage,
  machineRegistrationPollResponseSchema,
  machineRegistrationResponseSchema,
} from '@cotta/shared/cloud-protocol'
import { z } from 'zod'
import { identityDir, type MachineIdentity } from './machine-identity.js'

/** Local cloud backend served by `wrangler dev` until the cloud is deployed. */
export const DEFAULT_CLOUD_URL = 'http://127.0.0.1:8787'

export function cloudUrl(override?: string): string {
  return (override ?? process.env.COTTA_CLOUD_URL ?? DEFAULT_CLOUD_URL).replace(/\/+$/, '')
}

const machineRecordSchema = z.object({ machineId: z.string().min(1), cloudUrl: z.string().min(1), registeredAtMs: z.number() })
/** The cloud registration of this machine identity; it sits beside the key it was issued for. */
export type MachineRecord = z.infer<typeof machineRecordSchema>

export function machineRecordPath(dir = identityDir()): string {
  return join(dir, 'machine.json')
}

export function readMachineRecord(dir = identityDir()): MachineRecord | null {
  const path = machineRecordPath(dir)
  if (!existsSync(path)) return null
  return machineRecordSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
}

function writeMachineRecord(record: MachineRecord, dir = identityDir()): void {
  writeFileSync(machineRecordPath(dir), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
}

export function machinePlatform(): 'darwin' | 'linux' {
  if (process.platform === 'darwin' || process.platform === 'linux') return process.platform
  throw new Error(`Cotta daemons run on macOS or Linux, not ${process.platform}`)
}

type RegisterIo = { log(message: string): void; error(message: string): void; sleep(ms: number): Promise<void> }

/**
 * `cotta register`: binds this machine identity to a cloud account by device code. The daemon proves it holds the
 * machine key, prints a code and link, and waits while the user approves it in a signed-in browser.
 */
export async function registerMachine(input: { identity: MachineIdentity; cloudUrl: string; name?: string; io: RegisterIo; fetch?: typeof fetch; now?: () => number; dir?: string }): Promise<number> {
  const { identity, io } = input
  const request = input.fetch ?? fetch
  const now = input.now ?? Date.now
  const existing = readMachineRecord(input.dir)
  if (existing) {
    io.log(`This machine is already registered (${existing.machineId} at ${existing.cloudUrl}).`)
    return 0
  }
  const timestampMs = now()
  const response = await request(`${input.cloudUrl}/v1/machines/registrations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: identity.publicKey,
      name: (input.name ?? hostname()).trim().slice(0, 100),
      platform: machinePlatform(),
      timestampMs,
      signature: identity.sign(Buffer.from(machineRegistrationMessage(identity.publicKey, timestampMs))).toString('base64url'),
    }),
  })
  if (response.status === 409) {
    io.error('This machine key is already registered to an account. Remove the machine in the cloud, or reset this machine identity, before registering again.')
    return 1
  }
  if (!response.ok) {
    io.error(`Registration failed: ${response.status} ${await response.text()}`)
    return 1
  }
  const registration = machineRegistrationResponseSchema.parse(await response.json())
  io.log(`To register this machine, open:\n\n  ${registration.verificationUrl}\n\nand confirm code ${registration.userCode}.`)
  io.log(`Machine fingerprint: ${identity.fingerprint}`)
  while (now() < registration.expiresAtMs) {
    await io.sleep(registration.pollIntervalMs)
    const poll = await request(`${input.cloudUrl}/v1/machines/registrations/${encodeURIComponent(registration.registrationId)}/poll`, { method: 'POST' })
    if (!poll.ok) continue
    const result = machineRegistrationPollResponseSchema.parse(await poll.json())
    if (result.status === 'approved') {
      writeMachineRecord({ machineId: result.machineId, cloudUrl: input.cloudUrl, registeredAtMs: now() }, input.dir)
      io.log(`Registered as ${result.machineId}.`)
      return 0
    }
    if (result.status === 'expired') break
  }
  io.error('The registration code expired. Run cotta register again.')
  return 1
}

/** One signed heartbeat. Returns the HTTP status (0 when the cloud could not be reached). */
export async function sendHeartbeat(input: { identity: MachineIdentity; record: MachineRecord; version: string; fetch?: typeof fetch; now?: () => number }): Promise<number> {
  const body: MachineHeartbeatRequest = { timestampMs: (input.now ?? Date.now)(), version: input.version, platform: machinePlatform() }
  const text = JSON.stringify(body)
  const signature = input.identity.sign(Buffer.from(machineHeartbeatMessage(input.record.machineId, createHash('sha256').update(text).digest('hex')))).toString('base64url')
  try {
    const response = await (input.fetch ?? fetch)(`${input.record.cloudUrl}/v1/machines/${encodeURIComponent(input.record.machineId)}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [MACHINE_HEARTBEAT_SIGNATURE_HEADER]: signature },
      body: text,
      signal: AbortSignal.timeout(10_000),
    })
    return response.status
  } catch {
    return 0
  }
}

/**
 * Sends a heartbeat now and then every minute while the daemon runs. Failures never affect local operation; only a
 * change between reachable and unreachable is logged, so an offline cloud does not flood the log.
 */
export function startCloudHeartbeat(input: {
  identity: MachineIdentity
  record: MachineRecord
  version: string
  fetch?: typeof fetch
  intervalMs?: number
  log?: (message: string) => void
}): () => void {
  const log = input.log ?? ((message: string) => console.log(message))
  let lastStatus: number | null = null
  let stopped = false
  const beat = async () => {
    const status = await sendHeartbeat(input)
    if (stopped || status === lastStatus) return
    if (status === 200) log(`Cloud heartbeat ok (${input.record.machineId})`)
    else if (status === 404) log('Cloud no longer knows this machine; run cotta register again after resetting its identity.')
    else log(`Cloud heartbeat failed (${status === 0 ? 'unreachable' : status}); local operation continues.`)
    lastStatus = status
  }
  void beat()
  const timer = setInterval(() => void beat(), input.intervalMs ?? MACHINE_HEARTBEAT_INTERVAL_MS)
  timer.unref()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
