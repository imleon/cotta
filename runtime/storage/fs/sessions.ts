import type { SDKSessionInfo, SessionMessage as SDKSessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionMessage, SessionSummary } from '../../protocol/message-types.js'
import {
  extractTimestamp,
  getTranscriptSemanticKind,
  normalizeStoredTranscriptMessage,
  normalizeTranscriptMessage,
} from '../../protocol/transcript-normalizer.js'
import { createLogger } from '../../core/logger.js'

export type SessionInfo = SessionSummary
export type StoredSessionMessage = SessionMessage

export interface SessionMessagePage {
  messages: SessionMessage[]
  hasMore: boolean
  nextBefore: string | null
}

const logger = createLogger('storage-fs-sessions')

function uniqueProjectDirs(projectDirs: string[]): string[] {
  return [...new Set(projectDirs.map((dir) => dir.trim()).filter(Boolean))]
}

function requireProjectDirs(projectDirs: string[], action: string): string[] {
  const dirs = uniqueProjectDirs(projectDirs)
  if (dirs.length === 0) {
    throw new Error(`No project directories available to ${action}`)
  }
  return dirs
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

function isBridgeUserMessage(message: SessionMessage): boolean {
  if (message.role !== 'user') return false
  const hasToolResult = message.blocks?.some((block) => block.type === 'tool_result')
  if (hasToolResult) return true

  const content = message.content.trim()
  return content.includes('<local-command-stdout>')
    || content.includes('<local-command-stderr>')
    || content.includes('<bash-stdout>')
    || content.includes('<bash-stderr>')
    || content.includes('<tool_result>')
}

function isPrimaryUserTurnMessage(message: SessionMessage): boolean {
  return getTranscriptSemanticKind(message) === 'user' && !isBridgeUserMessage(message)
}

function expandStartToTurnBoundary(messages: SessionMessage[], tentativeStart: number): number {
  if (tentativeStart <= 0) return 0

  for (let index = tentativeStart; index >= 0; index -= 1) {
    if (isPrimaryUserTurnMessage(messages[index]!)) return index
  }

  return 0
}

export async function readAllSessionMessages(
  sessionId: string,
  projectDirs: string[],
): Promise<SessionMessage[]> {
  const dirs = requireProjectDirs(projectDirs, 'read persisted session messages')
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  if (typeof sdk.getSessionMessages !== 'function') {
    logger.warn('sdk-get-session-messages-unavailable')
    throw new Error('Claude SDK does not support getSessionMessages')
  }

  let lastError: string | null = null
  for (const dir of dirs) {
    try {
      const messages = await sdk.getSessionMessages(sessionId, {
        dir,
        limit: 10_000_000,
        offset: 0,
      })
      return messages.map((message) => toSessionMessage(message))
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      logger.warn('sdk-get-session-messages-failed', {
        sessionId,
        dir,
        error: lastError,
      })
    }
  }

  if (lastError) {
    throw new Error(`Failed to read persisted session messages: ${lastError}`)
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
    const projectDirs = requireProjectDirs(options.projectDirs ?? [], 'load session messages')
    const allMessages = (await readAllSessionMessages(sessionId, projectDirs)).map((message) => normalizeStoredTranscriptMessage(message))
    const endExclusive = getBeforeOffset(allMessages, before)
    const tentativeStart = Math.max(0, endExclusive - limit)
    const start = expandStartToTurnBoundary(allMessages, tentativeStart)
    const messages = allMessages.slice(start, endExclusive)
    const hasMore = start > 0
    const nextBefore = hasMore ? getMessageUuid(allMessages[start]) : null

    return {
      messages,
      hasMore,
      nextBefore,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('get-messages-page-failed', {
      sessionId,
      error: message,
    })
    throw new Error(`Failed to load session messages for ${sessionId}: ${message}`)
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

export async function listSessionsByProjectDir(projectDir: string): Promise<SessionInfo[]> {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    if (typeof sdk.listSessions === 'function') {
      const sessions = await sdk.listSessions({ dir: projectDir })
      return sessions.map(toSessionInfo)
    }
    logger.warn('sdk-list-sessions-unavailable', { projectDir })
    throw new Error('Claude SDK does not support listSessions')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('list-sessions-by-project-dir-failed', {
      projectDir,
      error: message,
    })
    throw new Error(`Failed to list sessions for project ${projectDir}: ${message}`)
  }
}

export async function getSession(sessionId: string, projectDirs: string[]): Promise<SessionInfo | null> {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    if (typeof sdk.getSessionInfo === 'function') {
      let lastError: string | null = null
      for (const dir of uniqueProjectDirs(projectDirs)) {
        try {
          const info = await sdk.getSessionInfo(sessionId, {
            dir,
          })
          if (info) return toSessionInfo(info)
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
          logger.warn('sdk-get-session-info-failed', {
            sessionId,
            dir,
            error: lastError,
          })
        }
      }
      if (lastError) {
        throw new Error(`Failed to read persisted session info: ${lastError}`)
      }
      return null
    }
    throw new Error('Claude SDK does not support getSessionInfo')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('get-session-info-failed', {
      sessionId,
      error: message,
    })
    throw new Error(`Failed to get session info ${sessionId}: ${message}`)
  }
}
