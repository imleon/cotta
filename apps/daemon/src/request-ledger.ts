import type { DatabaseSync } from 'node:sqlite'

/** How long a write receipt answers duplicates on its own; older turn submissions fall back to transcript evidence. */
export const REQUEST_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000
const PRUNE_INTERVAL_MS = 10 * 60 * 1000

export type RequestKind = 'turn' | 'permission' | 'question'

export type RequestReceipt<T> = { sessionId: string; result: T; createdAtMs: number }

/** The same request identity was reused for a different target session. */
export class RequestIdConflictError extends Error {
  constructor(readonly kind: RequestKind) {
    super(`${kind} request id is already bound to another session`)
  }
}

type ReceiptRow = { session_id: string; result_json: string; created_at_ms: number }

/**
 * Write-request reliability for client retries: an in-flight table so concurrent duplicates share one execution, and
 * durable receipts so a retry after the first attempt was accepted returns the original result instead of executing again.
 * It is not a task queue: nothing here ever re-sends or re-executes a request.
 */
export class RequestLedger {
  private readonly inflight = new Map<string, { sessionId: string; promise: Promise<unknown> }>()
  private lastPruneMs = Number.NEGATIVE_INFINITY

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: { retentionMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private cutoff(): number {
    return this.now() - (this.options.retentionMs ?? REQUEST_RECEIPT_RETENTION_MS)
  }

  /**
   * Runs `operation` at most once at a time per request identity. A duplicate that arrives while the first attempt is
   * still running waits for it and observes the same outcome, success or error.
   */
  once<T>(kind: RequestKind, key: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
    const id = `${kind}\0${key}`
    const running = this.inflight.get(id)
    if (running) {
      if (running.sessionId !== sessionId) return Promise.reject(new RequestIdConflictError(kind))
      return running.promise as Promise<T>
    }
    const promise = operation().finally(() => {
      if (this.inflight.get(id)?.promise === promise) this.inflight.delete(id)
    })
    this.inflight.set(id, { sessionId, promise })
    return promise
  }

  receipt<T>(kind: RequestKind, key: string): RequestReceipt<T> | null {
    const row = this.db.prepare('SELECT session_id, result_json, created_at_ms FROM request_receipts WHERE kind = ? AND request_key = ? AND created_at_ms >= ?').get(kind, key, this.cutoff()) as
      | ReceiptRow
      | undefined
    return row ? { sessionId: row.session_id, result: JSON.parse(row.result_json) as T, createdAtMs: row.created_at_ms } : null
  }

  /** Records the first accepted result for a request. An existing unexpired receipt is kept and returned unchanged. */
  record<T>(kind: RequestKind, key: string, sessionId: string, result: T): RequestReceipt<T> {
    this.pruneIfDue()
    const createdAtMs = this.now()
    this.db.prepare('DELETE FROM request_receipts WHERE kind = ? AND request_key = ? AND created_at_ms < ?').run(kind, key, this.cutoff())
    this.db
      .prepare('INSERT INTO request_receipts (kind, request_key, session_id, result_json, created_at_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT (kind, request_key) DO NOTHING')
      .run(kind, key, sessionId, JSON.stringify(result), createdAtMs)
    return this.receipt<T>(kind, key) ?? { sessionId, result, createdAtMs }
  }

  prune(): number {
    this.lastPruneMs = this.now()
    return Number(this.db.prepare('DELETE FROM request_receipts WHERE created_at_ms < ?').run(this.cutoff()).changes)
  }

  private pruneIfDue(): void {
    if (this.now() - this.lastPruneMs >= PRUNE_INTERVAL_MS) this.prune()
  }

  /**
   * Durable evidence that a submission already reached Claude Code: its user message is indexed from the transcript, or a
   * live result was recorded for it. This keeps duplicates from re-executing after their receipt has expired.
   */
  hasTranscriptTurn(sessionId: string, userMessageUuid: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM turn_meta_transcript WHERE session_id = ? AND primary_user_uuid = ? LIMIT 1').get(sessionId, userMessageUuid) !== undefined ||
      this.db.prepare('SELECT 1 FROM turn_meta_live WHERE session_id = ? AND primary_user_uuid = ? LIMIT 1').get(sessionId, userMessageUuid) !== undefined
    )
  }
}

/** Order-insensitive JSON form, so two equal decisions compare equal regardless of key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
      : item,
  )
}
