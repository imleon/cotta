import type { DatabaseSync } from 'node:sqlite'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  type EffortLevel,
  effortLevelSchema,
  isPrimaryTimelineUserMessage,
  type PermissionMode,
  permissionModeSchema,
  type SessionTimelineResponse,
  type TurnSummary,
  timelineLocalCommand,
} from '@cotta/shared'
import { projectIdFromPath } from './claude-code-api.js'
import type { SettingsStore } from './settings-store.js'
import { TranscriptIndexStore } from './transcript-index-store.js'
import { mergeTranscriptModelEffort, readSettings } from './turn-options.js'
import { TurnOptionsStore } from './turn-options-store.js'

type JsonRecord = Record<string, unknown>
type CachedSessionRow = {
  current_project_id: string | null
  current_cwd: string | null
  transcript_path: string | null
  file_size: number | null
  file_mtime_ms: number | null
}
type RawLineRow = {
  byte_offset: number
  byte_length: number
  line_no: number
  owner_turn_id: string | null
  raw_json: string
}

const AWAY_SUMMARY_CONFIG_HINT = /\s*\(disable recaps in \/config\)\s*$/

function record(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
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
  return value.type === 'system' && value.subtype === 'away_summary' && typeof value.content === 'string' ? value.content.replace(AWAY_SUMMARY_CONFIG_HINT, '') : null
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export class TurnMetaTranscriptStore {
  private readonly turnOptionsStore: TurnOptionsStore
  private readonly settingsStore?: SettingsStore
  private closed = false

  constructor(
    private readonly db: DatabaseSync,
    options: { turnOptionsStore?: TurnOptionsStore; settingsStore?: SettingsStore } = {},
  ) {
    this.turnOptionsStore = options.turnOptionsStore ?? new TurnOptionsStore(db)
    this.settingsStore = options.settingsStore
  }

  syncCachedSession(sessionId: string, options: { replace?: boolean } = {}): void {
    if (this.closed) return
    const session = this.db
      .prepare(`
      SELECT current_project_id, current_cwd, transcript_path, file_size, file_mtime_ms
      FROM session_index WHERE session_id = ?
    `)
      .get(sessionId) as CachedSessionRow | undefined
    if (!session?.transcript_path || session.file_size === null || session.file_mtime_ms === null) return

    if (options.replace) this.db.prepare('DELETE FROM turn_meta_transcript WHERE session_id = ?').run(sessionId)

    const checkpoint = this.db
      .prepare(`
      SELECT COALESCE(MAX(scan_byte_offset), 0) AS scan_byte_offset
      FROM turn_meta_transcript WHERE session_id = ? AND transcript_path = ?
    `)
      .get(sessionId, session.transcript_path) as { scan_byte_offset: number }
    let offset = checkpoint.scan_byte_offset
    let replaying = false
    const incomplete = this.db
      .prepare(`
      SELECT primary_byte_offset FROM turn_meta_transcript
      WHERE session_id = ? AND transcript_path = ? AND duration_uuid IS NULL
      ORDER BY primary_byte_offset DESC LIMIT 1
    `)
      .get(sessionId, session.transcript_path) as { primary_byte_offset: number } | undefined
    if (incomplete) {
      offset = Math.min(offset, incomplete.primary_byte_offset)
      replaying = true
    }

    const rows = this.db
      .prepare(`
      SELECT byte_offset, byte_length, line_no, owner_turn_id, raw_json
      FROM session_raw_transcript_lines
      WHERE session_id = ? AND byte_offset >= ?
      ORDER BY byte_offset ASC
    `)
      .all(sessionId, offset) as RawLineRow[]
    if (rows.length === 0) {
      if (options.replace) new TranscriptIndexStore(this.db).updateSessionActivity(sessionId, null)
      return
    }
    const parentEvidence = new Map(
      (
        this.db
          .prepare(`
      SELECT uuid, parent_uuid, is_sidechain FROM session_raw_transcript_lines
      WHERE session_id = ? AND uuid IS NOT NULL
    `)
          .all(sessionId) as Array<{ uuid: string; parent_uuid: string | null; is_sidechain: number | null }>
      ).map((row) => [row.uuid, row]),
    )
    const crossesSidechain = (uuid: string): boolean => {
      const seen = new Set<string>()
      for (let current = parentEvidence.get(uuid); current && !seen.has(current.uuid); current = current.parent_uuid ? parentEvidence.get(current.parent_uuid) : undefined) {
        if (current.is_sidechain === 1) return true
        seen.add(current.uuid)
      }
      return false
    }

    const now = Date.now()
    let nextOffset = offset
    let lastLineNo = 0
    const updateTurnMetadata = (
      owner: string,
      projectKey: string,
      options: { permissionMode?: PermissionMode | null; model?: string | null; effort?: EffortLevel | null; awaySummary?: string | null },
      observedAtMs = now,
    ) => {
      const hasPermission = 'permissionMode' in options && options.permissionMode !== null
      const hasModel = 'model' in options
      const hasEffort = 'effort' in options
      const hasAwaySummary = 'awaySummary' in options && options.awaySummary !== null
      if (!hasPermission && !hasModel && !hasEffort && !hasAwaySummary) return
      if (hasPermission || hasModel || hasEffort) {
        const current = this.turnOptionsStore.getSessionTurnOptions(sessionId)
        let model = current?.model ?? null
        let effort = current?.effort ?? null
        if (hasModel || hasEffort) {
          const merged = mergeTranscriptModelEffort({
            currentModel: current?.model ?? null,
            currentEffort: current?.effort ?? null,
            observedModel: hasModel ? (options.model ?? null) : undefined,
            observedEffort: hasEffort ? (options.effort ?? null) : undefined,
            settings: readSettings(this.settingsStore),
          })
          model = merged.model
          effort = merged.effort
        }
        this.turnOptionsStore.setSessionTurnOptions(
          sessionId,
          {
            ...(hasPermission ? { permissionMode: options.permissionMode! } : {}),
            ...(hasModel || hasEffort ? { model, effort } : {}),
          },
          observedAtMs,
        )
      }
      if (!hasAwaySummary) return
      this.db
        .prepare(`
        UPDATE turn_meta_transcript SET
          away_summary = ?,
          updated_at_ms = ?
        WHERE transcript_path = ? AND primary_user_uuid = ?
      `)
        .run(options.awaySummary ?? null, now, session.transcript_path, owner)
    }

    if (replaying) {
      this.db
        .prepare(`
        UPDATE turn_meta_transcript SET
          duration_uuid = NULL, duration_parent_uuid = NULL, duration_timestamp_ms = NULL, duration_ms = NULL,
          duration_message_count = NULL, duration_line_no = NULL, duration_byte_offset = NULL, duration_byte_length = NULL,
          duration_is_sidechain = NULL, duration_is_meta = NULL, duration_user_type = NULL, duration_entrypoint = NULL,
          duration_cwd = NULL, duration_version = NULL, duration_git_branch = NULL, duration_slug = NULL,
          duration_pending_background_agent_count = NULL, duration_session_kind = NULL, duration_forked_from_json = NULL,
          duration_pending_workflow_count = NULL, duration_payload_json = NULL, updated_at_ms = ?
        WHERE transcript_path = ? AND primary_byte_offset >= ?
      `)
        .run(now, session.transcript_path, offset)
    }

    for (const row of rows) {
      nextOffset = Math.max(nextOffset, row.byte_offset + row.byte_length)
      lastLineNo = Math.max(lastLineNo, row.line_no)
      let value: JsonRecord
      try {
        const parsed: unknown = JSON.parse(row.raw_json)
        if (!record(parsed)) continue
        value = parsed
      } catch {
        continue
      }
      const projectKey = session.current_project_id ?? (typeof value.cwd === 'string' ? projectIdFromPath(value.cwd) : null)
      if (!projectKey) continue

      const summary = awaySummary(value)
      if (summary && value.sessionId === sessionId && row.owner_turn_id) {
        updateTurnMetadata(row.owner_turn_id, projectKey, { awaySummary: summary })
        continue
      }

      if ((isPrimaryTimelineUserMessage(value) || timelineLocalCommand(value) !== null) && typeof value.uuid === 'string') {
        const primaryTimestamp = timestampMs(value.timestamp)
        // Do not fall back to session_raw_transcript_lines.created_at_ms here: that is Cotta's cache ingest time,
        // not the emitter receive time required for timestamp-less SDK user messages.
        if (primaryTimestamp === null || value.sessionId !== sessionId) continue
        this.db
          .prepare(`
          INSERT INTO turn_meta_transcript (
            project_key, transcript_path, session_id, primary_user_uuid, primary_timestamp_ms,
            primary_byte_offset, primary_entrypoint, file_mtime_ms, file_size, scan_byte_offset, scan_line_no,
            created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(transcript_path, primary_user_uuid) DO NOTHING
        `)
          .run(
            projectKey,
            session.transcript_path,
            sessionId,
            value.uuid,
            primaryTimestamp,
            row.byte_offset,
            typeof value.entrypoint === 'string' ? value.entrypoint : null,
            session.file_mtime_ms,
            session.file_size,
            nextOffset,
            row.line_no,
            now,
            now,
          )
        updateTurnMetadata(value.uuid, projectKey, { permissionMode: permissionMode(value.permissionMode) }, primaryTimestamp)
        continue
      }

      if (value.type === 'permission-mode' && value.sessionId === sessionId && row.owner_turn_id) {
        updateTurnMetadata(row.owner_turn_id, projectKey, { permissionMode: permissionMode(value.permissionMode) }, timestampMs(value.timestamp) ?? now)
        continue
      }

      if (value.type === 'assistant' && value.sessionId === sessionId && value.isSidechain !== true && row.owner_turn_id) {
        const observedAtMs = timestampMs(value.timestamp)
        const model = assistantModel(value)
        const effort = effortLevel(value.effort)
        updateTurnMetadata(row.owner_turn_id, projectKey, { ...(model !== null ? { model, effort } : effort !== null ? { effort } : {}) }, observedAtMs ?? now)
      }

      if (
        value.type !== 'system' ||
        value.subtype !== 'turn_duration' ||
        value.isSidechain === true ||
        value.sessionId !== sessionId ||
        typeof value.uuid !== 'string' ||
        typeof value.parentUuid !== 'string' ||
        typeof value.durationMs !== 'number' ||
        value.durationMs < 0 ||
        typeof value.messageCount !== 'number' ||
        value.messageCount < 0 ||
        !row.owner_turn_id ||
        crossesSidechain(value.parentUuid)
      )
        continue
      const owner = row.owner_turn_id
      const durationTimestamp = timestampMs(value.timestamp)
      if (durationTimestamp === null) continue
      this.db
        .prepare(`
        UPDATE turn_meta_transcript SET
          duration_uuid = NULL, duration_parent_uuid = NULL, duration_timestamp_ms = NULL, duration_ms = NULL,
          duration_message_count = NULL, duration_line_no = NULL, duration_byte_offset = NULL, duration_byte_length = NULL,
          duration_is_sidechain = NULL, duration_is_meta = NULL, duration_user_type = NULL, duration_entrypoint = NULL,
          duration_cwd = NULL, duration_version = NULL, duration_git_branch = NULL, duration_slug = NULL,
          duration_pending_background_agent_count = NULL, duration_session_kind = NULL, duration_forked_from_json = NULL,
          duration_pending_workflow_count = NULL, duration_payload_json = NULL, updated_at_ms = ?
        WHERE transcript_path = ? AND duration_uuid = ? AND primary_user_uuid <> ?
      `)
        .run(now, session.transcript_path, value.uuid, owner)
      this.db
        .prepare(`
        UPDATE turn_meta_transcript SET
          duration_uuid = ?, duration_parent_uuid = ?, duration_timestamp_ms = ?,
          duration_ms = CASE WHEN duration_uuid = ? THEN duration_ms ELSE COALESCE(duration_ms, 0) + ? END,
          duration_message_count = ?, duration_line_no = ?, duration_byte_offset = ?, duration_byte_length = ?,
          duration_is_sidechain = ?, duration_is_meta = ?, duration_user_type = ?, duration_entrypoint = ?,
          duration_cwd = ?, duration_version = ?, duration_git_branch = ?, duration_slug = ?,
          duration_pending_background_agent_count = ?, duration_session_kind = ?, duration_forked_from_json = ?,
          duration_pending_workflow_count = ?, duration_payload_json = ?, updated_at_ms = ?
        WHERE transcript_path = ? AND primary_user_uuid = ?
      `)
        .run(
          value.uuid,
          value.parentUuid,
          durationTimestamp,
          value.uuid,
          value.durationMs,
          value.messageCount,
          row.line_no,
          row.byte_offset,
          row.byte_length,
          0,
          value.isMeta === true ? 1 : 0,
          typeof value.userType === 'string' ? value.userType : null,
          typeof value.entrypoint === 'string' ? value.entrypoint : null,
          typeof value.cwd === 'string' ? value.cwd : session.current_cwd,
          typeof value.version === 'string' ? value.version : null,
          typeof value.gitBranch === 'string' ? value.gitBranch : null,
          typeof value.slug === 'string' ? value.slug : null,
          typeof value.pendingBackgroundAgentCount === 'number' ? value.pendingBackgroundAgentCount : null,
          typeof value.sessionKind === 'string' ? value.sessionKind : null,
          value.forkedFrom === undefined ? null : JSON.stringify(value.forkedFrom),
          typeof value.pendingWorkflowCount === 'number' ? value.pendingWorkflowCount : null,
          row.raw_json,
          now,
          session.transcript_path,
          owner,
        )
    }

    this.db
      .prepare(`
      UPDATE turn_meta_transcript SET file_mtime_ms = ?, file_size = ?, scan_byte_offset = ?, scan_line_no = ?, updated_at_ms = ?
      WHERE session_id = ? AND transcript_path = ?
    `)
      .run(session.file_mtime_ms, session.file_size, nextOffset, lastLineNo, now, sessionId, session.transcript_path)
    const activity = this.db
      .prepare(`SELECT MAX(COALESCE(duration_timestamp_ms, primary_timestamp_ms)) AS value FROM turn_meta_transcript WHERE session_id = ? AND transcript_path = ?`)
      .get(sessionId, session.transcript_path) as { value: number | null }
    new TranscriptIndexStore(this.db).updateSessionActivity(sessionId, activity.value)
  }

  recordLiveResult(_projectKey: string, sessionId: string, userMessageUuid: string, message: SDKMessage): void {
    if (!record(message) || message.type !== 'result' || !userMessageUuid) return
    const durationMs = nonNegativeNumber(message.duration_ms)
    const durationApiMs = nonNegativeNumber(message.duration_api_ms)
    if (durationMs === null || typeof message.uuid !== 'string' || typeof message.subtype !== 'string') return
    const now = Date.now()
    this.db
      .prepare(`
      INSERT INTO turn_meta_live (
        session_id, primary_user_uuid, result_uuid, result_subtype, is_error, terminal_reason,
        duration_ms, duration_api_ms, result_recorded_at_ms, payload_json, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, primary_user_uuid) DO UPDATE SET
        result_uuid = excluded.result_uuid,
        result_subtype = excluded.result_subtype,
        is_error = excluded.is_error,
        terminal_reason = excluded.terminal_reason,
        duration_ms = excluded.duration_ms,
        duration_api_ms = excluded.duration_api_ms,
        result_recorded_at_ms = excluded.result_recorded_at_ms,
        payload_json = excluded.payload_json,
        updated_at_ms = excluded.updated_at_ms
    `)
      .run(
        sessionId,
        userMessageUuid,
        message.uuid,
        message.subtype,
        message.is_error === true ? 1 : 0,
        typeof message.terminal_reason === 'string' ? message.terminal_reason : null,
        durationMs,
        durationApiMs,
        now,
        JSON.stringify(message),
        now,
      )
  }

  loadTimelineMetadata(
    projectKey: string,
    sessionId: string,
  ): {
    turnMetadata: ReadonlyMap<string, Pick<TurnSummary, 'durationMs' | 'durationTimestampMs' | 'entrypoint' | 'pendingBackgroundAgentCount' | 'awaySummary'>>
    turnOptions: SessionTimelineResponse['turnOptions']
    scanByteOffset: number | null
    scannedFileSize: number | null
  } {
    const rows = this.db
      .prepare(`
      SELECT primary_user_uuid, primary_entrypoint, duration_ms, duration_timestamp_ms, duration_pending_background_agent_count, away_summary, scan_byte_offset, file_size
      FROM turn_meta_transcript
      WHERE project_key = ? AND session_id = ?
      ORDER BY primary_timestamp_ms DESC, primary_byte_offset DESC
    `)
      .all(projectKey, sessionId) as Array<{
      primary_user_uuid: string
      primary_entrypoint: string | null
      duration_ms: number | null
      duration_timestamp_ms: number | null
      duration_pending_background_agent_count: number | null
      away_summary: string | null
      scan_byte_offset: number | null
      file_size: number | null
    }>
    const liveResults = new Map(
      (
        this.db
          .prepare(`
      SELECT primary_user_uuid, duration_ms, result_recorded_at_ms
      FROM turn_meta_live
      WHERE session_id = ?
    `)
          .all(sessionId) as Array<{ primary_user_uuid: string; duration_ms: number; result_recorded_at_ms: number }>
      ).map((row) => [
        row.primary_user_uuid,
        {
          durationMs: row.duration_ms,
          recordedAtMs: row.result_recorded_at_ms,
        },
      ]),
    )
    const turnMetadata = new Map<string, Pick<TurnSummary, 'durationMs' | 'durationTimestampMs' | 'entrypoint' | 'pendingBackgroundAgentCount' | 'awaySummary'>>()
    const turnOptions = this.turnOptionsStore.getSessionTurnOptions(sessionId) ?? { permissionMode: null, model: null, effort: null }
    for (const row of rows) {
      if (turnMetadata.has(row.primary_user_uuid)) continue
      const liveResult = liveResults.get(row.primary_user_uuid)
      const durationMs = row.duration_ms ?? liveResult?.durationMs
      const durationTimestampMs = row.duration_timestamp_ms ?? (row.primary_entrypoint === 'sdk-ts' ? liveResult?.recordedAtMs : undefined)
      turnMetadata.set(row.primary_user_uuid, {
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(durationTimestampMs !== undefined ? { durationTimestampMs } : {}),
        ...(row.primary_entrypoint !== null ? { entrypoint: row.primary_entrypoint } : {}),
        ...(row.duration_pending_background_agent_count !== null ? { pendingBackgroundAgentCount: row.duration_pending_background_agent_count } : {}),
        awaySummary: row.away_summary,
      })
    }
    return {
      turnMetadata,
      turnOptions,
      scanByteOffset: rows.reduce<number | null>((max, row) => (row.scan_byte_offset === null ? max : Math.max(max ?? 0, row.scan_byte_offset)), null),
      scannedFileSize: rows.reduce<number | null>((max, row) => (row.file_size === null ? max : Math.max(max ?? 0, row.file_size)), null),
    }
  }

  timelineVersion(projectKey: string, sessionId: string, baseVersion: string): string {
    const row = this.db
      .prepare(`
      SELECT MAX(scan_byte_offset) AS scan_byte_offset, MAX(file_size) AS file_size
      FROM turn_meta_transcript
      WHERE project_key = ? AND session_id = ?
    `)
      .get(projectKey, sessionId) as { scan_byte_offset: number | null; file_size: number | null }
    const live = this.db
      .prepare(`
      SELECT COUNT(*) AS count, MAX(result_recorded_at_ms) AS result_recorded_at_ms
      FROM turn_meta_live
      WHERE session_id = ?
    `)
      .get(sessionId) as { count: number; result_recorded_at_ms: number | null }
    return `${baseVersion}:turn-meta=${row.scan_byte_offset ?? 0}:${row.file_size ?? 0}:${this.turnOptionsStore.timelineVersion(projectKey, sessionId)}:live-results=${live.count}:${live.result_recorded_at_ms ?? 0}`
  }

  close(): void {
    if (this.closed) return
    this.closed = true
  }
}
