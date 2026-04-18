import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const CLAIMS_DIR = './data/claims'
const CLAIMS_FILE = join(CLAIMS_DIR, 'channel-claims.json')

export type ChannelClaimRecord = {
  channelId: string
  agentId: string
  sessionId: string
  updatedAt: number
}

type ClaimsFileV1 = {
  version: 1
  updatedAt: number
  claims: Record<string, ChannelClaimRecord>
}

function now(): number {
  return Date.now()
}

function emptyFile(): ClaimsFileV1 {
  return { version: 1, updatedAt: now(), claims: {} }
}

export async function readChannelClaims(): Promise<ClaimsFileV1> {
  try {
    const raw = await readFile(CLAIMS_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ClaimsFileV1>
    if (!parsed || typeof parsed !== 'object') return emptyFile()
    if (parsed.version !== 1) return emptyFile()
    const claims = parsed.claims && typeof parsed.claims === 'object' ? parsed.claims as Record<string, ChannelClaimRecord> : {}
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : now(),
      claims,
    }
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: string }).code) : ''
    if (code === 'ENOENT') return emptyFile()
    return emptyFile()
  }
}

export async function writeChannelClaims(file: ClaimsFileV1): Promise<void> {
  await mkdir(dirname(CLAIMS_FILE), { recursive: true })
  const next: ClaimsFileV1 = {
    version: 1,
    updatedAt: now(),
    claims: file.claims ?? {},
  }
  await writeFile(CLAIMS_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
}

export async function getChannelClaim(channelId: string): Promise<ChannelClaimRecord | null> {
  const file = await readChannelClaims()
  return file.claims[channelId] ?? null
}

export async function setChannelClaim(input: { channelId: string; agentId: string; sessionId: string }): Promise<void> {
  const file = await readChannelClaims()
  file.claims[input.channelId] = {
    channelId: input.channelId,
    agentId: input.agentId,
    sessionId: input.sessionId,
    updatedAt: now(),
  }
  await writeChannelClaims(file)
}

// Enforces: a sessionId can only be claimed by one channel at a time.
// This prevents stale claims lingering after "move session to another channel".
export async function setExclusiveChannelClaim(input: { channelId: string; agentId: string; sessionId: string }): Promise<void> {
  const file = await readChannelClaims()
  for (const [existingChannelId, claim] of Object.entries(file.claims)) {
    if (!claim) continue
    if (existingChannelId === input.channelId) continue
    if (claim.sessionId !== input.sessionId) continue
    delete file.claims[existingChannelId]
  }
  file.claims[input.channelId] = {
    channelId: input.channelId,
    agentId: input.agentId,
    sessionId: input.sessionId,
    updatedAt: now(),
  }
  await writeChannelClaims(file)
}

export async function removeChannelClaim(channelId: string): Promise<void> {
  const file = await readChannelClaims()
  if (!(channelId in file.claims)) return
  delete file.claims[channelId]
  await writeChannelClaims(file)
}

export async function listClaimedSessionIds(): Promise<Set<string>> {
  const file = await readChannelClaims()
  const ids = new Set<string>()
  for (const claim of Object.values(file.claims)) {
    if (claim?.sessionId) ids.add(claim.sessionId)
  }
  return ids
}
