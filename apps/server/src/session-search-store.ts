import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  isPrimaryTimelineUserMessage,
  type ProjectSessionSearchMatch,
  type ProjectSessionSearchMatchField,
  type ProjectSessionSearchRequest,
  type ProjectSessionSearchResponse,
  type ProjectSessionSearchResult,
  type SessionSummary,
  timelineInterruptMarker,
  timelineLocalCommand,
  timelineLocalCommandFeedback,
} from '@cotta/shared'
import { projectDisplayMetadataFromPath, sessionTitle } from './claude-code-api.js'
import { ListCursorError } from './list-cursor.js'
import { listableSessionPredicate, TranscriptIndexStore } from './transcript-index-store.js'

type JsonRecord = Record<string, unknown>

type SearchMode = 'substring' | 'fts'
type SearchCursor = { v: 1; query: string; mode: SearchMode; snapshotId: string; offset: number }
type SearchSnapshot = {
  query: string
  mode: SearchMode
  expiresAt: number
  sessionIds: string[]
  totalSessions: number
  totalMatches: number
}

type SearchCandidateRow = {
  session_id: string
  total_sessions: number
  total_matches: number
}

type SearchDocumentRow = {
  session_id: string | null
  field: ProjectSessionSearchMatchField | null
  owner_turn_id: string | null
  message_uuid: string | null
  content_block_index: number | null
  message_timestamp_ms: number | null
  content: string | null
  field_priority: number | null
  rank: number | null
  message_match_count: number
  total_sessions: number
  total_matches: number
  current_project_id: string | null
  current_cwd: string | null
  file_mtime_ms: number | null
  last_visible_message_at_ms: number | null
  custom_title: string | null
  ai_title: string | null
  last_prompt: string | null
  summary_hint: string | null
  first_prompt: string | null
  first_prompt_locked: number | null
  command_fallback: string | null
  session_kind: string | null
  project_path: string | null
  project_last_activity_at_ms: number | null
}

type SessionSearchAggregate = {
  row: SearchDocumentRow
  matches: ProjectSessionSearchMatch[]
  truncatedMatches: boolean
}

const PAGE_SIZE = 20
const MATCHES_PER_SESSION = 5
const SNAPSHOT_TTL_MS = 60_000
const MAX_SNAPSHOTS = 32
// Bump when Session Search document selection, text extraction, or normalization changes, or when a
// one-time cache repair must run (prepareSearchIndex: transcript ownership rows, session owner cwd).
const SEARCH_INDEX_RULES_VERSION = 4
const SEARCH_INDEX_SETTINGS_SCOPE = 'session-search-store'
const SEARCH_INDEX_SETTINGS_KEY = 'rules-version'

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null
}

function userVisibleLength(value: string): number {
  return Array.from(value).length
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function foldText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase()
}

function createSearchCursor(query: string, mode: SearchMode, snapshotId: string, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, query, mode, snapshotId, offset } satisfies SearchCursor), 'utf8').toString('base64url')
}

function resolveSearchCursor(cursor: string, query: string, mode: SearchMode): SearchCursor {
  let value: Partial<SearchCursor>
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<SearchCursor>
    if (
      value.v !== 1 ||
      (value.mode !== 'substring' && value.mode !== 'fts') ||
      typeof value.query !== 'string' ||
      typeof value.snapshotId !== 'string' ||
      !Number.isInteger(value.offset) ||
      (value.offset ?? -1) < 0
    )
      throw new Error()
  } catch {
    throw new ListCursorError('invalid')
  }
  if (value.query !== query || value.mode !== mode) throw new ListCursorError('stale')
  return value as SearchCursor
}

function textBlocks(content: unknown): Array<{ index: number; text: string }> {
  if (typeof content === 'string') return [{ index: 0, text: content }]
  if (!Array.isArray(content)) return []
  return content.flatMap((block, index) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [{ index, text: block.text }] : []))
}

function visibleTextBlocks(value: unknown, localCommandRoots: ReadonlySet<string>): Array<{ index: number; text: string }> {
  if (!isRecord(value)) return []
  const isUser = isPrimaryTimelineUserMessage(value)
  const isAssistant =
    value.type === 'assistant' && value.isSynthetic !== true && value.isMeta !== true && value.isSidechain !== true && value.parent_tool_use_id == null && value.parent_agent_id == null
  const message = isRecord(value.message) ? value.message : null
  const feedbackParent = typeof value.parentUuid === 'string' ? value.parentUuid : null
  const localCommandFeedback = timelineLocalCommandFeedback(value)
  if (
    (!isUser && !isAssistant) ||
    (isUser &&
      (timelineLocalCommand(value) !== null || (localCommandFeedback !== null && feedbackParent !== null && localCommandRoots.has(feedbackParent)) || timelineInterruptMarker(value) !== null)) ||
    (isAssistant && message?.role !== 'assistant') ||
    !message
  )
    return []
  return textBlocks(message.content).flatMap(({ index, text }) => {
    const normalized = normalizeText(text)
    return normalized ? [{ index, text: normalized }] : []
  })
}

function collectRanges(text: string, query: string): Array<{ start: number; end: number }> {
  let haystack = ''
  const originalRanges: Array<{ start: number; end: number }> = []
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)
  for (const { segment, index: start } of segments) {
    const end = start + segment.length
    const folded = foldText(segment)
    haystack += folded
    for (let index = 0; index < folded.length; index += 1) originalRanges.push({ start, end })
  }
  const needle = foldText(query)
  if (!needle) return []
  const ranges: Array<{ start: number; end: number }> = []
  let from = 0
  while (from < haystack.length) {
    const index = haystack.indexOf(needle, from)
    if (index < 0) break
    const first = originalRanges[index]
    const last = originalRanges[index + needle.length - 1]
    if (first && last) ranges.push({ start: first.start, end: last.end })
    from = index + Math.max(1, needle.length)
  }
  return ranges
}

function snippetWithRanges(text: string, query: string): { snippet: string; ranges: Array<{ start: number; end: number }> } {
  const ranges = collectRanges(text, query)
  if (ranges.length === 0) {
    const snippet = text.length <= 120 ? text : `${text.slice(0, 117).trimEnd()}...`
    return { snippet, ranges: [] }
  }
  const first = ranges[0]
  if (!first) return { snippet: text, ranges: [] }
  const rawStart = Math.max(0, first.start - 40)
  const rawEnd = Math.min(text.length, first.end + 80)
  const rawSnippet = text.slice(rawStart, rawEnd)
  let snippet = rawSnippet.trim()
  let offset = rawStart + rawSnippet.length - rawSnippet.trimStart().length
  if (rawStart > 0) {
    snippet = `...${snippet}`
    offset -= 3
  }
  if (rawEnd < text.length) snippet = `${snippet}...`
  return {
    snippet,
    ranges: ranges.map((range) => ({ start: range.start - offset, end: range.end - offset })).filter((range) => range.start >= 0 && range.end <= snippet.length),
  }
}

function sessionSummary(session: {
  sessionId: string
  currentProjectId: string | null
  lastVisibleMessageAtMs: number | null
  fileMtimeMs: number | null
  customTitle: string | null
  aiTitle: string | null
  lastPrompt: string | null
  summaryHint: string | null
  firstPrompt: string | null
  firstPromptLocked: boolean | null
  commandFallback: string | null
  sessionKind: string | null
}): SessionSummary | null {
  if (!session.currentProjectId) return null
  return {
    id: session.sessionId,
    title: sessionTitle(session),
    projectId: session.currentProjectId,
    lastActivityAt: session.lastVisibleMessageAtMs ?? session.fileMtimeMs ?? 0,
    occupiedBy: null,
    occupiedStatus: 'idle',
    hasRunningShell: false,
    kind: session.sessionKind ?? null,
    ...(session.lastPrompt ? { lastPrompt: session.lastPrompt } : {}),
  }
}

export class SessionSearchStore {
  private readonly index: TranscriptIndexStore
  private readonly snapshots = new Map<string, SearchSnapshot>()

  constructor(
    private readonly db: DatabaseSync,
    index = new TranscriptIndexStore(db),
  ) {
    this.index = index
  }

  needsRulesVersionUpdate(): boolean {
    const stored = this.db.prepare('SELECT value_json FROM settings WHERE scope = ? AND key = ?').get(SEARCH_INDEX_SETTINGS_SCOPE, SEARCH_INDEX_SETTINGS_KEY) as { value_json: string } | undefined
    try {
      return stored === undefined || JSON.parse(stored.value_json) !== SEARCH_INDEX_RULES_VERSION
    } catch {
      return true
    }
  }

  prepareRulesVersion(options: { inTransaction?: boolean } = {}): boolean {
    if (!this.needsRulesVersionUpdate()) return false

    const invalidate = () => {
      this.db.exec('DELETE FROM session_search_documents; DELETE FROM session_search_state;')
      this.db
        .prepare(`
          INSERT INTO settings (scope, key, value_json, updated_at_ms)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(scope, key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at_ms = excluded.updated_at_ms
        `)
        .run(SEARCH_INDEX_SETTINGS_SCOPE, SEARCH_INDEX_SETTINGS_KEY, JSON.stringify(SEARCH_INDEX_RULES_VERSION), Date.now())
    }
    if (options.inTransaction) {
      invalidate()
      return true
    }

    this.db.exec('BEGIN IMMEDIATE')
    try {
      invalidate()
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  hasIndexedSession(sessionId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM session_search_state WHERE session_id = ?').get(sessionId)
  }

  clearSession(sessionId: string): void {
    this.db.prepare('DELETE FROM session_search_documents WHERE session_id = ?').run(sessionId)
    this.db.prepare('DELETE FROM session_search_state WHERE session_id = ?').run(sessionId)
  }

  updateTitle(sessionId: string, title: string): boolean {
    return this.inSavepoint(() => {
      const updated = this.db.prepare('UPDATE session_index SET custom_title = ?, updated_at_ms = ? WHERE session_id = ?').run(title, Date.now(), sessionId)
      if (updated.changes === 0) return false
      this.db.prepare(`DELETE FROM session_search_documents WHERE session_id = ? AND field NOT IN ('user', 'assistant')`).run(sessionId)
      this.insertMetadata(sessionId)
      this.markIndexed(sessionId)
      return true
    })
  }

  rebuildSession(sessionId: string): boolean {
    return this.inSavepoint(() => {
      const session = this.index.getSession(sessionId)
      if (!session) {
        this.clearSession(sessionId)
        return false
      }
      this.clearSession(sessionId)
      this.insertMetadata(sessionId)
      const rows = this.db.prepare(`SELECT owner_turn_id, uuid, timestamp_ms, raw_json FROM session_raw_transcript_lines WHERE session_id = ? ORDER BY byte_offset`).all(sessionId) as Array<{
        owner_turn_id: string | null
        uuid: string | null
        timestamp_ms: number | null
        raw_json: string
      }>
      this.insertMessageDocuments(
        sessionId,
        rows.map((row) => ({ ownerTurnId: row.owner_turn_id, uuid: row.uuid, timestampMs: row.timestamp_ms, value: JSON.parse(row.raw_json) as unknown })),
      )
      this.markIndexed(sessionId)
      return true
    })
  }

  appendSessionLines(sessionId: string, rows: readonly { ownerTurnId: string | null; uuid: string | null; timestampMs: number | null; value: unknown }[]): boolean {
    return this.inSavepoint(() => {
      if (!this.index.getSession(sessionId)) return false
      this.db.prepare(`DELETE FROM session_search_documents WHERE session_id = ? AND field NOT IN ('user', 'assistant')`).run(sessionId)
      this.insertMetadata(sessionId)
      this.insertMessageDocuments(sessionId, rows)
      this.markIndexed(sessionId)
      return true
    })
  }

  private insertMetadata(sessionId: string): void {
    const session = this.index.getSession(sessionId)
    if (!session) return
    const insert = this.documentInserter(sessionId)
    insert('title', sessionTitle(session))
    insert('sessionId', session.sessionId)
    insert('cwd', session.currentCwd)
    insert('gitBranch', session.gitBranch)
  }

  private insertMessageDocuments(sessionId: string, rows: readonly { ownerTurnId: string | null; uuid: string | null; timestampMs: number | null; value: unknown }[]): void {
    const insert = this.documentInserter(sessionId)
    const assistantIds = new Map<string, Set<string>>()
    for (const row of rows) {
      const message = isRecord(row.value) && isRecord(row.value.message) ? row.value.message : null
      if (!row.uuid || !isRecord(row.value) || row.value.type !== 'assistant' || typeof message?.id !== 'string' || !message.id.trim()) continue
      const ids = assistantIds.get(row.uuid) ?? new Set<string>()
      ids.add(message.id)
      assistantIds.set(row.uuid, ids)
    }
    const clearMessage = this.db.prepare(`DELETE FROM session_search_documents WHERE session_id = ? AND field = ? AND logical_message_id = ?`)
    const localCommandRoots = new Set(
      (this.db.prepare(`SELECT uuid, raw_json FROM session_raw_transcript_lines WHERE session_id = ? AND uuid IS NOT NULL`).all(sessionId) as Array<{ uuid: string; raw_json: string }>).flatMap(
        (row) => (timelineLocalCommand(JSON.parse(row.raw_json) as unknown) !== null ? [row.uuid] : []),
      ),
    )
    for (const row of rows) {
      if (!row.ownerTurnId || !row.uuid) continue
      const field: ProjectSessionSearchMatchField | null =
        isRecord(row.value) && isPrimaryTimelineUserMessage(row.value) ? 'user' : isRecord(row.value) && row.value.type === 'assistant' ? 'assistant' : null
      if (!field) continue
      const ids = assistantIds.get(row.uuid)
      const logicalMessageId = field === 'user' ? row.uuid : ids?.size === 1 ? [...ids][0]! : null
      if (!logicalMessageId) continue
      clearMessage.run(sessionId, field, logicalMessageId)
      for (const block of visibleTextBlocks(row.value, localCommandRoots))
        insert(field, block.text, { turnId: row.ownerTurnId, messageUuid: row.uuid, logicalMessageId, blockIndex: block.index, messageTimestampMs: row.timestampMs })
    }
  }

  private documentInserter(sessionId: string) {
    const statement = this.db.prepare(`
      INSERT INTO session_search_documents (
        session_id, field, owner_turn_id, message_uuid, content_block_index, message_timestamp_ms, logical_message_id, content, folded_content, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, field, logical_message_id, content_block_index) DO UPDATE SET
        owner_turn_id = excluded.owner_turn_id,
        message_uuid = excluded.message_uuid,
        message_timestamp_ms = excluded.message_timestamp_ms,
        content = excluded.content,
        folded_content = excluded.folded_content,
        updated_at_ms = excluded.updated_at_ms
    `)
    const now = Date.now()
    return (
      field: ProjectSessionSearchMatchField,
      content: string | null,
      locator: { turnId?: string | null; messageUuid?: string | null; logicalMessageId?: string | null; blockIndex?: number | null; messageTimestampMs?: number | null } = {},
    ) => {
      const normalized = content ? normalizeText(content) : ''
      if (normalized)
        statement.run(
          sessionId,
          field,
          locator.turnId ?? null,
          locator.messageUuid ?? null,
          locator.blockIndex ?? null,
          locator.messageTimestampMs ?? null,
          locator.logicalMessageId ?? null,
          normalized,
          foldText(normalized),
          now,
        )
    }
  }

  private markIndexed(sessionId: string): void {
    this.db
      .prepare(`INSERT INTO session_search_state (session_id, updated_at_ms) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET updated_at_ms = excluded.updated_at_ms`)
      .run(sessionId, Date.now())
  }

  private inSavepoint<T>(operation: () => T): T {
    this.db.exec('SAVEPOINT session_search')
    try {
      const result = operation()
      this.db.exec('RELEASE session_search')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK TO session_search')
      this.db.exec('RELEASE session_search')
      throw error
    }
  }

  search(input: ProjectSessionSearchRequest): ProjectSessionSearchResponse {
    const query = normalizeText(input.query)
    const mode: SearchMode = userVisibleLength(query) === 2 ? 'substring' : 'fts'
    if (userVisibleLength(query) < 2) return { query, results: [], totalSessions: 0, totalMatches: 0, hasMore: false, nextCursor: null }

    if (input.cursor) {
      const cursor = resolveSearchCursor(input.cursor, query, mode)
      const snapshot = this.snapshots.get(cursor.snapshotId)
      if (!snapshot || snapshot.expiresAt <= Date.now()) {
        this.snapshots.delete(cursor.snapshotId)
        throw new ListCursorError('stale')
      }
      this.snapshots.delete(cursor.snapshotId)
      this.snapshots.set(cursor.snapshotId, snapshot)
      return this.snapshotPage(cursor.snapshotId, cursor.offset, snapshot)
    }

    const candidates = this.searchCandidates(query, mode)
    const totalSessions = candidates[0]?.total_sessions ?? 0
    const totalMatches = candidates[0]?.total_matches ?? 0
    const sessionIds = candidates.map((row) => row.session_id)
    const results = this.resultsFromRows(this.hydrateRows(query, mode, sessionIds.slice(0, PAGE_SIZE)), query)
    if (sessionIds.length <= PAGE_SIZE) return { query, results, totalSessions, totalMatches, hasMore: false, nextCursor: null }

    const now = Date.now()
    for (const [id, snapshot] of this.snapshots) if (snapshot.expiresAt <= now) this.snapshots.delete(id)
    while (this.snapshots.size >= MAX_SNAPSHOTS) this.snapshots.delete(this.snapshots.keys().next().value!)
    const snapshotId = randomUUID()
    const snapshot = { query, mode, expiresAt: now + SNAPSHOT_TTL_MS, sessionIds, totalSessions, totalMatches }
    this.snapshots.set(snapshotId, snapshot)
    return { query, results, totalSessions, totalMatches, hasMore: true, nextCursor: createSearchCursor(query, mode, snapshotId, PAGE_SIZE) }
  }

  private snapshotPage(snapshotId: string, offset: number, snapshot: SearchSnapshot): ProjectSessionSearchResponse {
    const sessionIds = snapshot.sessionIds.slice(offset, offset + PAGE_SIZE)
    const byId = new Map(this.resultsFromRows(this.hydrateRows(snapshot.query, snapshot.mode, sessionIds), snapshot.query).map((result) => [result.session.id, result]))
    const results = sessionIds.flatMap((sessionId) => {
      const result = byId.get(sessionId)
      return result ? [result] : []
    })
    const nextOffset = offset + sessionIds.length
    const hasMore = nextOffset < snapshot.sessionIds.length
    if (!hasMore) this.snapshots.delete(snapshotId)
    return {
      query: snapshot.query,
      results,
      totalSessions: snapshot.totalSessions,
      totalMatches: snapshot.totalMatches,
      hasMore,
      nextCursor: hasMore ? createSearchCursor(snapshot.query, snapshot.mode, snapshotId, nextOffset) : null,
    }
  }

  private resultsFromRows(rows: SearchDocumentRow[], query: string): ProjectSessionSearchResult[] {
    const grouped = new Map<string, SessionSearchAggregate>()
    for (const row of rows) {
      if (row.session_id === null || row.field === null || row.content === null) continue
      const snippet = snippetWithRanges(row.content, query)
      const match: ProjectSessionSearchMatch = {
        field: row.field,
        snippet: snippet.snippet,
        ranges: snippet.ranges,
        ...(row.message_timestamp_ms == null ? {} : { messageTimestampMs: row.message_timestamp_ms }),
        ...(row.owner_turn_id && row.message_uuid && row.content_block_index !== null
          ? { locator: { turnId: row.owner_turn_id, messageUuid: row.message_uuid, blockIndex: row.content_block_index } }
          : {}),
      }
      const existing = grouped.get(row.session_id)
      if (!existing) grouped.set(row.session_id, { row, matches: [match], truncatedMatches: false })
      else if (row.field !== 'user' && row.field !== 'assistant') {
        if (!existing.matches.some((candidate) => candidate.field !== 'user' && candidate.field !== 'assistant')) existing.matches.unshift(match)
      } else if (existing.matches.filter((candidate) => candidate.field === 'user' || candidate.field === 'assistant').length < MATCHES_PER_SESSION) existing.matches.push(match)
      const aggregate = grouped.get(row.session_id)!
      aggregate.truncatedMatches = row.message_match_count > aggregate.matches.filter((candidate) => candidate.field === 'user' || candidate.field === 'assistant').length
    }
    return [...grouped.values()].map(({ row, matches, truncatedMatches }): ProjectSessionSearchResult => {
      if (!row.current_project_id || !row.project_path) throw new Error(`search result left its SQL universe: ${row.session_id}`)
      return {
        project: {
          id: row.current_project_id,
          ...projectDisplayMetadataFromPath(row.project_path),
          path: row.project_path,
          lastActivityAt: row.project_last_activity_at_ms ?? 0,
        },
        session: sessionSummary({
          sessionId: row.session_id!,
          currentProjectId: row.current_project_id,
          lastVisibleMessageAtMs: row.last_visible_message_at_ms,
          fileMtimeMs: row.file_mtime_ms,
          customTitle: row.custom_title,
          aiTitle: row.ai_title,
          lastPrompt: row.last_prompt,
          summaryHint: row.summary_hint,
          firstPrompt: row.first_prompt,
          firstPromptLocked: row.first_prompt_locked === null ? null : row.first_prompt_locked === 1,
          commandFallback: row.command_fallback,
          sessionKind: row.session_kind,
        })!,
        matches,
        messageMatchCount: row.message_match_count,
        truncatedMatches,
      }
    })
  }

  private searchCandidates(query: string, mode: SearchMode): SearchCandidateRow[] {
    const source =
      mode === 'substring'
        ? `session_search_documents d JOIN session_index si ON si.session_id = d.session_id`
        : `session_search_fts JOIN session_search_documents d ON d.doc_id = session_search_fts.rowid JOIN session_index si ON si.session_id = d.session_id`
    const predicate = mode === 'substring' ? `instr(d.folded_content, ?) > 0` : `session_search_fts MATCH ?`
    const rank = mode === 'substring' ? `CASE WHEN d.folded_content = ? THEN 0 WHEN d.folded_content LIKE ? || '%' THEN 1 ELSE 2 END` : `bm25(session_search_fts)`
    const sql = `
      WITH matches AS MATERIALIZED (
        SELECT d.session_id, d.field, d.logical_message_id,
          COALESCE(si.last_visible_message_at_ms, si.file_mtime_ms, -1) AS activity,
          COALESCE(d.message_timestamp_ms, -1) AS message_time,
          CASE d.field WHEN 'title' THEN 0 WHEN 'sessionId' THEN 1 WHEN 'cwd' THEN 2 WHEN 'gitBranch' THEN 3 WHEN 'user' THEN 4 ELSE 5 END AS field_priority,
          ${rank} AS rank
        FROM ${source}
        WHERE ${listableSessionPredicate.replaceAll('\n', '\n          ')} AND ${predicate}
      ), deduplicated AS (
        SELECT * FROM (
          SELECT matches.*, ROW_NUMBER() OVER (
            PARTITION BY session_id, field, logical_message_id
            ORDER BY rank, message_time DESC
          ) AS logical_rank
          FROM matches
        ) WHERE logical_message_id IS NULL OR logical_rank = 1
      ), heads AS (
        SELECT * FROM (
          SELECT deduplicated.*, ROW_NUMBER() OVER (
            PARTITION BY session_id ORDER BY field_priority, rank, activity DESC, message_time DESC
          ) AS session_rank
          FROM deduplicated
        ) WHERE session_rank = 1
      ), totals AS (
        SELECT (SELECT COUNT(*) FROM heads) AS total_sessions,
          (SELECT COUNT(*) FROM deduplicated WHERE field IN ('user', 'assistant')) AS total_matches
      )
      SELECT heads.session_id, totals.total_sessions, totals.total_matches
      FROM heads CROSS JOIN totals
      ORDER BY heads.field_priority, heads.rank, heads.activity DESC, heads.message_time DESC, heads.session_id
    `
    const folded = foldText(query)
    const search = mode === 'substring' ? [folded, folded, folded] : [`"${query.replaceAll('"', '""')}"`]
    return this.db.prepare(sql).all(...search) as SearchCandidateRow[]
  }

  private hydrateRows(query: string, mode: SearchMode, sessionIds: string[]): SearchDocumentRow[] {
    if (sessionIds.length === 0) return []
    return this.searchRows(query, mode, sessionIds)
  }

  private searchRows(query: string, mode: SearchMode, sessionIds?: string[]): SearchDocumentRow[] {
    const source =
      mode === 'substring'
        ? `session_search_documents d JOIN session_index si ON si.session_id = d.session_id JOIN project_index pi ON pi.project_id = si.current_project_id`
        : `session_search_fts JOIN session_search_documents d ON d.doc_id = session_search_fts.rowid JOIN session_index si ON si.session_id = d.session_id JOIN project_index pi ON pi.project_id = si.current_project_id`
    const predicate = mode === 'substring' ? `instr(d.folded_content, ?) > 0` : `session_search_fts MATCH ?`
    const rank = mode === 'substring' ? `CASE WHEN d.folded_content = ? THEN 0 WHEN d.folded_content LIKE ? || '%' THEN 1 ELSE 2 END` : `bm25(session_search_fts)`
    const sql = `
      WITH matches AS MATERIALIZED (
        SELECT d.*, COALESCE(si.last_visible_message_at_ms, si.file_mtime_ms, -1) AS activity,
          COALESCE(d.message_timestamp_ms, -1) AS message_time,
          CASE d.field WHEN 'title' THEN 0 WHEN 'sessionId' THEN 1 WHEN 'cwd' THEN 2 WHEN 'gitBranch' THEN 3 WHEN 'user' THEN 4 ELSE 5 END AS field_priority,
          ${rank} AS rank,
          si.current_project_id, si.current_cwd, si.file_mtime_ms, si.last_visible_message_at_ms, si.custom_title, si.ai_title,
          si.last_prompt, si.summary_hint, si.first_prompt, si.first_prompt_locked, si.command_fallback, si.session_kind,
          pi.project_path, pi.last_activity_at_ms AS project_last_activity_at_ms
        FROM ${source}
        WHERE ${listableSessionPredicate.replaceAll('\n', '\n          ')} AND ${predicate}
          ${sessionIds ? `AND d.session_id IN (${sessionIds.map(() => '?').join(', ')})` : ''}
      ), deduplicated AS (
        SELECT * FROM (
          SELECT matches.*,
            ROW_NUMBER() OVER (PARTITION BY session_id, field, logical_message_id ORDER BY rank, message_time DESC, COALESCE(message_uuid, ''), COALESCE(content_block_index, -1)) AS logical_rank
          FROM matches
        ) WHERE logical_message_id IS NULL OR logical_rank = 1
      ), ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY field_priority, rank, activity DESC, message_time DESC, field, COALESCE(message_uuid, ''), COALESCE(content_block_index, -1)) AS overall_rank,
          CASE WHEN field IN ('user', 'assistant') THEN ROW_NUMBER() OVER (PARTITION BY session_id, CASE WHEN field IN ('user', 'assistant') THEN 1 ELSE 0 END ORDER BY field_priority, rank, message_time DESC, field, COALESCE(message_uuid, ''), COALESCE(content_block_index, -1)) END AS message_rank,
          SUM(CASE WHEN field IN ('user', 'assistant') THEN 1 ELSE 0 END) OVER (PARTITION BY session_id) AS message_match_count
        FROM deduplicated
      ), heads AS (SELECT * FROM ranked WHERE overall_rank = 1), totals AS (
        SELECT (SELECT COUNT(*) FROM heads) AS total_sessions,
          (SELECT COUNT(*) FROM deduplicated WHERE field IN ('user', 'assistant')) AS total_matches
      ), selected AS (
        SELECT * FROM ranked
        WHERE (overall_rank = 1 AND field NOT IN ('user', 'assistant')) OR (field IN ('user', 'assistant') AND message_rank <= ${MATCHES_PER_SESSION})
      )
      SELECT s.session_id, s.field, s.owner_turn_id, s.message_uuid, s.content_block_index, s.message_timestamp_ms, s.content,
        s.field_priority, s.rank, s.message_match_count, totals.total_sessions, totals.total_matches,
        s.current_project_id, s.current_cwd, s.file_mtime_ms, s.last_visible_message_at_ms, s.custom_title, s.ai_title,
        s.last_prompt, s.summary_hint, s.first_prompt, s.first_prompt_locked, s.command_fallback, s.session_kind,
        s.project_path, s.project_last_activity_at_ms
      FROM totals LEFT JOIN selected s ON TRUE
      ORDER BY s.field_priority, s.rank, s.activity DESC, s.message_time DESC, s.session_id, s.overall_rank
    `
    const folded = foldText(query)
    const search = mode === 'substring' ? [folded, folded, folded] : [`"${query.replaceAll('"', '""')}"`]
    return this.db.prepare(sql).all(...search, ...(sessionIds ?? [])) as SearchDocumentRow[]
  }
}
