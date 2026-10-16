import type { DatabaseSync } from 'node:sqlite'

export type SessionSubagentMeta = {
  sessionId: string
  subagentId: string
  parentAgentId: string | null
  agentType: string | null
  name: string | null
  description: string | null
  model: string | null
  metaPath: string
  metaFileSize: number
  metaFileMtimeMs: number
  transcriptPath: string | null
  transcriptFileSize: number | null
  transcriptFileMtimeMs: number | null
  observedAtMs: number
  metaJson: unknown
}

export type SessionSubagentNode = Omit<SessionSubagentMeta, 'metaPath' | 'metaFileSize' | 'metaFileMtimeMs' | 'metaJson'> & {
  ownerTurnId: string
  isRoot: boolean
  metadataReady: boolean
  metaPath: string | null
  metaFileSize: number | null
  metaFileMtimeMs: number | null
  metaJson: unknown | null
}

type Row = {
  session_id: string
  subagent_id: string
  owner_turn_id: string | null
  is_root: number
  parent_agent_id: string | null
  agent_type: string | null
  name: string | null
  description: string | null
  model: string | null
  meta_path: string | null
  meta_file_size: number | null
  meta_file_mtime_ms: number | null
  transcript_path: string | null
  transcript_file_size: number | null
  transcript_file_mtime_ms: number | null
  usage_transcript_path: string | null
  usage_parsed_byte_offset: number
  usage_file_mtime_ms: number | null
  observed_at_ms: number
  meta_json: string | null
}

function fromRow(row: Row): SessionSubagentNode | null {
  if (!row.owner_turn_id) return null
  const metadataReady = Boolean(row.meta_path && row.meta_file_size != null && row.meta_file_mtime_ms != null && row.meta_json)
  return {
    sessionId: row.session_id,
    subagentId: row.subagent_id,
    ownerTurnId: row.owner_turn_id,
    isRoot: row.is_root === 1,
    metadataReady,
    parentAgentId: row.parent_agent_id,
    agentType: row.agent_type,
    name: row.name,
    description: row.description,
    model: row.model,
    metaPath: row.meta_path,
    metaFileSize: row.meta_file_size,
    metaFileMtimeMs: row.meta_file_mtime_ms,
    transcriptPath: row.transcript_path,
    transcriptFileSize: row.transcript_file_size,
    transcriptFileMtimeMs: row.transcript_file_mtime_ms,
    observedAtMs: row.observed_at_ms,
    metaJson: row.meta_json ? (JSON.parse(row.meta_json) as unknown) : null,
  }
}

export class SessionSubagentStore {
  constructor(private readonly db: DatabaseSync) {}

  recordRoots(sessionId: string, roots: readonly { subagentId: string; ownerTurnId: string }[], replace: boolean): boolean {
    if (replace) this.db.prepare('DELETE FROM session_subagents WHERE session_id = ?').run(sessionId)
    let changed = replace
    const upsert = this.db.prepare(`
      INSERT INTO session_subagents (session_id, subagent_id, owner_turn_id, is_root, observed_at_ms)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(session_id, subagent_id) DO UPDATE SET owner_turn_id = excluded.owner_turn_id, is_root = 1
    `)
    const currentRoot = this.db.prepare('SELECT owner_turn_id, is_root FROM session_subagents WHERE session_id = ? AND subagent_id = ?')
    const now = Date.now()
    for (const root of roots) {
      const existing = currentRoot.get(sessionId, root.subagentId) as { owner_turn_id: string | null; is_root: number } | undefined
      if (!existing || existing.owner_turn_id !== root.ownerTurnId || existing.is_root !== 1) changed = true
      upsert.run(sessionId, root.subagentId, root.ownerTurnId, now)
    }
    return changed
  }

  reconcileMetadata(sessionId: string, entries: readonly SessionSubagentMeta[]): boolean {
    const current = this.db.prepare('SELECT * FROM session_subagents WHERE session_id = ? ORDER BY subagent_id').all(sessionId) as Row[]
    const roots = current.filter((row): row is Row & { owner_turn_id: string } => row.is_root === 1 && row.owner_turn_id !== null)
    const metadata = new Map(entries.map((entry) => [entry.subagentId, entry]))
    const reachable = new Map<string, { entry: SessionSubagentMeta; ownerTurnId: string; isRoot: boolean }>()
    for (const root of roots) {
      const entry = metadata.get(root.subagent_id)
      if (entry) reachable.set(root.subagent_id, { entry, ownerTurnId: root.owner_turn_id, isRoot: true })
    }
    let changed = true
    while (changed) {
      changed = false
      for (const entry of entries) {
        if (reachable.has(entry.subagentId) || !entry.parentAgentId) continue
        const parent = reachable.get(entry.parentAgentId)
        if (!parent) continue
        reachable.set(entry.subagentId, { entry, ownerTurnId: parent.ownerTurnId, isRoot: false })
        changed = true
      }
    }

    const next = [...reachable.values()]
    const nextById = new Map(next.map((value) => [value.entry.subagentId, value]))
    const currentById = new Map(current.map((row) => [row.subagent_id, row]))
    const unchanged =
      current.length === roots.length + next.filter(({ isRoot }) => !isRoot).length &&
      current.every((row) => {
        const value = nextById.get(row.subagent_id)
        if (!value) return row.is_root === 1 && row.meta_path === null
        return (
          row.owner_turn_id === value.ownerTurnId &&
          row.is_root === Number(value.isRoot) &&
          row.parent_agent_id === value.entry.parentAgentId &&
          row.agent_type === value.entry.agentType &&
          row.name === value.entry.name &&
          row.description === value.entry.description &&
          row.model === value.entry.model &&
          row.meta_path === value.entry.metaPath &&
          row.meta_file_size === value.entry.metaFileSize &&
          row.meta_file_mtime_ms === value.entry.metaFileMtimeMs &&
          row.transcript_path === value.entry.transcriptPath &&
          row.transcript_file_size === value.entry.transcriptFileSize &&
          row.transcript_file_mtime_ms === value.entry.transcriptFileMtimeMs &&
          row.meta_json === JSON.stringify(value.entry.metaJson)
        )
      })
    if (unchanged) return false

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM session_subagents WHERE session_id = ? AND is_root = 0').run(sessionId)
      this.db
        .prepare(`UPDATE session_subagents SET parent_agent_id = NULL, agent_type = NULL, name = NULL, description = NULL, model = NULL,
          meta_path = NULL, meta_file_size = NULL, meta_file_mtime_ms = NULL, transcript_path = NULL,
          transcript_file_size = NULL, transcript_file_mtime_ms = NULL, meta_json = NULL WHERE session_id = ? AND is_root = 1`)
        .run(sessionId)
      const upsert = this.db.prepare(`
        INSERT INTO session_subagents (
          session_id, subagent_id, owner_turn_id, is_root, parent_agent_id, agent_type, name, description, model,
          meta_path, meta_file_size, meta_file_mtime_ms, transcript_path, transcript_file_size,
          transcript_file_mtime_ms, observed_at_ms, meta_json, usage_transcript_path, usage_parsed_byte_offset, usage_file_mtime_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, subagent_id) DO UPDATE SET
          owner_turn_id = excluded.owner_turn_id, is_root = excluded.is_root, parent_agent_id = excluded.parent_agent_id,
          agent_type = excluded.agent_type, name = excluded.name, description = excluded.description, model = excluded.model,
          meta_path = excluded.meta_path, meta_file_size = excluded.meta_file_size, meta_file_mtime_ms = excluded.meta_file_mtime_ms,
          transcript_path = excluded.transcript_path, transcript_file_size = excluded.transcript_file_size,
          transcript_file_mtime_ms = excluded.transcript_file_mtime_ms, observed_at_ms = excluded.observed_at_ms, meta_json = excluded.meta_json
      `)
      for (const { entry, ownerTurnId, isRoot } of reachable.values()) {
        const priorUsage = currentById.get(entry.subagentId)
        const preserveUsage = priorUsage?.transcript_path === entry.transcriptPath
        upsert.run(
          sessionId,
          entry.subagentId,
          ownerTurnId,
          isRoot ? 1 : 0,
          entry.parentAgentId,
          entry.agentType,
          entry.name,
          entry.description,
          entry.model,
          entry.metaPath,
          entry.metaFileSize,
          entry.metaFileMtimeMs,
          entry.transcriptPath,
          entry.transcriptFileSize,
          entry.transcriptFileMtimeMs,
          entry.observedAtMs,
          JSON.stringify(entry.metaJson),
          preserveUsage ? priorUsage.usage_transcript_path : null,
          preserveUsage ? priorUsage.usage_parsed_byte_offset : 0,
          preserveUsage ? priorUsage.usage_file_mtime_ms : null,
        )
      }
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  get(sessionId: string, subagentId: string): SessionSubagentNode | null {
    const row = this.db.prepare('SELECT * FROM session_subagents WHERE session_id = ? AND subagent_id = ?').get(sessionId, subagentId) as Row | undefined
    return row ? fromRow(row) : null
  }

  countsByTurn(sessionId: string): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT owner_turn_id, COUNT(*) count FROM session_subagents
         WHERE session_id = ? AND owner_turn_id IS NOT NULL AND is_root = 1
         GROUP BY owner_turn_id`,
      )
      .all(sessionId) as Array<{
      owner_turn_id: string
      count: number
    }>
    return new Map(rows.map((row) => [row.owner_turn_id, row.count]))
  }

  listTurn(sessionId: string, ownerTurnId: string): SessionSubagentNode[] {
    const rows = this.db.prepare(`SELECT * FROM session_subagents WHERE session_id = ? AND owner_turn_id = ? ORDER BY is_root DESC, observed_at_ms, subagent_id`).all(sessionId, ownerTurnId) as Row[]
    return rows.map(fromRow).filter((row): row is SessionSubagentNode => row !== null)
  }

  deleteSession(sessionId: string): void {
    this.db.prepare('DELETE FROM session_subagents WHERE session_id = ?').run(sessionId)
  }
}
