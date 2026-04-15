import type { SessionRecord, SessionStatus } from './types.js'

function now(): number {
  return Date.now()
}

export class SessionRegistry {
  private readonly records = new Map<string, SessionRecord>()

  get(sessionId: string): SessionRecord | null {
    return this.records.get(sessionId) ?? null
  }

  list(): SessionRecord[] {
    return [...this.records.values()]
  }

  findByChannelId(channelId: string): SessionRecord | null {
    for (const record of this.records.values()) {
      if (record.channelId === channelId) return record
    }
    return null
  }

  ensure(
    sessionId: string,
    agentId: string,
    extras: Partial<Omit<SessionRecord, 'sessionId' | 'agentId' | 'createdAt' | 'updatedAt'>> = {},
  ): SessionRecord {
    const existing = this.records.get(sessionId)
    if (existing) {
      const next: SessionRecord = {
        ...existing,
        ...extras,
        updatedAt: now(),
      }
      this.records.set(sessionId, next)
      return next
    }

    const created: SessionRecord = {
      sessionId,
      agentId,
      ...extras,
      createdAt: now(),
      updatedAt: now(),
    }
    this.records.set(sessionId, created)
    return created
  }

  bindChannel(sessionId: string, channelId: string): SessionRecord | null {
    const existing = this.records.get(sessionId)
    if (!existing) return null

    for (const [otherSessionId, other] of this.records.entries()) {
      if (otherSessionId === sessionId) continue
      if (other.channelId !== channelId) continue
      this.records.set(otherSessionId, {
        ...other,
        channelId: undefined,
        updatedAt: now(),
      })
    }

    const next: SessionRecord = {
      ...existing,
      channelId,
      updatedAt: now(),
    }
    this.records.set(sessionId, next)
    return next
  }

  unbindChannel(channelId: string): SessionRecord | null {
    const existing = this.findByChannelId(channelId)
    if (!existing) return null

    const next: SessionRecord = {
      ...existing,
      channelId: undefined,
      updatedAt: now(),
    }
    this.records.set(existing.sessionId, next)
    return next
  }

  attachWorker(sessionId: string, workerRef: string): SessionRecord | null {
    const existing = this.records.get(sessionId)
    if (!existing) return null

    const next: SessionRecord = {
      ...existing,
      workerRef,
      updatedAt: now(),
    }
    this.records.set(sessionId, next)
    return next
  }

  detachWorker(sessionId: string): SessionRecord | null {
    const existing = this.records.get(sessionId)
    if (!existing) return null

    const next: SessionRecord = {
      ...existing,
      workerRef: undefined,
      sessionStatus: undefined,
      activeRunId: undefined,
      updatedAt: now(),
    }
    this.records.set(sessionId, next)
    return next
  }

  setStatus(sessionId: string, status?: SessionStatus): SessionRecord | null {
    const existing = this.records.get(sessionId)
    if (!existing) return null

    const next: SessionRecord = {
      ...existing,
      sessionStatus: status,
      updatedAt: now(),
    }
    this.records.set(sessionId, next)
    return next
  }

  setActiveRun(sessionId: string, runId?: string): SessionRecord | null {
    const existing = this.records.get(sessionId)
    if (!existing) return null

    const next: SessionRecord = {
      ...existing,
      activeRunId: runId,
      updatedAt: now(),
    }
    this.records.set(sessionId, next)
    return next
  }

  delete(sessionId: string): boolean {
    return this.records.delete(sessionId)
  }
}
