import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import { isPrimaryTimelineUserMessage, permissionModeSchema, effortLevelSchema, type EffortLevel, type PermissionMode, type SessionTimelineResponse, type TurnMetaTranscriptResponse, type TurnMetaTranscriptRow, type TurnSummary } from '@cotta/shared'
import { SessionMetaStore } from './session-meta-store.js'
import type { SettingsStore } from './settings-store.js'
import { mergeTranscriptModelEffort, readSettings } from './turn-options.js'

export type ChangedTranscriptSession = {
  projectId: string
  projectPath: string
  sessionInfo: SDKSessionInfo
}

type JsonRecord = Record<string, unknown>
type Checkpoint = { scan_byte_offset: number | null; scan_line_no: number | null; file_size: number | null; file_mtime_ms: number | null }

const AWAY_SUMMARY_CONFIG_HINT = /\s*\(disable recaps in \/config\)\s*$/

function record(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null
}

function encodedProjectDirectory(projectPath: string): string {
  const encoded = projectPath.replace(/[^a-zA-Z0-9]/g, '-')
  if (encoded.length <= 200) return encoded
  let hash = 0
  for (let index = 0; index < projectPath.length; index += 1) hash = ((hash << 5) - hash + projectPath.charCodeAt(index)) | 0
  return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function recordOwnership(value: JsonRecord, sessionId: string, owners: Map<string, string>): void {
  if (value.sessionId !== sessionId || value.isSidechain === true || typeof value.uuid !== 'string') return
  if (isPrimaryTimelineUserMessage(value)) {
    owners.set(value.uuid, value.uuid)
    return
  }
  if (typeof value.parentUuid !== 'string') return
  const owner = owners.get(value.parentUuid)
  if (owner) owners.set(value.uuid, owner)
}

function permissionMode(value: unknown): PermissionMode | null {
  return permissionModeSchema.safeParse(value).data ?? null
}

function effortLevel(value: unknown): EffortLevel | null {
  return effortLevelSchema.safeParse(value).data ?? null
}

function assistantModel(value: JsonRecord): string | null {
  return record(value.message) && typeof value.message.model === 'string' ? value.message.model : null
}

function awaySummary(value: JsonRecord): string | null {
  return value.type === 'system' && value.subtype === 'away_summary' && typeof value.content === 'string'
    ? value.content.replace(AWAY_SUMMARY_CONFIG_HINT, '')
    : null
}

export class TurnMetaTranscriptStore {
  private readonly paths = new Map<string, string>()
  private readonly projectsRoot: string
  private readonly sessionMetaStore: SessionMetaStore
  private readonly settingsStore?: SettingsStore
  private closed = false

  constructor(private readonly db: DatabaseSync, options: { claudeConfigDir?: string; sessionMetaStore?: SessionMetaStore; settingsStore?: SettingsStore } = {}) {
    this.projectsRoot = join(resolve(options.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')), 'projects')
    this.sessionMetaStore = options.sessionMetaStore ?? new SessionMetaStore(db)
    this.settingsStore = options.settingsStore
  }

  async syncSessions(sessions: ChangedTranscriptSession[]): Promise<void> {
    if (this.closed) return
    for (const session of sessions) {
      if (this.closed) return
      try {
        const transcriptPath = await this.locateTranscript(session)
        if (this.closed) return
        await this.syncTranscript(session.projectId, session.projectPath, session.sessionInfo.sessionId, transcriptPath)
      } catch (error) {
        if (this.closed && record(error) && error.code === 'ERR_INVALID_STATE') return
        console.error(`turn-meta-transcript:sync failed for ${session.sessionInfo.sessionId}`, error)
      }
    }
  }

  async repairIncompleteTranscripts(): Promise<void> {
    const rows = this.db.prepare(`
      SELECT project_key, transcript_path, session_id, COALESCE(duration_cwd, '') AS project_path
      FROM turn_meta_transcript WHERE duration_uuid IS NULL AND scan_byte_offset = 0
      GROUP BY transcript_path
    `).all() as Array<{ project_key: string; transcript_path: string; session_id: string; project_path: string }>
    for (const row of rows) {
      try {
        await this.syncTranscript(row.project_key, row.project_path, row.session_id, row.transcript_path)
      } catch (error) {
        if (record(error) && error.code === 'ENOENT') {
          this.db.prepare('DELETE FROM turn_meta_transcript WHERE transcript_path = ?').run(row.transcript_path)
          continue
        }
        console.error(`turn-meta-transcript:repair failed for ${row.session_id}`, error)
      }
    }
  }

  listEntries(input: { sessionId?: string; limit: number; offset: number }): TurnMetaTranscriptResponse {
    const where = input.sessionId === undefined ? '' : 'WHERE session_id = ?'
    const params = input.sessionId === undefined ? [] : [input.sessionId]
    const rows = this.db.prepare(`
      SELECT * FROM turn_meta_transcript ${where}
      ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(...params, input.limit + 1, input.offset) as Array<Record<string, unknown>>
    const sessionIds = (this.db.prepare('SELECT DISTINCT session_id FROM turn_meta_transcript ORDER BY session_id').all() as Array<{ session_id: string }>).map((row) => row.session_id)
    const entries = rows.slice(0, input.limit).map((row) => {
      const entry: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(row)) {
        const camel = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
        entry[camel] = key === 'duration_is_sidechain' || key === 'duration_is_meta' ? value === null ? null : value === 1 : value
      }
      return entry as TurnMetaTranscriptRow
    })
    return { entries, sessionIds, limit: input.limit, offset: input.offset, hasMore: rows.length > input.limit }
  }

  loadTimelineMetadata(projectKey: string, sessionId: string): {
    turnMetadata: ReadonlyMap<string, Pick<TurnSummary, 'durationMs' | 'durationTimestampMs' | 'pendingBackgroundAgentCount' | 'awaySummary'>>
    sessionMeta: SessionTimelineResponse['sessionMeta']
  } {
    const rows = this.db.prepare(`
      SELECT primary_user_uuid, duration_ms, duration_timestamp_ms, duration_pending_background_agent_count, away_summary, permission_mode, model, effort
      FROM turn_meta_transcript
      WHERE project_key = ? AND session_id = ?
      ORDER BY primary_timestamp_ms DESC, primary_byte_offset DESC
    `).all(projectKey, sessionId) as Array<{
      primary_user_uuid: string
      duration_ms: number | null
      duration_timestamp_ms: number | null
      duration_pending_background_agent_count: number | null
      away_summary: string | null
      permission_mode: PermissionMode | null
      model: string | null
      effort: EffortLevel | null
    }>
    const turnMetadata = new Map<string, Pick<TurnSummary, 'durationMs' | 'durationTimestampMs' | 'pendingBackgroundAgentCount' | 'awaySummary'>>()
    const storedSessionMeta = this.sessionMetaStore.getSessionMeta(projectKey, sessionId)
    const sessionMeta: SessionTimelineResponse['sessionMeta'] = storedSessionMeta ?? { permissionMode: null, model: null, effort: null }
    let transcriptModelFound = false
    for (const row of rows) {
      if (!turnMetadata.has(row.primary_user_uuid)) {
        turnMetadata.set(row.primary_user_uuid, {
          ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
          ...(row.duration_timestamp_ms !== null ? { durationTimestampMs: row.duration_timestamp_ms } : {}),
          ...(row.duration_pending_background_agent_count !== null ? { pendingBackgroundAgentCount: row.duration_pending_background_agent_count } : {}),
          awaySummary: row.away_summary,
        })
      }
      if (!storedSessionMeta) {
        sessionMeta.permissionMode ??= row.permission_mode
        if (!transcriptModelFound && row.model !== null) {
          sessionMeta.model = row.model
          sessionMeta.effort = row.effort
          transcriptModelFound = true
        }
      }
    }
    return { turnMetadata, sessionMeta }
  }

  timelineVersion(projectKey: string, sessionId: string, baseVersion: string): string {
    const row = this.db.prepare(`
      SELECT MAX(scan_byte_offset) AS scan_byte_offset, MAX(file_size) AS file_size
      FROM turn_meta_transcript
      WHERE project_key = ? AND session_id = ?
    `).get(projectKey, sessionId) as { scan_byte_offset: number | null; file_size: number | null }
    return `${baseVersion}:turn-meta=${row.scan_byte_offset ?? 0}:${row.file_size ?? 0}:${this.sessionMetaStore.timelineVersion(projectKey, sessionId)}`
  }

  close(): void {
    if (this.closed) return
    this.closed = true
  }

  private async locateTranscript(session: ChangedTranscriptSession): Promise<string> {
    const key = `${session.projectId}\0${session.sessionInfo.sessionId}`
    const cached = this.paths.get(key)
    if (cached) {
      try {
        if (await this.matchesSession(cached, session.projectPath, session.sessionInfo.sessionId)) return cached
      } catch {}
      this.paths.delete(key)
    }

    const filename = `${session.sessionInfo.sessionId}.jsonl`
    const exactPath = join(this.projectsRoot, encodedProjectDirectory(session.projectPath), filename)
    try {
      if (await this.matchesSession(exactPath, session.projectPath, session.sessionInfo.sessionId)) {
        this.paths.set(key, exactPath)
        return exactPath
      }
      await stat(exactPath)
      this.paths.set(key, exactPath)
      return exactPath
    } catch {}

    const candidates: string[] = []
    for (const project of await readdir(this.projectsRoot, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      const path = join(this.projectsRoot, project.name, filename)
      try {
        if (await this.matchesSession(path, session.projectPath, session.sessionInfo.sessionId)) candidates.push(path)
      } catch {}
    }
    if (candidates.length !== 1) throw new Error(`expected one exact transcript, found ${candidates.length}`)
    this.paths.set(key, candidates[0]!)
    return candidates[0]!
  }

  private async matchesSession(path: string, projectPath: string, sessionId: string): Promise<boolean> {
    const file = await open(path, 'r')
    try {
      let remainder = Buffer.alloc(0)
      const buffer = Buffer.allocUnsafe(64 * 1024)
      for (;;) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
        if (bytesRead === 0) return false
        const data = Buffer.concat([remainder, buffer.subarray(0, bytesRead)])
        let start = 0
        for (let end = data.indexOf(10, start); end >= 0; end = data.indexOf(10, start)) {
          try {
            const value = JSON.parse(data.subarray(start, end).toString('utf8')) as JsonRecord
            if (value.sessionId === sessionId && value.cwd === projectPath) return true
          } catch {}
          start = end + 1
        }
        remainder = data.subarray(start)
      }
    } finally {
      await file.close()
    }
  }

  private async countLines(path: string, end: number): Promise<number> {
    if (end === 0) return 0
    const file = await open(path, 'r')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let offset = 0
    let lines = 0
    try {
      while (offset < end) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, end - offset), offset)
        if (bytesRead === 0) break
        for (let index = 0; index < bytesRead; index += 1) if (buffer[index] === 10) lines += 1
        offset += bytesRead
      }
      return lines
    } finally {
      await file.close()
    }
  }

  private async readOwnership(path: string, end: number, sessionId: string): Promise<Map<string, string>> {
    const owners = new Map<string, string>()
    if (end === 0) return owners
    const file = await open(path, 'r')
    const bytes = Buffer.alloc(end)
    try {
      await file.read(bytes, 0, bytes.length, 0)
    } finally {
      await file.close()
    }
    let start = 0
    for (let lf = bytes.indexOf(10); lf >= 0; lf = bytes.indexOf(10, start)) {
      try {
        const value: unknown = JSON.parse(bytes.subarray(start, lf).toString('utf8'))
        if (record(value)) recordOwnership(value, sessionId, owners)
      } catch {}
      start = lf + 1
    }
    return owners
  }

  private async syncTranscript(projectKey: string, projectPath: string, sessionId: string, transcriptPath: string): Promise<void> {
    const fileInfo = await stat(transcriptPath)
    const checkpoint = this.db.prepare(`
      SELECT MAX(scan_byte_offset) AS scan_byte_offset, MAX(scan_line_no) AS scan_line_no,
        MAX(file_size) AS file_size, MAX(file_mtime_ms) AS file_mtime_ms
      FROM turn_meta_transcript WHERE transcript_path = ?
    `).get(transcriptPath) as Checkpoint
    let offset = checkpoint.scan_byte_offset ?? 0
    const rewritten = fileInfo.size < offset
      || (checkpoint.file_size != null && fileInfo.size < checkpoint.file_size)
      || (checkpoint.file_size === fileInfo.size && checkpoint.file_mtime_ms != null && Math.trunc(fileInfo.mtimeMs) !== checkpoint.file_mtime_ms)
    if (rewritten) {
      this.db.prepare('DELETE FROM turn_meta_transcript WHERE transcript_path = ?').run(transcriptPath)
      offset = 0
    } else {
      const incomplete = this.db.prepare(`
        SELECT primary_byte_offset FROM turn_meta_transcript
        WHERE transcript_path = ? AND duration_uuid IS NULL
        ORDER BY primary_byte_offset DESC LIMIT 1
      `).get(transcriptPath) as { primary_byte_offset: number } | undefined
      if (incomplete) offset = Math.min(offset, incomplete.primary_byte_offset)
    }
    if (fileInfo.size === offset) return

    const file = await open(transcriptPath, 'r')
    const bytes = Buffer.alloc(fileInfo.size - offset)
    try {
      await file.read(bytes, 0, bytes.length, offset)
    } finally {
      await file.close()
    }
    const lastLf = bytes.lastIndexOf(10)
    if (lastLf < 0) return
    const complete = bytes.subarray(0, lastLf + 1)
    const nextOffset = offset + complete.length
    const now = Date.now()
    let owners = new Map<string, string>()
    let prefixLoaded = offset === 0
    let currentPrimaryUserUuid: string | null = null
    const updateTurnMetadata = (owner: string, options: { permissionMode?: PermissionMode | null; model?: string | null; effort?: EffortLevel | null; awaySummary?: string | null }, observedAtMs = now) => {
      const hasPermission = 'permissionMode' in options && options.permissionMode !== null
      const hasModel = 'model' in options
      const hasEffort = 'effort' in options
      const hasAwaySummary = 'awaySummary' in options && options.awaySummary !== null
      if (!hasPermission && !hasModel && !hasEffort && !hasAwaySummary) return
      if (hasPermission || hasModel || hasEffort) {
        const current = this.sessionMetaStore.getSessionMeta(projectKey, sessionId)
        let model = current?.model ?? null
        let effort = current?.effort ?? null
        if (hasModel || hasEffort) {
          const merged = mergeTranscriptModelEffort({
            currentModel: current?.model ?? null,
            currentEffort: current?.effort ?? null,
            observedModel: hasModel ? options.model ?? null : undefined,
            observedEffort: hasEffort ? options.effort ?? null : undefined,
            settings: readSettings(this.settingsStore),
          })
          model = merged.model
          effort = merged.effort
        }
        this.sessionMetaStore.setSessionMeta(projectKey, sessionId, {
          ...(hasPermission ? { permissionMode: options.permissionMode! } : {}),
          ...(hasModel || hasEffort ? { model, effort } : {}),
        }, observedAtMs)
      }
      this.db.prepare(`
        UPDATE turn_meta_transcript SET
          permission_mode = CASE WHEN ? THEN ? ELSE permission_mode END,
          model = CASE WHEN ? THEN ? ELSE model END,
          effort = CASE WHEN ? THEN ? ELSE effort END,
          away_summary = CASE WHEN ? THEN ? ELSE away_summary END,
          updated_at_ms = ?
        WHERE transcript_path = ? AND primary_user_uuid = ?
      `).run(hasPermission ? 1 : 0, options.permissionMode ?? null, hasModel ? 1 : 0, options.model ?? null, hasEffort ? 1 : 0, options.effort ?? null, hasAwaySummary ? 1 : 0, options.awaySummary ?? null, now, transcriptPath, owner)
    }

    this.db.exec('BEGIN IMMEDIATE')
    try {
      let lineOffset = 0
      let lineNo = offset === (checkpoint.scan_byte_offset ?? 0) ? (checkpoint.scan_line_no ?? 0) : await this.countLines(transcriptPath, offset)
      for (let lf = complete.indexOf(10); lf >= 0; lf = complete.indexOf(10, lineOffset)) {
        const line = complete.subarray(lineOffset, lf)
        const byteOffset = offset + lineOffset
        lineOffset = lf + 1
        lineNo += 1
        let value: JsonRecord
        try {
          const parsed: unknown = JSON.parse(line.toString('utf8'))
          if (!record(parsed)) continue
          value = parsed
        } catch {
          continue
        }

        const summary = awaySummary(value)
        if (summary && value.sessionId === sessionId && typeof value.parentUuid === 'string') {
          let owner = owners.get(value.parentUuid)
          if (!owner && !prefixLoaded) {
            owners = await this.readOwnership(transcriptPath, byteOffset, sessionId)
            prefixLoaded = true
            owner = owners.get(value.parentUuid)
          }
          if (owner) updateTurnMetadata(owner, { awaySummary: summary })
          continue
        }

        if (isPrimaryTimelineUserMessage(value) && typeof value.uuid === 'string') {
          const primaryTimestamp = timestampMs(value.timestamp)
          if (primaryTimestamp === null || value.sessionId !== sessionId) continue
          this.db.prepare(`
            INSERT INTO turn_meta_transcript (
              project_key, transcript_path, session_id, primary_user_uuid, primary_timestamp_ms,
              primary_byte_offset, primary_entrypoint, file_mtime_ms, file_size, scan_byte_offset, scan_line_no,
              created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(transcript_path, primary_user_uuid) DO NOTHING
          `).run(projectKey, transcriptPath, sessionId, value.uuid, primaryTimestamp, byteOffset,
            typeof value.entrypoint === 'string' ? value.entrypoint : null, Math.trunc(fileInfo.mtimeMs), fileInfo.size, nextOffset, lineNo, now, now)
          owners.set(value.uuid, value.uuid)
          currentPrimaryUserUuid = value.uuid
          updateTurnMetadata(value.uuid, { permissionMode: permissionMode(value.permissionMode) }, primaryTimestamp)
          continue
        }

        if (value.type === 'permission-mode' && value.sessionId === sessionId && currentPrimaryUserUuid) {
          updateTurnMetadata(currentPrimaryUserUuid, { permissionMode: permissionMode(value.permissionMode) }, timestampMs(value.timestamp) ?? now)
          continue
        }

        if (value.type === 'assistant' && value.sessionId === sessionId) {
          const owner = typeof value.parentUuid === 'string' ? owners.get(value.parentUuid) : currentPrimaryUserUuid
          if (owner) {
            const model = assistantModel(value)
            const effort = effortLevel(value.effort)
            updateTurnMetadata(owner, { ...(model !== null ? { model, effort } : effort !== null ? { effort } : {}) }, timestampMs(value.timestamp) ?? now)
          }
        }

        if (value.type !== 'system' || value.subtype !== 'turn_duration' || value.isSidechain === true
          || value.sessionId !== sessionId || typeof value.uuid !== 'string' || typeof value.parentUuid !== 'string'
          || typeof value.durationMs !== 'number' || value.durationMs < 0
          || typeof value.messageCount !== 'number' || value.messageCount < 0) {
          recordOwnership(value, sessionId, owners)
          continue
        }
        let owner = owners.get(value.parentUuid)
        if (!owner && !prefixLoaded) {
          owners = await this.readOwnership(transcriptPath, byteOffset, sessionId)
          prefixLoaded = true
          owner = owners.get(value.parentUuid)
        }
        if (!owner) continue
        owners.set(value.uuid, owner)
        const durationTimestamp = timestampMs(value.timestamp)
        if (durationTimestamp === null) continue
        this.db.prepare(`
          UPDATE turn_meta_transcript SET
            duration_uuid = NULL, duration_parent_uuid = NULL, duration_timestamp_ms = NULL, duration_ms = NULL,
            duration_message_count = NULL, duration_line_no = NULL, duration_byte_offset = NULL, duration_byte_length = NULL,
            duration_is_sidechain = NULL, duration_is_meta = NULL, duration_user_type = NULL, duration_entrypoint = NULL,
            duration_cwd = NULL, duration_version = NULL, duration_git_branch = NULL, duration_slug = NULL,
            duration_pending_background_agent_count = NULL, duration_session_kind = NULL, duration_forked_from_json = NULL,
            duration_pending_workflow_count = NULL, duration_payload_json = NULL, updated_at_ms = ?
          WHERE transcript_path = ? AND duration_uuid = ? AND primary_user_uuid <> ?
        `).run(now, transcriptPath, value.uuid, owner)
        this.db.prepare(`
          UPDATE turn_meta_transcript SET
            duration_uuid = ?, duration_parent_uuid = ?, duration_timestamp_ms = ?,
            duration_ms = CASE WHEN duration_uuid = ? THEN duration_ms ELSE COALESCE(duration_ms, 0) + ? END,
            duration_message_count = ?, duration_line_no = ?, duration_byte_offset = ?, duration_byte_length = ?,
            duration_is_sidechain = ?, duration_is_meta = ?, duration_user_type = ?, duration_entrypoint = ?,
            duration_cwd = ?, duration_version = ?, duration_git_branch = ?, duration_slug = ?,
            duration_pending_background_agent_count = ?, duration_session_kind = ?, duration_forked_from_json = ?,
            duration_pending_workflow_count = ?, duration_payload_json = ?, updated_at_ms = ?
          WHERE transcript_path = ? AND primary_user_uuid = ?
        `).run(value.uuid, value.parentUuid, durationTimestamp, value.uuid, value.durationMs, value.messageCount, lineNo,
          byteOffset, line.length + 1, 0, value.isMeta === true ? 1 : 0,
          typeof value.userType === 'string' ? value.userType : null, typeof value.entrypoint === 'string' ? value.entrypoint : null,
          typeof value.cwd === 'string' ? value.cwd : projectPath, typeof value.version === 'string' ? value.version : null,
          typeof value.gitBranch === 'string' ? value.gitBranch : null, typeof value.slug === 'string' ? value.slug : null,
          typeof value.pendingBackgroundAgentCount === 'number' ? value.pendingBackgroundAgentCount : null,
          typeof value.sessionKind === 'string' ? value.sessionKind : null,
          value.forkedFrom === undefined ? null : JSON.stringify(value.forkedFrom),
          typeof value.pendingWorkflowCount === 'number' ? value.pendingWorkflowCount : null,
          line.toString('utf8'), now, transcriptPath, owner)
      }
      this.db.prepare(`
        UPDATE turn_meta_transcript SET file_mtime_ms = ?, file_size = ?, scan_byte_offset = ?, scan_line_no = ?, updated_at_ms = ?
        WHERE transcript_path = ?
      `).run(Math.trunc(fileInfo.mtimeMs), fileInfo.size, nextOffset, lineNo, now, transcriptPath)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
