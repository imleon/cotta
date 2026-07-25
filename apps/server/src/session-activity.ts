import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'

type SessionActivity = { fileSize?: number; lastActivityAt: number }

export class SessionActivityTracker {
  private readonly sessions = new Map<string, SessionActivity>()

  get(session: SDKSessionInfo): number {
    const cached = this.sessions.get(session.sessionId)
    if (cached?.fileSize !== undefined && session.fileSize !== undefined && cached.fileSize === session.fileSize) {
      return cached.lastActivityAt
    }

    this.sessions.set(session.sessionId, { fileSize: session.fileSize, lastActivityAt: session.lastModified })
    return session.lastModified
  }
}
