import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { type FileHandle, lstat, open, rm, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { extractPromptCandidate } from './session-prompt-title.js'

export type SessionMutationOperation = 'rename' | 'fork' | 'delete'
export type SessionMutationTarget = { transcriptPath: string }
type RecordValue = Record<string, unknown>

export class SessionTranscriptMutationError extends Error {}

function record(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateTarget(target: SessionMutationTarget, sessionId: string): void {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(sessionId) || basename(target.transcriptPath) !== `${sessionId}.jsonl`) {
    throw new SessionTranscriptMutationError('Invalid session transcript target')
  }
}

function unchanged(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
}

async function completeFile(file: FileHandle): Promise<Stats> {
  const info = await file.stat()
  if (!info.isFile() || info.size === 0) throw new SessionTranscriptMutationError('Session transcript must be a nonempty regular file')
  const end = Buffer.alloc(1)
  await file.read(end, 0, 1, info.size - 1)
  if (end[0] !== 10) throw new SessionTranscriptMutationError('Session transcript has an incomplete final line; retry after the writer finishes')
  return info
}

async function assertUnchanged(file: FileHandle, path: string, info: Stats): Promise<void> {
  if (!unchanged(info, await file.stat()) || !unchanged(info, await lstat(path))) throw new SessionTranscriptMutationError('Session transcript changed during the operation; retry')
}

// O_APPEND without O_CREAT: a deleted session must never be resurrected by rename.
export async function renameSessionTranscript(target: SessionMutationTarget, sessionId: string, title: string): Promise<void> {
  validateTarget(target, sessionId)
  const trimmed = title.trim()
  if (!trimmed) throw new SessionTranscriptMutationError('Session title must not be empty')
  const file = await open(target.transcriptPath, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW)
  try {
    const info = await completeFile(file)
    await assertUnchanged(file, target.transcriptPath, info)
    const data = Buffer.from(`${JSON.stringify({ type: 'custom-title', customTitle: trimmed, sessionId })}\n`)
    const { bytesWritten } = await file.write(data)
    if (bytesWritten !== data.length) throw new SessionTranscriptMutationError('Incomplete session title write')
  } finally {
    await file.close()
  }
}

const messageTypes = new Set(['user', 'assistant', 'attachment', 'system', 'progress'])
const READ_CHUNK_BYTES = 64 * 1024
const WRITE_BATCH_BYTES = 256 * 1024
const YIELD_SLICE_MS = 8

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function forkTitle(entries: RecordValue[]): string {
  let customTitle: string | undefined
  let aiTitle: string | undefined
  let firstPrompt: string | undefined
  let firstPromptLocked = false
  let commandFallback: string | null = null
  for (const entry of entries) {
    if (typeof entry.customTitle === 'string' && entry.customTitle) customTitle = entry.customTitle
    if (typeof entry.aiTitle === 'string' && entry.aiTitle) aiTitle = entry.aiTitle
    if (!firstPromptLocked && entry.type === 'user' && record(entry.message)) {
      const candidate = entry.message.role === undefined ? { ...entry, message: { ...entry.message, role: 'user' } } : entry
      const prompt = extractPromptCandidate(candidate, commandFallback)
      if (prompt.commandFallback && !commandFallback) commandFallback = prompt.commandFallback
      if (prompt.firstPrompt !== undefined) {
        firstPrompt = prompt.firstPrompt
        firstPromptLocked = prompt.locked === true
      }
    }
  }
  return `${customTitle || aiTitle || firstPrompt || commandFallback || 'Forked session'} (fork)`
}

function remapUuidList(values: unknown[], reference: (value: unknown) => string | null, errorMessage: string): string[] {
  const mapped: string[] = []
  for (const item of values) {
    const next = reference(item)
    if (!next) throw new SessionTranscriptMutationError(errorMessage)
    mapped.push(next)
  }
  return mapped
}

function remapCompactMetadata(metadata: RecordValue, reference: (value: unknown) => string | null): RecordValue | null {
  let updated: RecordValue | null = null
  if (record(metadata.preservedSegment)) {
    const segment = metadata.preservedSegment
    const mapped = Object.fromEntries(['headUuid', 'tailUuid', 'anchorUuid'].map((key) => [key, reference(segment[key])]))
    if (Object.values(mapped).some((value) => !value)) throw new SessionTranscriptMutationError('Fork cutoff excludes a preserved compact segment')
    updated = { ...metadata, preservedSegment: { ...segment, ...mapped } }
  }
  if (Array.isArray(metadata.preservedMessages)) {
    const mapped = remapUuidList(metadata.preservedMessages, reference, 'Fork cutoff excludes preserved compact messages')
    updated = { ...(updated ?? metadata), preservedMessages: mapped }
  } else if (record(metadata.preservedMessages)) {
    const preserved = metadata.preservedMessages
    const nextPreserved: RecordValue = { ...preserved }
    if (preserved.anchorUuid !== undefined && preserved.anchorUuid !== null) {
      const anchor = reference(preserved.anchorUuid)
      if (!anchor) throw new SessionTranscriptMutationError('Fork cutoff excludes preserved compact messages')
      nextPreserved.anchorUuid = anchor
    }
    if (Array.isArray(preserved.uuids)) nextPreserved.uuids = remapUuidList(preserved.uuids, reference, 'Fork cutoff excludes preserved compact messages')
    if (Array.isArray(preserved.allUuids)) nextPreserved.allUuids = remapUuidList(preserved.allUuids, reference, 'Fork cutoff excludes preserved compact messages')
    updated = { ...(updated ?? metadata), preservedMessages: nextPreserved }
  }
  return updated
}

async function readTranscriptEntries(source: FileHandle, size: number): Promise<RecordValue[]> {
  const entries: RecordValue[] = []
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
  let position = 0
  let fragments: Buffer[] = []
  let lineBytes = 0
  let sliceStart = performance.now()

  const parseLine = (raw: string): void => {
    const trimmed = raw.trim()
    if (!trimmed) return
    let entry: unknown
    try {
      entry = JSON.parse(trimmed)
    } catch {
      throw new SessionTranscriptMutationError('Invalid transcript record')
    }
    if (!record(entry)) throw new SessionTranscriptMutationError('Invalid transcript record')
    entries.push(entry)
  }

  while (position < size) {
    const length = Math.min(buffer.length, size - position)
    const { bytesRead } = await source.read(buffer, 0, length, position)
    if (bytesRead === 0) break
    position += bytesRead
    const data = buffer.subarray(0, bytesRead)
    let lineStart = 0
    for (let lineEnd = data.indexOf(10, lineStart); lineEnd >= 0; lineEnd = data.indexOf(10, lineStart)) {
      const end = data.subarray(lineStart, lineEnd)
      if (fragments.length > 0) {
        fragments.push(end)
        parseLine(Buffer.concat(fragments, lineBytes + end.length).toString('utf8'))
        fragments = []
        lineBytes = 0
      } else {
        parseLine(end.toString('utf8'))
      }
      lineStart = lineEnd + 1
      if (performance.now() - sliceStart >= YIELD_SLICE_MS) {
        await yieldToEventLoop()
        sliceStart = performance.now()
      }
    }
    if (lineStart < data.length) {
      // The read buffer is reused; retain an independent copy of only the unfinished fragment.
      const fragment = Buffer.from(data.subarray(lineStart))
      fragments.push(fragment)
      lineBytes += fragment.length
    }
  }
  if (fragments.length > 0) parseLine(Buffer.concat(fragments, lineBytes).toString('utf8'))
  return entries
}

async function buildForkLines(entries: RecordValue[], sessionId: string, upToMessageId?: string): Promise<{ sessionId: string; lines: RecordValue[] }> {
  let transcript = entries.filter((entry) => messageTypes.has(String(entry.type)) && typeof entry.uuid === 'string' && !entry.isSidechain)
  if (upToMessageId !== undefined) {
    const cutoff = transcript.findIndex((entry) => entry.uuid === upToMessageId)
    if (cutoff < 0) throw new SessionTranscriptMutationError('Fork target message was not found')
    transcript = transcript.slice(0, cutoff + 1)
  }
  const writable = transcript.filter((entry) => entry.type !== 'progress')
  if (!writable.length) throw new SessionTranscriptMutationError('Session has no messages to fork')
  const byUuid = new Map(transcript.map((entry) => [String(entry.uuid), entry]))
  const uuids = new Map(writable.map((entry) => [String(entry.uuid), randomUUID()]))
  const forkId = randomUUID()
  const now = new Date().toISOString()
  const reference = (value: unknown): string | null => {
    const seen = new Set<string>()
    while (typeof value === 'string') {
      if (seen.has(value)) throw new SessionTranscriptMutationError('Cyclic transcript parent chain')
      seen.add(value)
      const parent = byUuid.get(value)
      if (!parent) return null
      if (parent.type !== 'progress') return uuids.get(value) ?? null
      value = parent.parentUuid
    }
    return null
  }
  const lines: RecordValue[] = []
  let sliceStart = performance.now()
  for (let index = 0; index < writable.length; index += 1) {
    const entry = writable[index]!
    const forked: RecordValue = {
      ...entry,
      uuid: uuids.get(String(entry.uuid)),
      parentUuid: reference(entry.parentUuid),
      sessionId: forkId,
      timestamp: index === writable.length - 1 ? now : (entry.timestamp ?? now),
      isSidechain: false,
      forkedFrom: { sessionId, messageUuid: entry.uuid },
    }
    if ('logicalParentUuid' in entry) forked.logicalParentUuid = reference(entry.logicalParentUuid)
    if ('sourceToolAssistantUUID' in entry) forked.sourceToolAssistantUUID = reference(entry.sourceToolAssistantUUID)
    if (record(entry.compactMetadata)) {
      const remapped = remapCompactMetadata(entry.compactMetadata, reference)
      if (remapped) forked.compactMetadata = remapped
    }
    if (record(entry.microcompactMetadata) && Array.isArray(entry.microcompactMetadata.clearedAttachmentUUIDs)) {
      forked.microcompactMetadata = { ...entry.microcompactMetadata, clearedAttachmentUUIDs: entry.microcompactMetadata.clearedAttachmentUUIDs.map(reference).filter((value) => value !== null) }
    }
    if (entry.type === 'attachment' && record(entry.attachment)) {
      const attachment = entry.attachment
      if (attachment.type === 'queued_command' && typeof attachment.source_uuid === 'string' && uuids.has(attachment.source_uuid)) {
        forked.attachment = { ...attachment, source_uuid: uuids.get(attachment.source_uuid) }
      } else if (attachment.type === 'deferred_tools_record' && Array.isArray(attachment.nameOnlyAnnouncements)) {
        forked.attachment = { ...attachment, nameOnlyAnnouncements: attachment.nameOnlyAnnouncements.flatMap((uuid) => (typeof uuid === 'string' && uuids.has(uuid) ? [uuids.get(uuid)] : [])) }
      }
    }
    for (const key of ['teamName', 'agentName', 'agentColor', 'agentId', 'slug']) delete forked[key]
    lines.push(forked)
    if (performance.now() - sliceStart >= YIELD_SLICE_MS) {
      await yieldToEventLoop()
      sliceStart = performance.now()
    }
  }
  const toolResults = new Set<string>()
  for (const entry of writable) {
    if (!record(entry.message) || !Array.isArray(entry.message.content)) continue
    for (const block of entry.message.content) if (record(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string') toolResults.add(block.tool_use_id)
  }
  for (const entry of entries) {
    if (entry.type !== 'content-replacement' || entry.sessionId !== sessionId || entry.agentId || !Array.isArray(entry.replacements)) continue
    const replacements = entry.replacements.filter((replacement) => record(replacement) && typeof replacement.toolUseId === 'string' && toolResults.has(replacement.toolUseId))
    if (replacements.length) lines.push({ type: 'content-replacement', sessionId: forkId, replacements })
  }
  lines.push({ type: 'custom-title', sessionId: forkId, customTitle: forkTitle(entries) })
  return { sessionId: forkId, lines }
}

async function writeBuffer(output: FileHandle, data: Buffer): Promise<void> {
  let offset = 0
  while (offset < data.length) {
    const { bytesWritten } = await output.write(data, offset, data.length - offset)
    if (bytesWritten <= 0) throw new SessionTranscriptMutationError('Incomplete session fork write')
    offset += bytesWritten
  }
}

async function writeJsonlLines(output: FileHandle, lines: RecordValue[]): Promise<void> {
  let batch = ''
  let sliceStart = performance.now()
  for (const entry of lines) {
    batch += `${JSON.stringify(entry)}\n`
    if (batch.length >= WRITE_BATCH_BYTES) {
      await writeBuffer(output, Buffer.from(batch, 'utf8'))
      batch = ''
      sliceStart = performance.now()
    } else if (performance.now() - sliceStart >= YIELD_SLICE_MS) {
      await yieldToEventLoop()
      sliceStart = performance.now()
    }
  }
  if (batch.length > 0) await writeBuffer(output, Buffer.from(batch, 'utf8'))
}

export async function forkSessionTranscript(target: SessionMutationTarget, sessionId: string, upToMessageId?: string): Promise<string> {
  validateTarget(target, sessionId)
  const source = await open(target.transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await completeFile(source)
    const entries = await readTranscriptEntries(source, info.size)
    await assertUnchanged(source, target.transcriptPath, info)
    const fork = await buildForkLines(entries, sessionId, upToMessageId)
    const path = join(dirname(target.transcriptPath), `${fork.sessionId}.jsonl`)
    const output = await open(path, 'wx', 0o600)
    try {
      await writeJsonlLines(output, fork.lines)
    } catch (error) {
      await unlink(path).catch(() => {})
      throw error
    } finally {
      await output.close()
    }
    return fork.sessionId
  } finally {
    await source.close()
  }
}

// The caller must stop its writer and reject active external writers before deletion.
// Only the injected canonical source and its sibling session directory are touched.
export async function deleteSessionTranscript(target: SessionMutationTarget, sessionId: string): Promise<void> {
  validateTarget(target, sessionId)
  const file = await open(target.transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await completeFile(file)
    await assertUnchanged(file, target.transcriptPath, info)
    // Keep the main transcript discoverable if subagent cleanup fails, allowing a retry.
    await rm(join(dirname(target.transcriptPath), sessionId), { recursive: true, force: true })
    await assertUnchanged(file, target.transcriptPath, info)
    await unlink(target.transcriptPath)
  } finally {
    await file.close()
  }
}
