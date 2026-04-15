import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { ENV } from '../../config/env.js'
import type { SDKSessionInfo, SessionMessage as SDKSessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionMessage, SessionSummary } from '../../protocol/message-types.js'
import {
  extractTimestamp,
  normalizeStoredTranscriptMessage,
  normalizeTranscriptMessage,
} from '../../protocol/transcript-normalizer.js'

export type SessionInfo = SessionSummary
export type StoredSessionMessage = SessionMessage

export interface SessionMessagePage {
  messages: SessionMessage[]
  hasMore: boolean
  nextBefore: string | null
}

function uniqueProjectDirs(projectDirs: string[]): string[] {
  return [...new Set(projectDirs.map((dir) => dir.trim()).filter(Boolean))]
}

function toSessionInfo(session: SDKSessionInfo): SessionSummary {
  return {
    id: session.sessionId,
    title: session.customTitle || session.summary || session.firstPrompt || session.sessionId,
    updatedAt: session.lastModified,
  }
}

function toSessionMessage(message: SDKSessionMessage): SessionMessage {
  return normalizeTranscriptMessage(
    message.type,
    message.message,
    message,
    extractTimestamp(message) ?? extractTimestamp(message.message),
  )
}

function getMessageUuid(message: SessionMessage): string | null {
  const raw = message.raw
  if (!raw || typeof raw !== 'object') return null
  return typeof (raw as Record<string, unknown>).uuid === 'string' ? (raw as Record<string, unknown>).uuid as string : null
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 50
  const normalized = Math.trunc(limit)
  if (normalized <= 0) return 50
  return Math.min(normalized, 200)
}

function normalizeBefore(before: string | null | undefined): string | null {
  return typeof before === 'string' && before.trim() ? before.trim() : null
}

function getBeforeOffset(messages: SessionMessage[], before: string | null): number {
  if (!before) return messages.length
  const index = messages.findIndex((message) => getMessageUuid(message) === before)
  return index >= 0 ? index : messages.length
}

async function readAllMessages(sessionId: string, projectDirs: string[] = [ENV.workspacePath]): Promise<SessionMessage[]> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  if (typeof sdk.getSessionMessages !== 'function') {
    console.warn('[Sessions] getSessionMessages not available in SDK, returning empty')
    return []
  }

  for (const dir of uniqueProjectDirs(projectDirs)) {
    try {
      const messages = await sdk.getSessionMessages(sessionId, {
        dir,
        limit: 10_000_000,
        offset: 0,
      })
      return messages.map((message) => toSessionMessage(message))
    } catch {
      // Try the next candidate directory.
    }
  }

  return []
}

export async function getMessagesPage(
  sessionId: string,
  options: { limit?: number; before?: string | null; projectDirs?: string[] } = {},
): Promise<SessionMessagePage> {
  try {
    const limit = normalizeLimit(options.limit ?? 50)
    const before = normalizeBefore(options.before)
    const allMessages = (await readAllMessages(sessionId, options.projectDirs)).map((message) => normalizeStoredTranscriptMessage(message))
    const endExclusive = getBeforeOffset(allMessages, before)
    const start = Math.max(0, endExclusive - limit)
    const messages = allMessages.slice(start, endExclusive)
    const hasMore = start > 0
    const nextBefore = hasMore ? getMessageUuid(allMessages[start]) : null

    return {
      messages,
      hasMore,
      nextBefore,
    }
  } catch (e) {
    console.error('[Sessions] Failed to get messages page:', e)
    return {
      messages: [],
      hasMore: false,
      nextBefore: null,
    }
  }
}

export async function getMessages(sessionId: string, limit: number = 50): Promise<SessionMessage[]> {
  const page = await getMessagesPage(sessionId, { limit })
  return page.messages
}

export async function listSessionsByProjectDirs(projectDirs: string[]): Promise<SessionInfo[]> {
  const all = await Promise.all(uniqueProjectDirs(projectDirs).map((dir) => listSessionsByProjectDir(dir)))
  const deduped = new Map<string, SessionInfo>()

  for (const session of all.flat()) {
    const existing = deduped.get(session.id)
    if (!existing || session.updatedAt > existing.updatedAt) {
      deduped.set(session.id, session)
    }
  }

  return [...deduped.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function listAllSessions(): Promise<SessionInfo[]> {
  return await listSessionsByProjectDir(ENV.workspacePath)
}

export async function listSessionsByProjectDir(projectDir: string): Promise<SessionInfo[]> {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    if (typeof sdk.listSessions === 'function') {
      const sessions = await sdk.listSessions({ dir: projectDir })
      return sessions.map(toSessionInfo)
    }
    console.warn('[Sessions] listSessions not available in SDK, returning empty')
    return []
  } catch (e) {
    console.error('[Sessions] Failed to list sessions:', e)
    return []
  }
}

export async function getSession(sessionId: string, projectDirs: string[] = [ENV.workspacePath]): Promise<SessionInfo | null> {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    if (typeof sdk.getSessionInfo === 'function') {
      for (const dir of uniqueProjectDirs(projectDirs)) {
        try {
          const info = await sdk.getSessionInfo(sessionId, {
            dir,
          })
          if (info) return toSessionInfo(info)
        } catch {
          // Try the next candidate directory.
        }
      }
      return null
    }
    return null
  } catch (e) {
    console.error('[Sessions] Failed to get session info:', e)
    return null
  }
}
