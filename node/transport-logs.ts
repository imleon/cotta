import { mkdir, appendFile, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type {
  ChannelLogEvent,
  RunnerRuntimeEvent,
  SessionChannelLogEntry,
  SessionChannelLogPage,
  SessionPersistentLogEntry,
  SessionPersistentLogPage,
  SessionRuntimeLogEntry,
  SessionRuntimeLogPage,
  SessionTransportLogEntry,
  SessionTransportLogPage,
  SdkTransportEvent,
} from '../shared/message-types.js'
import { sanitizeValue } from './logger.js'
import { CONFIG } from './config.js'

const LOG_DIR = './data/logs'
const LEGACY_TRANSPORT_LOG_DIR = './data/transport-logs'
const LEGACY_RUNTIME_LOG_DIR = './data/runtime-logs'
const DEFAULT_TRANSPORT_PAGE_SIZE = 100
const DEFAULT_RUNTIME_PAGE_SIZE = 100
const DEFAULT_CHANNEL_PAGE_SIZE = 100
const MAX_TRANSPORT_PAGE_SIZE = 200
const MAX_RUNTIME_PAGE_SIZE = 200
const MAX_CHANNEL_PAGE_SIZE = 200

type StoredTransportLogRecord = {
  runId: string
  event: SdkTransportEvent & { sessionId: string }
}

type StoredRuntimeLogRecord = {
  runId: string
  loggedAt: number
  sessionId: string
  event: RunnerRuntimeEvent
}

type StoredChannelLogRecord = {
  runId?: string
  loggedAt: number
  sessionId: string
  event: ChannelLogEvent
}

type LogFileKind = 'transport' | 'runtime' | 'channel'

function getLogFilePath(sessionId: string, kind: LogFileKind): string {
  return join(LOG_DIR, `${sessionId}.${kind}.ndjson`)
}

function getLegacyTransportLogFilePath(sessionId: string): string {
  return join(LEGACY_TRANSPORT_LOG_DIR, `${sessionId}.ndjson`)
}

function getLegacyRuntimeLogFilePath(sessionId: string): string {
  return join(LEGACY_RUNTIME_LOG_DIR, `${sessionId}.ndjson`)
}

function sanitizeSessionId(sessionId: string): string | null {
  return /^[a-zA-Z0-9._-]+$/.test(sessionId) ? sessionId : null
}

function normalizeTransportPayload(event: SdkTransportEvent): SdkTransportEvent {
  if (event.payload === undefined) return event
  return {
    ...event,
    payload: sanitizeValue(event.payload),
  }
}

function sanitizeChannelEvent(event: ChannelLogEvent): ChannelLogEvent {
  return {
    ...event,
    ...(event.payloadSummary ? { payloadSummary: String(sanitizeValue(event.payloadSummary)) } : {}),
    ...(event.payload !== undefined ? { payload: sanitizeValue(event.payload) } : {}),
    ...(event.rawPayload !== undefined ? { rawPayload: event.rawPayload } : {}),
  }
}

function sanitizeRuntimeEvent(event: RunnerRuntimeEvent): RunnerRuntimeEvent {
  switch (event.type) {
    case 'sdk.message':
      return {
        ...event,
        payload: sanitizeValue(event.payload) as typeof event.payload,
        ...(event.parsed ? { parsed: sanitizeValue(event.parsed) as typeof event.parsed } : {}),
      }
    case 'control.message':
      return {
        ...event,
        transaction: sanitizeValue(event.transaction) as typeof event.transaction,
        message: sanitizeValue(event.message) as typeof event.message,
      }
    case 'control.opened':
    case 'control.awaiting_user':
    case 'control.responded':
    case 'control.completed':
    case 'control.cancel_requested':
    case 'control.cancelled':
    case 'control.failed':
      return {
        ...event,
        transaction: sanitizeValue(event.transaction) as typeof event.transaction,
        ...(event.payload !== undefined ? { payload: sanitizeValue(event.payload) } : {}),
      }
    case 'sdk.transport':
      return {
        ...event,
        event: normalizeTransportPayload(event.event),
      }
    default:
      return event
  }
}

function getRuntimeEventSessionId(event: RunnerRuntimeEvent): string | null {
  if (event.type === 'sdk.transport') {
    return typeof event.event.sessionId === 'string' ? sanitizeSessionId(event.event.sessionId) : null
  }
  return typeof event.sessionId === 'string' ? sanitizeSessionId(event.sessionId) : null
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
  const endExclusive = follow
    ? total
    : boundedCursor ?? total
  const start = follow
    ? (boundedCursor ?? total)
    : Math.max(0, endExclusive - limit)
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

export async function appendSessionTransportLog(runId: string, event: SdkTransportEvent): Promise<void> {
  const sessionId = typeof event.sessionId === 'string' ? sanitizeSessionId(event.sessionId) : null
  if (!sessionId) return

  const record: StoredTransportLogRecord = {
    runId,
    event: {
      ...normalizeTransportPayload(event),
      sessionId,
    },
  }
  await appendLogRecord(getLogFilePath(sessionId, 'transport'), record)
}

export async function appendSessionRuntimeLog(runId: string, event: RunnerRuntimeEvent): Promise<void> {
  const sessionId = getRuntimeEventSessionId(event)
  if (!sessionId) return

  const record: StoredRuntimeLogRecord = {
    runId,
    loggedAt: Date.now(),
    sessionId,
    event: sanitizeRuntimeEvent(event),
  }
  await appendLogRecord(getLogFilePath(sessionId, 'runtime'), record)
}

export async function appendSessionChannelLog(
  sessionId: string,
  event: ChannelLogEvent,
  runId?: string,
): Promise<void> {
  const safeSessionId = sanitizeSessionId(sessionId)
  if (!safeSessionId) return

  const record: StoredChannelLogRecord = {
    ...(runId ? { runId } : {}),
    loggedAt: Date.now(),
    sessionId: safeSessionId,
    event: sanitizeChannelEvent(event),
  }
  await appendLogRecord(getLogFilePath(safeSessionId, 'channel'), record)
}

function parseTransportLogLine(line: string, cursor: number): SessionTransportLogEntry | null {
  if (!line.trim()) return null
  try {
    const parsed = JSON.parse(line) as Partial<StoredTransportLogRecord>
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.runId !== 'string') return null
    if (!parsed.event || typeof parsed.event !== 'object') return null
    const event = parsed.event as SdkTransportEvent & { sessionId?: string }
    if (typeof event.sessionId !== 'string' || !sanitizeSessionId(event.sessionId)) return null
    if (event.source !== 'sdk-transport') return null
    return {
      cursor,
      runId: parsed.runId,
      event: {
        ...event,
        sessionId: event.sessionId,
      },
    }
  } catch {
    return null
  }
}

function parseRuntimeLogLine(line: string, cursor: number): SessionRuntimeLogEntry | null {
  if (!line.trim()) return null
  try {
    const parsed = JSON.parse(line) as Partial<StoredRuntimeLogRecord>
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.runId !== 'string') return null
    if (typeof parsed.loggedAt !== 'number' || !Number.isFinite(parsed.loggedAt)) return null
    if (typeof parsed.sessionId !== 'string' || !sanitizeSessionId(parsed.sessionId)) return null
    if (!parsed.event || typeof parsed.event !== 'object') return null
    const event = parsed.event as RunnerRuntimeEvent
    if (typeof event.type !== 'string') return null
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

function parseChannelLogLine(line: string, cursor: number): SessionChannelLogEntry | null {
  if (!line.trim()) return null
  try {
    const parsed = JSON.parse(line) as Partial<StoredChannelLogRecord>
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.loggedAt !== 'number' || !Number.isFinite(parsed.loggedAt)) return null
    if (typeof parsed.sessionId !== 'string' || !sanitizeSessionId(parsed.sessionId)) return null
    if (!parsed.event || typeof parsed.event !== 'object') return null
    const event = parsed.event as ChannelLogEvent
    if (event.source !== 'channel' || typeof event.eventName !== 'string') return null
    if (event.channel !== 'web' && event.channel !== 'lark' && event.channel !== 'discord') return null
    if (event.direction !== 'inbound' && event.direction !== 'outbound' && event.direction !== 'internal') return null
    return {
      cursor,
      ...(typeof parsed.runId === 'string' ? { runId: parsed.runId } : {}),
      loggedAt: parsed.loggedAt,
      sessionId: parsed.sessionId,
      event,
    }
  } catch {
    return null
  }
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

function readPersistentLogLine(line: string, cursor: number): SessionPersistentLogEntry {
  return {
    cursor,
    loggedAt: extractPersistentLogTimestamp(line),
    line,
  }
}

export async function readSessionPersistentLogs(
  sessionId: string,
  cursor?: number | null,
  limit: number = DEFAULT_TRANSPORT_PAGE_SIZE,
  follow: boolean = false,
): Promise<SessionPersistentLogPage> {
  const safeSessionId = sanitizeSessionId(sessionId)
  if (!safeSessionId) {
    return { items: [], hasMore: false, nextCursor: null }
  }

  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_TRANSPORT_PAGE_SIZE, Math.floor(limit))) : DEFAULT_TRANSPORT_PAGE_SIZE
  const sessionFilePath = await findClaudeSessionFile(safeSessionId)
  const content = sessionFilePath ? await readFirstExistingLogFile([sessionFilePath]) : null
  if (content === null) {
    return { items: [], hasMore: false, nextCursor: null }
  }

  return paginateLogLines(content, cursor, safeLimit, follow, readPersistentLogLine)
}

export async function readSessionTransportLogs(
  sessionId: string,
  cursor?: number | null,
  limit: number = DEFAULT_TRANSPORT_PAGE_SIZE,
  follow: boolean = false,
  full: boolean = false,
): Promise<SessionTransportLogPage> {
  const safeSessionId = sanitizeSessionId(sessionId)
  if (!safeSessionId) {
    return { items: [], hasMore: false, nextCursor: null }
  }

  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_TRANSPORT_PAGE_SIZE, Math.floor(limit))) : DEFAULT_TRANSPORT_PAGE_SIZE
  const content = await readFirstExistingLogFile([
    getLogFilePath(safeSessionId, 'transport'),
    getLegacyTransportLogFilePath(safeSessionId),
  ])
  if (content === null) {
    return { items: [], hasMore: false, nextCursor: null }
  }

  return paginateLogLines(content, full ? 0 : cursor, safeLimit, follow, parseTransportLogLine)
}

export async function readSessionRuntimeLogs(
  sessionId: string,
  cursor?: number | null,
  limit: number = DEFAULT_RUNTIME_PAGE_SIZE,
  follow: boolean = false,
  full: boolean = false,
): Promise<SessionRuntimeLogPage> {
  const safeSessionId = sanitizeSessionId(sessionId)
  if (!safeSessionId) {
    return { items: [], hasMore: false, nextCursor: null }
  }

  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_RUNTIME_PAGE_SIZE, Math.floor(limit))) : DEFAULT_RUNTIME_PAGE_SIZE
  const content = await readFirstExistingLogFile([
    getLogFilePath(safeSessionId, 'runtime'),
    getLegacyRuntimeLogFilePath(safeSessionId),
  ])
  if (content === null) {
    return { items: [], hasMore: false, nextCursor: null }
  }

  return paginateLogLines(content, full ? 0 : cursor, safeLimit, follow, parseRuntimeLogLine)
}

export async function readSessionChannelLogs(
  sessionId: string,
  cursor?: number | null,
  limit: number = DEFAULT_CHANNEL_PAGE_SIZE,
  follow: boolean = false,
  full: boolean = false,
): Promise<SessionChannelLogPage> {
  const safeSessionId = sanitizeSessionId(sessionId)
  if (!safeSessionId) {
    return { items: [], hasMore: false, nextCursor: null }
  }

  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_CHANNEL_PAGE_SIZE, Math.floor(limit))) : DEFAULT_CHANNEL_PAGE_SIZE
  const content = await readFirstExistingLogFile([
    getLogFilePath(safeSessionId, 'channel'),
  ])
  if (content === null) {
    return { items: [], hasMore: false, nextCursor: null }
  }

  return paginateLogLines(content, full ? 0 : cursor, safeLimit, follow, parseChannelLogLine)
}
