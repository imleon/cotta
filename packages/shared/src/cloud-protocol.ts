import { z } from 'zod'

/**
 * Daemon ↔ cloud control-plane contract (stage 2: registration, heartbeat, machine directory). The daemon proves it
 * holds its machine key by signing these domain-separated messages with Ed25519; the cloud verifies them against the
 * public key bound at registration. Signatures and keys are base64url; public keys are the raw 32 bytes.
 */

/** How far a signed timestamp may drift from the verifier's clock. */
export const CLOUD_SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000
/** A machine counts as online while its last heartbeat is younger than this (heartbeats are sent every minute). */
export const MACHINE_ONLINE_WINDOW_MS = 150 * 1000
export const MACHINE_HEARTBEAT_INTERVAL_MS = 60 * 1000
export const MACHINE_HEARTBEAT_SIGNATURE_HEADER = 'Cotta-Signature'

export function machineRegistrationMessage(publicKey: string, timestampMs: number): string {
  return `cotta-machine-registration:v1\n${publicKey}\n${timestampMs}`
}

/** Signed over the exact request body bytes (as their SHA-256 hex digest), so nothing in the body can be swapped. */
export function machineHeartbeatMessage(machineId: string, bodySha256Hex: string): string {
  return `cotta-machine-heartbeat:v1\n${machineId}\n${bodySha256Hex}`
}

const base64UrlKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const base64UrlSignature = z.string().regex(/^[A-Za-z0-9_-]{86}$/)
const machineName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((name) => !/\p{Cc}/u.test(name), 'control characters are not allowed')
const platform = z.enum(['darwin', 'linux'])

export const machineRegistrationRequestSchema = z.strictObject({
  publicKey: base64UrlKey,
  name: machineName,
  platform,
  timestampMs: z.number().int().nonnegative(),
  signature: base64UrlSignature,
})
export type MachineRegistrationRequest = z.infer<typeof machineRegistrationRequestSchema>

export const machineRegistrationResponseSchema = z.object({
  registrationId: z.string(),
  userCode: z.string(),
  verificationUrl: z.string(),
  expiresAtMs: z.number(),
  pollIntervalMs: z.number(),
})
export type MachineRegistrationResponse = z.infer<typeof machineRegistrationResponseSchema>

export const machineRegistrationPollResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('approved'), machineId: z.string() }),
])
export type MachineRegistrationPollResponse = z.infer<typeof machineRegistrationPollResponseSchema>

export const machineHeartbeatRequestSchema = z.strictObject({
  timestampMs: z.number().int().nonnegative(),
  version: z.string().min(1).max(64),
  platform,
})
export type MachineHeartbeatRequest = z.infer<typeof machineHeartbeatRequestSchema>

export const machineHeartbeatResponseSchema = z.object({ ok: z.literal(true), serverTimeMs: z.number() })
export type MachineHeartbeatResponse = z.infer<typeof machineHeartbeatResponseSchema>

export const cloudMachineSchema = z.object({
  machineId: z.string(),
  name: z.string(),
  platform,
  fingerprint: z.string(),
  version: z.string().nullable(),
  registeredAtMs: z.number(),
  lastSeenAtMs: z.number().nullable(),
  online: z.boolean(),
})
export type CloudMachine = z.infer<typeof cloudMachineSchema>
