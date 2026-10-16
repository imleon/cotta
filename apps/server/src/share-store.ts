import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { type TurnSummary, turnPromptPreview } from '@cotta/shared'

/** One copied/placeholdered local image referenced by a share snapshot. */
export type ShareAsset = { src: string; file: string | null }

export type ShareRecord = {
  token: string
  projectId: string
  sessionId: string
  turnId: string
  snapshot: TurnSummary
  assets: ShareAsset[]
  createdAtMs: number
}

/** List row: identity + createdAt, plus display fields derived from the stored snapshot (no snapshot/assets payload). */
export type ShareListItem = Omit<ShareRecord, 'snapshot' | 'assets'> & {
  promptPreview?: string
  awaySummary?: string
  entrypoint?: string
}

type ShareRow = {
  token: string
  project_id: string
  session_id: string
  turn_id: string
  snapshot_json: string
  asset_manifest_json: string
  created_at_ms: number
}

const columns = 'token, project_id, session_id, turn_id, snapshot_json, asset_manifest_json, created_at_ms'

/** A fresh unguessable share token (256 bits). */
export function newShareToken(): string {
  return randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
}

export class ShareStore {
  constructor(private readonly db: DatabaseSync) {}

  private record(row: ShareRow): ShareRecord {
    return {
      token: row.token,
      projectId: row.project_id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      snapshot: JSON.parse(row.snapshot_json) as TurnSummary,
      assets: JSON.parse(row.asset_manifest_json) as ShareAsset[],
      createdAtMs: row.created_at_ms,
    }
  }

  /**
   * Atomically returns the existing active share for a turn, or creates one.
   * Concurrent creates for the same turn converge on a single token and snapshot. The row is inserted complete — snapshot
   * and asset manifest together — so a reachable token never serves a half-built share.
   */
  createOrReuse(input: { token: string; projectId: string; sessionId: string; turnId: string; snapshot: TurnSummary; assets: ShareAsset[]; createdAtMs?: number }): {
    record: ShareRecord
    reused: boolean
  } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db.prepare(`SELECT ${columns} FROM shares WHERE session_id = ? AND turn_id = ?`).get(input.sessionId, input.turnId) as ShareRow | undefined
      if (existing) {
        this.db.exec('COMMIT')
        return { record: this.record(existing), reused: true }
      }
      const { token } = input
      const createdAtMs = input.createdAtMs ?? Date.now()
      this.db
        .prepare(`INSERT INTO shares (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(token, input.projectId, input.sessionId, input.turnId, JSON.stringify(input.snapshot), JSON.stringify(input.assets), createdAtMs)
      this.db.exec('COMMIT')
      return { record: { token, projectId: input.projectId, sessionId: input.sessionId, turnId: input.turnId, snapshot: input.snapshot, assets: input.assets, createdAtMs }, reused: false }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** The active share for a turn, if any — lets a repeat create skip materialization. */
  getByTurn(sessionId: string, turnId: string): ShareRecord | null {
    const row = this.db.prepare(`SELECT ${columns} FROM shares WHERE session_id = ? AND turn_id = ?`).get(sessionId, turnId) as ShareRow | undefined
    return row ? this.record(row) : null
  }

  getByToken(token: string): ShareRecord | null {
    const row = this.db.prepare(`SELECT ${columns} FROM shares WHERE token = ?`).get(token) as ShareRow | undefined
    return row ? this.record(row) : null
  }

  /** Active shares, newest first, cursor-paginated by createdAtMs (cursor = last seen createdAtMs). */
  list(cursor: number | null, limit = 50): { items: ShareListItem[]; nextCursor: number | null } {
    const rows = (
      cursor === null
        ? this.db.prepare(`SELECT ${columns} FROM shares ORDER BY created_at_ms DESC, token DESC LIMIT ?`).all(limit + 1)
        : this.db.prepare(`SELECT ${columns} FROM shares WHERE created_at_ms < ? ORDER BY created_at_ms DESC, token DESC LIMIT ?`).all(cursor, limit + 1)
    ) as ShareRow[]
    const page = rows.slice(0, limit)
    const nextCursor = rows.length > limit ? (page.at(-1)?.created_at_ms ?? null) : null
    return {
      items: page.map((row) => {
        const snapshot = JSON.parse(row.snapshot_json) as TurnSummary
        const promptPreview = turnPromptPreview(snapshot)
        const awaySummary = snapshot.awaySummary?.trim()
        return {
          token: row.token,
          projectId: row.project_id,
          sessionId: row.session_id,
          turnId: row.turn_id,
          createdAtMs: row.created_at_ms,
          ...(promptPreview ? { promptPreview } : {}),
          ...(awaySummary ? { awaySummary } : {}),
          ...(snapshot.entrypoint ? { entrypoint: snapshot.entrypoint } : {}),
        }
      }),
      nextCursor,
    }
  }

  /** Removes a share by token; returns the deleted record (for asset cleanup) or null. */
  revoke(token: string): ShareRecord | null {
    const record = this.getByToken(token)
    if (!record) return null
    this.db.prepare('DELETE FROM shares WHERE token = ?').run(token)
    return record
  }

  /** Removes all shares for a session; returns deleted records (for asset cleanup). */
  deleteBySession(sessionId: string): ShareRecord[] {
    const rows = this.db.prepare(`SELECT ${columns} FROM shares WHERE session_id = ?`).all(sessionId) as ShareRow[]
    if (rows.length === 0) return []
    this.db.prepare('DELETE FROM shares WHERE session_id = ?').run(sessionId)
    return rows.map((row) => this.record(row))
  }
}
