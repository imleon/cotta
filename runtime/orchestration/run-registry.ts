import type { RunRecord, RunStatus, RunTerminalStatus } from './types.js'

function now(): number {
  return Date.now()
}

export class RunRegistry {
  private readonly records = new Map<string, RunRecord>()

  get(runId: string): RunRecord | null {
    return this.records.get(runId) ?? null
  }

  list(): RunRecord[] {
    return [...this.records.values()]
  }

  create(sessionId: string, runId: string): RunRecord {
    const record: RunRecord = {
      runId,
      sessionId,
      runStatus: 'running',
      createdAt: now(),
      updatedAt: now(),
    }
    this.records.set(runId, record)
    return record
  }

  setStatus(runId: string, status: RunStatus): RunRecord | null {
    const existing = this.records.get(runId)
    if (!existing) return null

    const next: RunRecord = {
      ...existing,
      runStatus: status,
      updatedAt: now(),
    }
    this.records.set(runId, next)
    return next
  }

  setPendingAction(runId: string, action?: RunRecord['pendingAction']): RunRecord | null {
    const existing = this.records.get(runId)
    if (!existing) return null

    const next: RunRecord = {
      ...existing,
      pendingAction: action,
      updatedAt: now(),
    }
    this.records.set(runId, next)
    return next
  }

  complete(runId: string, summary?: RunRecord['resultSummary']): RunRecord | null {
    const existing = this.records.get(runId)
    if (!existing) return null

    const next: RunRecord = {
      ...existing,
      runStatus: 'success',
      resultSummary: summary,
      pendingAction: undefined,
      updatedAt: now(),
    }
    this.records.set(runId, next)
    return next
  }

  fail(
    runId: string,
    status: RunTerminalStatus,
    summary?: RunRecord['resultSummary'],
  ): RunRecord | null {
    const existing = this.records.get(runId)
    if (!existing) return null

    const next: RunRecord = {
      ...existing,
      runStatus: status,
      resultSummary: summary,
      pendingAction: undefined,
      updatedAt: now(),
    }
    this.records.set(runId, next)
    return next
  }

  delete(runId: string): boolean {
    return this.records.delete(runId)
  }
}
