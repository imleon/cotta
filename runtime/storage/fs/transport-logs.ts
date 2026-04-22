import { mkdir, appendFile, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type {
  SessionMessage,
  SessionPersistentLogEntry,
  SessionPersistentLogPage,
  SessionSdkRawLogEntry,
  SessionSdkRawLogPage,
  SdkRawLogEvent,
} from '../../protocol/message-types.js'
import { readAllSessionMessages } from './sessions.js'

const LOG_DIR = './data/logs'
const DEFAULT_LOG_PAGE_SIZE = 100
const DEFAULT_SDK_RAW_PAGE_SIZE = 100
const MAX_LOG_PAGE_SIZE = 200
const MAX_SDK_RAW_PAGE_SIZE = 200

type StoredSdkRawLogRecord = {
  runId: string
  loggedAt: number
  sessionId: string
  event: SdkRawLogEvent
}

function getSdkRawLogFilePath(sessionId: string): string {
  return join(LOG_DIR, `${sessionId}.sdk-raw.ndjson`)
}

function sanitizeSessionId(sessionId: string): string | null {
  return /^[a-zA-Z0-9._-]+$/.test(sessionId) ? sessionId : null
}

const RAW_REDACTED = '[REDACTED]'

function sanitizeRawString(value: string): string {
  return value
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, `$1${RAW_REDACTED}`)
    .replace(/([?&]auth=)[^&]+/gi, `$1${RAW_REDACTED}`)
}

function isSensitiveRawKey(key: string): boolean {
  const normalized = key.toLowerCase()
  return normalized.includes('token')
    || normalized.includes('authorization')
    || normalized.includes('secret')
    || normalized.includes('password')
    || normalized.includes('apikey')
    || normalized === 'auth'
}

function sanitizeRawValue(value: unknown): unknown {
  if (value == null) return value
  if (typeof value === 'string') return sanitizeRawString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Error) return { name: value.name, message: sanitizeRawString(value.message) }
  if (Array.isArray(value)) return value.map((item) => sanitizeRawValue(item))
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
        key,
        isSensitiveRawKey(key) ? RAW_REDACTED : sanitizeRawValue(entryValue),
      ])
    )
  }
  return String(value)
}

function sanitizeSdkRawEvent(event: SdkRawLogEvent): SdkRawLogEvent {
  return {
    ...event,
    message: sanitizeRawValue(event.message) as SdkRawLogEvent['message'],
  }
}

async function appendLogRecord(filePath: string, record: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf-8')
}

async function readFirstExistingLogFile(filePaths: string[]): Promise<string | null> {
  for (const filePath of filePaths) {
    try {
      return await readFile(filePath, 'utf-8')
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: string }).code) : ''
      if (code === 'ENOENT') continue
      throw error
    }
  }
  return null
}

async function findClaudeSessionFile(sessionId: string): Promise<string | null> {
  const projectsDir = resolve(homedir(), '.claude/projects')
  let entries: string[] = []
  try {
    entries = await readdir(projectsDir)
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: string }).code) : ''
    if (code === 'ENOENT') return null
    throw error
  }

  for (const entry of entries) {
    const match = join(projectsDir, entry, `${sessionId}.jsonl`)
    const content = await readFirstExistingLogFile([match])
    if (content !== null) return match
  }

  return null
}

function paginateLogLines<T>(
  content: string,
  cursor: number | null | undefined,
  limit: number,
  follow: boolean,
  parseLine: (line: string, cursor: number) => T | null,
): { items: T[]; hasMore: boolean; nextCursor: number | null } {
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }

  const total = lines.length
  const boundedCursor = typeof cursor === 'number' && Number.isFinite(cursor)
    ? Math.max(0, Math.min(total, Math.floor(cursor)))
    : null
  const endExclusive = follow ? total : boundedCursor ?? total
  const start = follow ? (boundedCursor ?? total) : Math.max(0, endExclusive - limit)
  const items: T[] = []

  for (let index = start; index < endExclusive; index += 1) {
    const entry = parseLine(lines[index] || '', index + 1)
    if (entry) items.push(entry)
  }

  return {
    items,
    hasMore: follow ? false : start > 0,
    nextCursor: follow
      ? (items.length > 0 ? endExclusive : boundedCursor ?? total)
      : (items.length > 0 ? start : boundedCursor ?? total),
  }
}

export async function appendSessionSdkRawLog(runId: string, event: SdkRawLogEvent): Promise<void> {
  const sessionId = typeof event.sessionId === 'string' ? sanitizeSessionId(event.sessionId) : null
  if (!sessionId) return

  const record: StoredSdkRawLogRecord = {
    runId,
    loggedAt: Date.now(),
    sessionId,
    event: {
      ...sanitizeSdkRawEvent(event),
      sessionId,
    },
  }
  await appendLogRecord(getSdkRawLogFilePath(sessionId), record)
}

function parseSdkRawLogLine(line: string, cursor: number): SessionSdkRawLogEntry | null {
  if (!line.trim()) return null
  try {
    const parsed = JSON.parse(line) as Partial<StoredSdkRawLogRecord>
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.runId !== 'string') return null
    if (typeof parsed.loggedAt !== 'number' || !Number.isFinite(parsed.loggedAt)) return null
    if (typeof parsed.sessionId !== 'string' || !sanitizeSessionId(parsed.sessionId)) return null
    if (!parsed.event || typeof parsed.event !== 'object') return null
    const event = parsed.event as SdkRawLogEvent
    if (event.source !== 'sdk-raw') return null
    if (typeof event.kind !== 'string' || typeof event.direction !== 'string') return null
    return {
      cursor,
      runId: parsed.runId,
      loggedAt: parsed.loggedAt,
      sessionId: parsed.sessionId,
      event,
    }
  } catch {
    return null
  }
}

function getSessionMessageUuid(message: SessionMessage): string | null {
  const raw = message.raw
  if (!raw || typeof raw !== 'object') return null
  return typeof (raw as Record<string, unknown>).uuid === 'string'
    ? (raw as Record<string, unknown>).uuid as string
    : null
}

function buildSdkMessageUuidSet(messages: SessionMessage[]): Set<string> {
  const uuids = new Set<string>()
  for (const message of messages) {
    const uuid = getSessionMessageUuid(message)
    if (uuid) uuids.add(uuid)
  }
  return uuids
}

function extractPersistentLogTimestamp(line: string): number | null {
  try {
    const parsed = JSON.parse(line)
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    const snapshot = record.snapshot && typeof record.snapshot === 'object'
      ? record.snapshot as Record<string, unknown>
      : null
    const candidate = record.timestamp
      ?? record.createdAt
      ?? record.created_at
      ?? record.time
      ?? snapshot?.timestamp
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
    if (typeof candidate === 'string') {
      const value = Date.parse(candidate)
      return Number.isNaN(value) ? null : value
    }
    return null
  } catch {
    return null
  }
}

function extractPersistentLogUuid(line: string): string | null {
  try {
    const parsed = JSON.parse(line)
    if (!parsed || typeof parsed !== 'object') return null
    return typeof (parsed as Record<string, unknown>).uuid === 'string'
      ? (parsed as Record<string, unknown>).uuid as string
      : null
  } catch {
    return null
  }
}

function buildPersistentLogTags(line: string, sdkMessageUuids: Set<string>): string[] | undefined {
  const uuid = extractPersistentLogUuid(line)
  if (!uuid || !sdkMessageUuids.has(uuid)) return undefined
  return [`SDK UUID ${uuid.slice(0, 8)}`]
}

function readPersistentLogLine(
  line: string,
  cursor: number,
  sdkMessageUuids: Set<string>,
): SessionPersistentLogEntry {
  return {
    cursor,
    loggedAt: extractPersistentLogTimestamp(line),
    line,
    tags: buildPersistentLogTags(line, sdkMessageUuids),
  }
}

export async function readSessionPersistentLogs(
  sessionId: string,
  cursor?: number | null,
  limit: number = DEFAULT_LOG_PAGE_SIZE,
  follow: boolean = false,
  projectDirs: string[] = [],
): Promise<SessionPersistentLogPage> {
  const safeSessionId = sanitizeSessionId(sessionId)
  if (!safeSessionId) {
    return { items: [], hasMore: false, nextCursor: null }
  }

  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_LOG_PAGE_SIZE, Math.floor(limit))) : DEFAULT_LOG_PAGE_SIZE
  const sessionFilePath = await findClaudeSessionFile(safeSessionId)
  const content = sessionFilePath ? await readFirstExistingLogFile([sessionFilePath]) : null
  if (content === null) {
    return { items: [], hasMore: false, nextCursor: null }
  }

  const sdkMessages = projectDirs.length > 0
    ? await readAllSessionMessages(safeSessionId, projectDirs)
    : []
  const sdkMessageUuids = buildSdkMessageUuidSet(sdkMessages)
  return paginateLogLines(content, cursor, safeLimit, follow, (line, lineCursor) => readPersistentLogLine(line, lineCursor, sdkMessageUuids))
}

export async function readSessionSdkRawLogs(
  sessionId: string,
  cursor?: number | null,
  limit: number = DEFAULT_SDK_RAW_PAGE_SIZE,
  follow: boolean = false,
  full: boolean = false,
): Promise<SessionSdkRawLogPage> {
  const safeSessionId = sanitizeSessionId(sessionId)
  if (!safeSessionId) {
    return { items: [], hasMore: false, nextCursor: null }
  }

  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_SDK_RAW_PAGE_SIZE, Math.floor(limit))) : DEFAULT_SDK_RAW_PAGE_SIZE
  const content = await readFirstExistingLogFile([
    getSdkRawLogFilePath(safeSessionId),
  ])
  if (content === null) {
    return { items: [], hasMore: false, nextCursor: null }
  }

  return paginateLogLines(content, full ? null : cursor, safeLimit, follow, parseSdkRawLogLine)
}
