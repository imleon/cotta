import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { isPrimaryTimelineUserMessage, type SessionRawTranscriptLine, timelineLocalCommand, timelineToolUseResult } from '@cotta/shared'
import { projectIdFromPath, projectTranscriptDirName } from './project-path.js'
import { SessionSearchStore } from './session-search-store.js'
import type { SessionSubagentStore } from './session-subagent-store.js'
import type { TokenUsageStore } from './token-usage-store.js'
import { TranscriptIndexStore } from './transcript-index-store.js'
import { repairTranscriptOwnershipRows } from './transcript-ownership-repair.js'
import { materializeTranscriptTurnOwnership, seedTranscriptTurnOwnershipState } from './transcript-turn-ownership.js'
import type { TurnMetaTranscriptStore } from './turn-meta-transcript.js'

type JsonRecord = Record<string, unknown>
type Checkpoint = { cachedUntilByte: number; lineCount: number }
export type RawTranscriptChange = {
  changed: true
  projectId?: string
  previousProjectId?: string
  sessionId: string
  version: string
  reset: boolean
  invalidateFromTurnId: string | null
  subagentRootsChanged: boolean
}
export type RawTranscriptSyncResult = { changed: false } | RawTranscriptChange
export type RawTimelineWindow = {
  primaryTurns: Array<{ uuid: string; timestamp: number | null; userCwd?: string; responseCwd?: string }>
  ownedMessages: Array<{ ownerTurnId: string; message: SessionMessage }>
  hasMore: boolean
  hasNewer: boolean
  nextCursor: string | null
  snapshotFromTurnId: string | null
  anchorTurnId: string | null
  version: string
  fileSize: number
}

export class TimelineAnchorStaleError extends Error {
  constructor(readonly kind: 'cursor' | 'invalidation' | 'anchor') {
    super(`timeline ${kind} stale`)
  }
}
type PromptExtraction = { firstPrompt?: string; commandFallback?: string; locked?: boolean }
export type ParsedTranscriptLine = {
  offset: number
  byteLength: number
  raw: string
  value: JsonRecord
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

const requestMarkup = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/
const commandName = /<command-name>(.*?)<\/command-name>/
const bashInput = /<bash-input>([\s\S]*?)<\/bash-input>/

function truncatePrompt(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200).trim()}…` : text
}

function extractPromptCandidate(value: JsonRecord, currentCommandFallback: string | null): PromptExtraction {
  if (value.type !== 'user' || value.isMeta === true || value.isCompactSummary === true || !isPrimaryTimelineUserMessage(value)) return {}
  const message = isRecord(value.message) ? value.message : null
  const content = message?.content
  const texts: string[] = []
  let hasImage = false
  if (typeof content === 'string') texts.push(content)
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block.type === 'tool_result') return {}
      if (block.type === 'image') hasImage = true
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    }
  }
  let commandFallback: string | undefined
  for (const raw of texts) {
    const text = raw.replaceAll('\n', ' ').trim()
    if (!text) continue
    const command = commandName.exec(text)
    if (command) {
      if (!currentCommandFallback && !commandFallback) commandFallback = command[1]
      continue
    }
    const bash = bashInput.exec(text)
    if (bash) return { firstPrompt: `! ${bash[1].trim()}`, commandFallback, locked: true }
    if (requestMarkup.test(text)) continue
    return { firstPrompt: truncatePrompt(text), commandFallback, locked: true }
  }
  if (hasImage) return { firstPrompt: 'Image prompt', commandFallback, locked: true }
  return commandFallback ? { commandFallback } : {}
}

const rawLineColumns =
  'session_id, byte_offset, byte_length, line_no, uuid, type, timestamp_ms, parent_uuid, is_sidechain, user_type, entrypoint, cwd, version, git_branch, owner_turn_id, raw_json, created_at_ms'

export async function readCompleteTranscriptLines(transcriptPath: string, startOffset: number, snapshotSize: number): Promise<ParsedTranscriptLine[]> {
  const file = await open(transcriptPath, 'r')
  const output: ParsedTranscriptLine[] = []
  let offset = startOffset
  let remainder = Buffer.alloc(0)
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    while (offset + remainder.length < snapshotSize) {
      const position = offset + remainder.length
      const length = Math.min(buffer.length, snapshotSize - position)
      const { bytesRead } = await file.read(buffer, 0, length, position)
      if (bytesRead === 0) break
      const data = Buffer.concat([remainder, buffer.subarray(0, bytesRead)])
      let lineStart = 0
      for (let lineEnd = data.indexOf(10, lineStart); lineEnd >= 0; lineEnd = data.indexOf(10, lineStart)) {
        const raw = data.subarray(lineStart, lineEnd).toString('utf8').trim()
        const byteLength = lineEnd - lineStart + 1
        if (raw) {
          try {
            const value = JSON.parse(raw)
            if (!isRecord(value)) throw new Error('line is not a JSON object')
            output.push({ offset: offset + lineStart, byteLength, raw, value })
          } catch (error) {
            console.error(`session-raw-transcript-cache:skip malformed line at byte ${offset + lineStart} in ${transcriptPath}`, error)
          }
        }
        lineStart = lineEnd + 1
      }
      offset += lineStart
      remainder = data.subarray(lineStart)
    }
    return output
  } finally {
    await file.close()
  }
}

export class TranscriptUnavailableError extends Error {
  constructor(sessionId: string) {
    super(`transcript unavailable for ${sessionId}`)
  }
}

export class SessionRawTranscriptCacheStore {
  readonly projectsRoot: string
  readonly index: TranscriptIndexStore
  private readonly syncing = new Map<string, Promise<RawTranscriptSyncResult>>()

  private readonly turnMetaStore?: TurnMetaTranscriptStore
  private readonly subagentStore?: SessionSubagentStore
  private readonly tokenUsageStore?: TokenUsageStore
  private readonly sessionSearchStore: SessionSearchStore

  constructor(
    private readonly db: DatabaseSync,
    options: { claudeConfigDir?: string; turnMetaStore?: TurnMetaTranscriptStore; subagentStore?: SessionSubagentStore; tokenUsageStore?: TokenUsageStore } = {},
  ) {
    this.projectsRoot = join(resolve(options.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')), 'projects')
    this.index = new TranscriptIndexStore(db)
    this.turnMetaStore = options.turnMetaStore
    this.subagentStore = options.subagentStore
    this.tokenUsageStore = options.tokenUsageStore
    this.sessionSearchStore = new SessionSearchStore(db, this.index)
    this.db.function('is_local_command_turn', { deterministic: true }, (rawJson) => (typeof rawJson === 'string' && timelineLocalCommand(JSON.parse(rawJson)) ? 1 : 0))
  }

  async ensureSessionCached(sessionId: string, _fileSize?: number): Promise<RawTranscriptSyncResult> {
    return this.ensureSessionCachedById(sessionId)
  }

  async ensureSessionCachedById(sessionId: string): Promise<RawTranscriptSyncResult> {
    const existing = this.syncing.get(sessionId)
    if (existing) return existing
    const syncing = this.syncSession(sessionId).finally(() => {
      if (this.syncing.get(sessionId) === syncing) this.syncing.delete(sessionId)
    })
    this.syncing.set(sessionId, syncing)
    return syncing
  }

  async resolveTranscriptPath(sessionId: string): Promise<string> {
    return this.locateTranscript(sessionId)
  }

  missingSearchIndexSessionIds(): Set<string> {
    return new Set(
      (
        this.db
          .prepare(`
      SELECT si.session_id
      FROM session_index si
      LEFT JOIN session_search_state ss ON ss.session_id = si.session_id
      WHERE (si.transcript_path IS NOT NULL OR EXISTS (
        SELECT 1 FROM session_raw_transcript_lines raw WHERE raw.session_id = si.session_id
      )) AND (ss.session_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM session_search_documents doc WHERE doc.session_id = si.session_id
      ))
    `)
          .all() as Array<{ session_id: string }>
      ).map((row) => row.session_id),
    )
  }

  prepareSearchIndex(): boolean {
    const searchRulesChanged = this.sessionSearchStore.needsRulesVersionUpdate()
    if (searchRulesChanged) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        repairTranscriptOwnershipRows(this.db)
        const roots = this.db
          .prepare(`
            SELECT session_id, COALESCE(json_extract(raw_json, '$.tool_use_result.agentId'), json_extract(raw_json, '$.toolUseResult.agentId')) AS subagent_id, owner_turn_id
            FROM session_raw_transcript_lines
            WHERE owner_turn_id IS NOT NULL AND COALESCE(json_extract(raw_json, '$.tool_use_result.agentId'), json_extract(raw_json, '$.toolUseResult.agentId')) IS NOT NULL
          `)
          .all() as Array<{ session_id: string; subagent_id: string; owner_turn_id: string }>
        for (const sessionId of new Set(roots.map((root) => root.session_id)))
          this.subagentStore?.recordRoots(
            sessionId,
            roots.filter((root) => root.session_id === sessionId).map(({ subagent_id, owner_turn_id }) => ({ subagentId: subagent_id, ownerTurnId: owner_turn_id })),
            true,
          )
        this.db.exec('DELETE FROM turn_meta_transcript;')
        this.sessionSearchStore.prepareRulesVersion({ inTransaction: true })
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    const sessions = this.index.listTranscriptSessions()
    for (const sessionId of this.missingSearchIndexSessionIds()) this.sessionSearchStore.rebuildSession(sessionId)
    return sessions.length > 0
  }

  timelineVersion(sessionId: string): string | null {
    const indexed = this.index.getSession(sessionId)
    if (!indexed?.transcriptPath || indexed.fileSize == null || indexed.fileMtimeMs == null) return null
    const checkpoint = this.checkpoint(sessionId)
    return `raw-v1:path=${Buffer.from(indexed.transcriptPath).toString('base64url')};mtime=${indexed.fileMtimeMs};size=${indexed.fileSize};lines=${checkpoint.lineCount}`
  }

  deleteCachedSession(sessionId: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.tokenUsageStore?.deleteSession(sessionId)
      this.sessionSearchStore.clearSession(sessionId)
      for (const table of ['turn_meta_live', 'turn_meta_transcript', 'session_raw_transcript_lines', 'session_subagents', 'session_pins'])
        this.db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId)
      this.index.deleteSession(sessionId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  loadRawLinesForTurn(sessionId: string, turnId: string): SessionRawTranscriptLine[] | null {
    const rows = this.db
      .prepare(`
      SELECT ${rawLineColumns} FROM session_raw_transcript_lines
      WHERE session_id = ? AND owner_turn_id = ? ORDER BY byte_offset ASC
    `)
      .all(sessionId, turnId) as SessionRawTranscriptLine[]
    return rows.length > 0 ? rows : null
  }

  loadRawLinesByUuid(sessionId: string, messageUuid: string): SessionRawTranscriptLine[] {
    return this.db
      .prepare(`
      SELECT ${rawLineColumns} FROM session_raw_transcript_lines
      WHERE session_id = ? AND uuid = ? ORDER BY byte_offset ASC
    `)
      .all(sessionId, messageUuid) as SessionRawTranscriptLine[]
  }

  adjacentTurnIds(
    sessionId: string,
    turnId: string,
    options: { excludeLocalCommandTurns?: boolean } = {},
  ): { firstTurnId: string; previousTurnId: string | null; nextTurnId: string | null; latestTurnId: string } | null {
    const localCommandFilter = options.excludeLocalCommandTurns ? 'AND is_local_command_turn(l.raw_json) = 0' : ''
    const row = this.db
      .prepare(`
        WITH turns AS (
          SELECT l.uuid, MIN(l.byte_offset) AS byte_offset
          FROM session_raw_transcript_lines l
          WHERE l.session_id = ? AND l.owner_turn_id = l.uuid ${localCommandFilter}
          GROUP BY l.uuid
        ), navigation AS (
          SELECT uuid,
            FIRST_VALUE(uuid) OVER turn_order AS first_turn_id,
            LAG(uuid) OVER turn_order AS previous_turn_id,
            LEAD(uuid) OVER turn_order AS next_turn_id,
            LAST_VALUE(uuid) OVER turn_order AS latest_turn_id
          FROM turns
          WINDOW turn_order AS (ORDER BY byte_offset ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
        )
        SELECT first_turn_id, previous_turn_id, next_turn_id, latest_turn_id FROM navigation WHERE uuid = ?
      `)
      .get(sessionId, turnId) as { first_turn_id: string; previous_turn_id: string | null; next_turn_id: string | null; latest_turn_id: string } | undefined
    return row ? { firstTurnId: row.first_turn_id, previousTurnId: row.previous_turn_id, nextTurnId: row.next_turn_id, latestTurnId: row.latest_turn_id } : null
  }

  loadTimelineWindow(
    sessionId: string,
    options: { limitTurns: number; cursor: string | null; fromTurnId: string | null; anchorTurnId?: string | null; excludeLocalCommandTurns?: boolean },
  ): RawTimelineWindow {
    this.db.exec('BEGIN')
    try {
      const indexed = this.index.getSession(sessionId)
      if (!indexed?.transcriptPath || indexed.fileSize === null || indexed.fileSize === undefined || indexed.fileMtimeMs === null || indexed.fileMtimeMs === undefined)
        throw new TranscriptUnavailableError(sessionId)
      const anchorTurnId = options.anchorTurnId ?? null
      const localCommandFilter = options.excludeLocalCommandTurns ? 'AND is_local_command_turn(l.raw_json) = 0' : ''
      const anchorKind = options.cursor ? 'cursor' : options.fromTurnId ? 'invalidation' : anchorTurnId ? 'anchor' : null
      const anchorId = options.cursor ?? options.fromTurnId ?? anchorTurnId
      const anchor = anchorId
        ? (this.db
            .prepare(`
        SELECT MIN(l.byte_offset) AS byte_offset FROM session_raw_transcript_lines l
        WHERE l.session_id = ? AND l.uuid = ? AND l.owner_turn_id = l.uuid ${localCommandFilter}
        HAVING byte_offset IS NOT NULL
      `)
            .get(sessionId, anchorId) as { byte_offset: number } | undefined)
        : undefined
      if (anchorId && !anchor) throw new TimelineAnchorStaleError(anchorKind ?? 'invalidation')

      const primaryTurnsSql = `
        SELECT l.uuid, l.timestamp_ms AS timestamp, l.byte_offset, l.cwd
        FROM session_raw_transcript_lines l
        JOIN (
          SELECT root.uuid, MIN(root.byte_offset) AS byte_offset
          FROM session_raw_transcript_lines root
          WHERE root.session_id = ? AND root.owner_turn_id = root.uuid ${options.excludeLocalCommandTurns ? 'AND is_local_command_turn(root.raw_json) = 0' : ''}
          GROUP BY root.uuid
        ) picked ON picked.uuid = l.uuid AND picked.byte_offset = l.byte_offset
        WHERE l.session_id = ?`
      const primary = (
        options.fromTurnId
          ? this.db.prepare(`${primaryTurnsSql} AND l.byte_offset >= ? ORDER BY l.byte_offset`).all(sessionId, sessionId, anchor!.byte_offset)
          : anchorTurnId
            ? this.db.prepare(`${primaryTurnsSql} AND l.byte_offset <= ? ORDER BY l.byte_offset DESC LIMIT ?`).all(sessionId, sessionId, anchor!.byte_offset, options.limitTurns + 1)
            : this.db
                .prepare(`${primaryTurnsSql} AND (? IS NULL OR l.byte_offset < ?) ORDER BY l.byte_offset DESC LIMIT ?`)
                .all(sessionId, sessionId, anchor?.byte_offset ?? null, anchor?.byte_offset ?? null, options.limitTurns + 1)
      ) as Array<{ uuid: string; timestamp: number | null; byte_offset: number; cwd: string | null }>
      const selected = options.fromTurnId ? primary : primary.slice(0, options.limitTurns).reverse()
      const hasMore = options.fromTurnId ? false : primary.length > options.limitTurns
      const hasNewer = anchorTurnId
        ? Boolean(this.db.prepare(`${primaryTurnsSql} AND l.byte_offset > ? LIMIT 1`).get(sessionId, sessionId, anchor!.byte_offset) as { uuid: string } | undefined)
        : false
      const nextCursor = !options.fromTurnId && hasMore ? (selected[0]?.uuid ?? null) : null
      const selectedIds = selected.map((row) => row.uuid)
      const rows =
        selectedIds.length === 0
          ? []
          : (this.db
              .prepare(`
        SELECT uuid, owner_turn_id, raw_json, cwd FROM session_raw_transcript_lines
        WHERE session_id = ? AND owner_turn_id IN (${selectedIds.map(() => '?').join(', ')})
        ORDER BY byte_offset
      `)
              .all(sessionId, ...selectedIds) as Array<{ uuid: string | null; owner_turn_id: string; raw_json: string; cwd: string | null }>)
      const parsedRows = rows.map((row) => ({ ...row, message: JSON.parse(row.raw_json) as SessionMessage }))
      const responseCwdByTurn = new Map<string, string>()
      for (const row of parsedRows) if (row.uuid !== row.owner_turn_id && row.cwd?.trim()) responseCwdByTurn.set(row.owner_turn_id, row.cwd)
      const ownedMessages = parsedRows.map((row) => ({ ownerTurnId: row.owner_turn_id, message: row.message }))
      const version = this.timelineVersion(sessionId)!
      this.db.exec('COMMIT')
      return {
        primaryTurns: selected.map(({ uuid, timestamp, cwd }) => ({
          uuid,
          timestamp,
          ...(cwd?.trim() ? { userCwd: cwd } : {}),
          ...(responseCwdByTurn.get(uuid) ? { responseCwd: responseCwdByTurn.get(uuid) } : {}),
        })),
        ownedMessages,
        hasMore,
        hasNewer,
        nextCursor,
        snapshotFromTurnId: options.fromTurnId,
        anchorTurnId,
        version,
        fileSize: indexed.fileSize,
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private checkpoint(sessionId: string): Checkpoint {
    const row = this.db
      .prepare(`
      SELECT COALESCE(MAX(byte_offset + byte_length), 0) AS cached_until_byte,
        COALESCE(MAX(line_no), 0) AS line_count
      FROM session_raw_transcript_lines WHERE session_id = ?
    `)
      .get(sessionId) as { cached_until_byte: number; line_count: number }
    return { cachedUntilByte: row.cached_until_byte, lineCount: row.line_count }
  }

  private async syncSession(sessionId: string): Promise<RawTranscriptSyncResult> {
    const indexed = this.index.getSession(sessionId)
    const checkpoint = this.checkpoint(sessionId)
    const transcriptPath = await this.locateTranscript(sessionId)
    const fileInfo = await stat(transcriptPath)
    const fileMtimeMs = Math.trunc(fileInfo.mtimeMs)
    if (
      fileInfo.size < checkpoint.cachedUntilByte ||
      (indexed?.fileSize != null && fileInfo.size < indexed.fileSize) ||
      (indexed?.transcriptPath && indexed.transcriptPath !== transcriptPath) ||
      (indexed?.fileSize === fileInfo.size && indexed.fileMtimeMs !== fileMtimeMs)
    )
      return this.rebuildSession(sessionId, transcriptPath, fileInfo.mtimeMs, fileInfo.size)
    return this.appendLines(sessionId, transcriptPath, checkpoint.cachedUntilByte, checkpoint.lineCount, fileInfo.mtimeMs, fileInfo.size)
  }

  private async appendLines(sessionId: string, transcriptPath: string, startOffset: number, startLineNo: number, fileMtimeMs: number, snapshotSize: number): Promise<RawTranscriptSyncResult> {
    const lines = await this.readCompleteLines(transcriptPath, startOffset, snapshotSize)
    if (lines.length === 0) {
      this.turnMetaStore?.syncCachedSession(sessionId)
      if (!this.sessionSearchStore.hasIndexedSession(sessionId) && this.index.getSession(sessionId)?.transcriptPath) this.sessionSearchStore.rebuildSession(sessionId)
      return { changed: false }
    }
    return this.commitLines(sessionId, transcriptPath, lines, startLineNo, fileMtimeMs, snapshotSize, false)
  }

  private commitLines(
    sessionId: string,
    transcriptPath: string,
    lines: ParsedTranscriptLine[],
    startLineNo: number,
    fileMtimeMs: number,
    snapshotSize: number,
    replace: boolean,
  ): RawTranscriptSyncResult {
    const priorForOwner = this.index.getSession(sessionId)
    const prior = replace ? null : priorForOwner
    let effectiveCwd = prior?.currentCwd ?? null
    let customTitle = prior?.customTitle ?? null
    let aiTitle = prior?.aiTitle ?? null
    let lastPrompt = prior?.lastPrompt ?? null
    let summaryHint = prior?.summaryHint ?? null
    let firstPrompt = prior?.firstPrompt ?? null
    let firstPromptLocked = prior?.firstPromptLocked ?? null
    let commandFallback = prior?.commandFallback ?? null
    let gitBranch = prior?.gitBranch ?? null
    let isSidechain = prior?.isSidechain ?? null
    let entrypoint = prior?.entrypoint ?? null
    let sessionKind = prior?.sessionKind ?? null
    let lineNo = startLineNo
    this.db.exec('BEGIN')
    try {
      if (replace) {
        this.db.prepare('DELETE FROM session_raw_transcript_lines WHERE session_id = ?').run(sessionId)
        if (priorForOwner?.transcriptPath) this.tokenUsageStore?.deleteTranscript(priorForOwner.transcriptPath)
      }
      this.tokenUsageStore?.ingestLines(transcriptPath, sessionId, false, lines)
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO session_raw_transcript_lines (
          session_id, byte_offset, byte_length, line_no, uuid, type, timestamp_ms,
          parent_uuid, is_sidechain, user_type, entrypoint, cwd, version, git_branch, raw_json, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const line of lines) {
        const value = line.value
        if (typeof value.sessionId === 'string' && value.sessionId !== sessionId) throw new Error(`session id mismatch in ${transcriptPath}`)
        if (typeof value.cwd === 'string') effectiveCwd = value.cwd
        lineNo += 1
        const timestamp = timestampMs(value.timestamp)
        if (typeof value.customTitle === 'string') customTitle = value.customTitle
        if (typeof value.aiTitle === 'string') aiTitle = value.aiTitle
        if (typeof value.lastPrompt === 'string') lastPrompt = value.lastPrompt
        if (typeof value.summary === 'string') summaryHint = value.summary
        if (typeof value.gitBranch === 'string') gitBranch = value.gitBranch
        if (typeof value.entrypoint === 'string') entrypoint = value.entrypoint
        if (typeof value.sessionKind === 'string') sessionKind = value.sessionKind
        if (isSidechain === null && typeof value.isSidechain === 'boolean') isSidechain = value.isSidechain
        if (firstPromptLocked !== true) {
          const prompt = extractPromptCandidate(value, commandFallback)
          if (prompt.commandFallback && !commandFallback) commandFallback = prompt.commandFallback
          if (prompt.firstPrompt !== undefined) {
            firstPrompt = prompt.firstPrompt
            firstPromptLocked = prompt.locked === true
          }
        }
        insert.run(
          sessionId,
          line.offset,
          line.byteLength,
          lineNo,
          typeof value.uuid === 'string' ? value.uuid : null,
          typeof value.type === 'string' ? value.type : null,
          timestamp,
          typeof value.parentUuid === 'string' ? value.parentUuid : null,
          typeof value.isSidechain === 'boolean' ? (value.isSidechain ? 1 : 0) : null,
          typeof value.userType === 'string' ? value.userType : null,
          typeof value.entrypoint === 'string' ? value.entrypoint : null,
          typeof value.cwd === 'string' ? value.cwd : null,
          typeof value.version === 'string' ? value.version : null,
          typeof value.gitBranch === 'string' ? value.gitBranch : null,
          line.raw,
          Date.now(),
        )
      }
      const ownershipLines: Array<{ session_id: string; byte_offset: number; raw_json: string; owner_turn_id?: string | null }> = replace
        ? (this.db
            .prepare(`
          SELECT session_id, byte_offset, raw_json, owner_turn_id
          FROM session_raw_transcript_lines WHERE session_id = ? ORDER BY byte_offset
        `)
            .all(sessionId) as Array<{ session_id: string; byte_offset: number; raw_json: string; owner_turn_id: string | null }>)
        : lines.map((line) => ({ session_id: sessionId, byte_offset: line.offset, raw_json: line.raw }))
      const previousOwners = new Map(ownershipLines.map((line) => [line.byte_offset, line.owner_turn_id ?? null]))
      const states = replace
        ? undefined
        : seedTranscriptTurnOwnershipState(
            this.db
              .prepare(`
        SELECT session_id, byte_offset, uuid, owner_turn_id, raw_json
        FROM session_raw_transcript_lines WHERE session_id = ? AND byte_offset < ? ORDER BY byte_offset
      `)
              .all(sessionId, lines[0]!.offset) as Array<{ session_id: string; byte_offset: number; uuid: string | null; owner_turn_id: string | null; raw_json: string }>,
          )
      const materialized = materializeTranscriptTurnOwnership(ownershipLines, states)
      const changedOwners = new Set<string>()
      const updateOwner = this.db.prepare(`
        UPDATE session_raw_transcript_lines SET owner_turn_id = ?
        WHERE session_id = ? AND byte_offset = ?
      `)
      const roots: Array<{ subagentId: string; ownerTurnId: string }> = []
      for (const line of materialized) {
        const previousOwner = previousOwners.get(line.byte_offset) ?? null
        if (previousOwner !== line.owner_turn_id) {
          if (previousOwner) changedOwners.add(previousOwner)
          if (line.owner_turn_id) changedOwners.add(line.owner_turn_id)
        }
        updateOwner.run(line.owner_turn_id, line.session_id, line.byte_offset)
        const value = JSON.parse(line.raw_json) as JsonRecord
        const toolUseResult = timelineToolUseResult(value)
        if (line.owner_turn_id && isRecord(toolUseResult) && typeof toolUseResult.agentId === 'string' && toolUseResult.agentId)
          roots.push({ subagentId: toolUseResult.agentId, ownerTurnId: line.owner_turn_id })
      }
      const subagentRootsChanged = this.subagentStore?.recordRoots(sessionId, roots, replace) ?? false
      this.index.upsertSession({
        sessionId,
        transcriptPath,
        fileSize: snapshotSize,
        fileMtimeMs: Math.trunc(fileMtimeMs),
        currentCwd: effectiveCwd,
        customTitle,
        aiTitle,
        lastPrompt,
        summaryHint,
        firstPrompt,
        firstPromptLocked,
        commandFallback,
        gitBranch,
        isSidechain,
        entrypoint,
        sessionKind,
        forceCurrent: priorForOwner?.transcriptPath !== undefined && priorForOwner.transcriptPath !== transcriptPath,
      })
      this.turnMetaStore?.syncCachedSession(sessionId, { replace })
      if (replace || !this.sessionSearchStore.hasIndexedSession(sessionId)) this.sessionSearchStore.rebuildSession(sessionId)
      else {
        const ownerByOffset = new Map(materialized.map((line) => [line.byte_offset, line.owner_turn_id]))
        this.sessionSearchStore.appendSessionLines(
          sessionId,
          lines.map((line) => ({
            ownerTurnId: ownerByOffset.get(line.offset) ?? null,
            uuid: typeof line.value.uuid === 'string' ? line.value.uuid : null,
            timestampMs: timestampMs(line.value.timestamp),
            value: line.value,
          })),
        )
      }
      const invalidateFromTurnId = replace ? null : this.invalidationTurnId(sessionId, transcriptPath, changedOwners)
      const projectId = effectiveCwd ? projectIdFromPath(effectiveCwd) : undefined
      const previousProjectId = priorForOwner?.currentProjectId && priorForOwner.currentProjectId !== projectId ? priorForOwner.currentProjectId : undefined
      const change: RawTranscriptChange = {
        changed: true,
        sessionId,
        ...(projectId ? { projectId } : {}),
        ...(previousProjectId ? { previousProjectId } : {}),
        version: `raw-v1:path=${Buffer.from(transcriptPath).toString('base64url')};mtime=${Math.trunc(fileMtimeMs)};size=${snapshotSize};lines=${lineNo}`,
        reset: replace || invalidateFromTurnId === null,
        invalidateFromTurnId,
        subagentRootsChanged,
      }
      this.db.exec('COMMIT')
      return change
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private invalidationTurnId(sessionId: string, transcriptPath: string, changedOwners: ReadonlySet<string>): string | null {
    if (changedOwners.size === 0) return null
    const owners = [...changedOwners]
    const row = this.db
      .prepare(`
      SELECT primary_user_uuid FROM turn_meta_transcript
      WHERE session_id = ? AND transcript_path = ?
        AND primary_user_uuid IN (${owners.map(() => '?').join(', ')})
      ORDER BY primary_byte_offset ASC LIMIT 1
    `)
      .get(sessionId, transcriptPath, ...owners) as { primary_user_uuid: string } | undefined
    return row?.primary_user_uuid ?? null
  }

  private async rebuildSession(sessionId: string, transcriptPath: string, fileMtimeMs: number, fileSize: number): Promise<RawTranscriptSyncResult> {
    const lines = await this.readCompleteLines(transcriptPath, 0, fileSize)
    if (lines.length === 0 && fileSize > 0) throw new Error(`no complete transcript lines for ${sessionId}`)
    return this.commitLines(sessionId, transcriptPath, lines, 0, fileMtimeMs, fileSize, true)
  }

  private async readCompleteLines(transcriptPath: string, startOffset: number, snapshotSize: number): Promise<ParsedTranscriptLine[]> {
    return readCompleteTranscriptLines(transcriptPath, startOffset, snapshotSize)
  }

  private async locateTranscript(sessionId: string): Promise<string> {
    const candidates: string[] = []
    try {
      for (const project of await readdir(this.projectsRoot, { withFileTypes: true })) {
        if (!project.isDirectory()) continue
        const path = join(this.projectsRoot, project.name, `${sessionId}.jsonl`)
        try {
          await stat(path)
          candidates.push(path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (candidates.length === 0) {
      this.index.clearTranscriptPath(sessionId)
      throw new TranscriptUnavailableError(sessionId)
    }
    if (candidates.length === 1) return candidates[0]!
    const indexed = this.index.getSession(sessionId)
    const checkpoint = this.checkpoint(sessionId)
    const projectHintPath = indexed?.currentCwd ? join(this.projectsRoot, projectTranscriptDirName(indexed.currentCwd), `${sessionId}.jsonl`) : null
    const contents = await Promise.all(candidates.map(async (path) => ({ path, data: await readFile(path), info: await stat(path) })))
    const meaningful = (data: Buffer) => {
      const text = data.toString('utf8')
      return text.includes('"type":"user"') || text.includes('"type":"assistant"') || text.includes('"subtype":"turn_duration"')
    }
    const cachedRows =
      checkpoint.cachedUntilByte > 0
        ? (this.db
            .prepare(`
      SELECT byte_offset, byte_length, raw_json FROM session_raw_transcript_lines
      WHERE session_id = ? ORDER BY byte_offset
    `)
            .all(sessionId) as Array<{ byte_offset: number; byte_length: number; raw_json: string }>)
        : []
    const coversCheckpoint = (candidate: { data: Buffer; info: { size: number } }) =>
      checkpoint.cachedUntilByte > 0 &&
      candidate.info.size >= checkpoint.cachedUntilByte &&
      cachedRows.every(
        (row) =>
          candidate.data
            .subarray(row.byte_offset, row.byte_offset + row.byte_length)
            .toString('utf8')
            .trim() === row.raw_json,
      )
    const sticky = (path: string) => checkpoint.cachedUntilByte > 0 && path === indexed?.transcriptPath
    const canonical = contents.sort(
      (left, right) =>
        Number(meaningful(right.data)) - Number(meaningful(left.data)) ||
        Number(coversCheckpoint(right)) - Number(coversCheckpoint(left)) ||
        right.data.length - left.data.length ||
        Number(sticky(right.path)) - Number(sticky(left.path)) ||
        Number(right.path === projectHintPath) - Number(left.path === projectHintPath) ||
        right.info.mtimeMs - left.info.mtimeMs ||
        left.path.localeCompare(right.path),
    )[0]!
    return canonical.path
  }
}
