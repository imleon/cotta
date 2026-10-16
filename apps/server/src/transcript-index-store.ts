import type { DatabaseSync } from 'node:sqlite'
import { type RawSessionTask, rawSessionTaskSchema } from '@cotta/shared'
import type { KeysetCursorKey } from './list-cursor.js'
import { normalizeProjectPath, projectIdFromPath } from './project-path.js'

export type TaskSnapshotUpdate = {
  tasks: RawSessionTask[]
  version: string
  updatedAtMs?: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isValidSessionId(sessionId: string): boolean {
  return UUID_RE.test(sessionId)
}

export type IndexedProject = {
  projectId: string
  projectPath: string
  lastActivityAtMs: number | null
}

export type IndexedSession = {
  sessionId: string
  currentProjectId: string | null
  currentCwd: string | null
  transcriptPath: string | null
  fileSize: number | null
  fileMtimeMs: number | null
  lastVisibleMessageAtMs: number | null
  customTitle: string | null
  aiTitle: string | null
  lastPrompt: string | null
  summaryHint: string | null
  firstPrompt: string | null
  firstPromptLocked: boolean | null
  commandFallback: string | null
  gitBranch: string | null
  isSidechain: boolean | null
  entrypoint: string | null
  sessionKind: string | null
  taskSnapshot: RawSessionTask[] | null
  taskSnapshotVersion: string | null
  taskSnapshotUpdatedAtMs: number | null
  isValidSessionId: boolean
}

type ProjectRow = {
  project_id: string
  project_path: string
  last_activity_at_ms: number | null
}

type SessionRow = {
  session_id: string
  current_project_id: string | null
  current_cwd: string | null
  transcript_path: string | null
  file_size: number | null
  file_mtime_ms: number | null
  last_visible_message_at_ms: number | null
  custom_title: string | null
  ai_title: string | null
  last_prompt: string | null
  summary_hint: string | null
  first_prompt: string | null
  first_prompt_locked: number | null
  command_fallback: string | null
  git_branch: string | null
  is_sidechain: number | null
  entrypoint: string | null
  session_kind: string | null
  task_snapshot_json: string | null
  task_snapshot_version: string | null
  task_snapshot_updated_at_ms: number | null
  is_valid_session_id: number
}

export type IndexedPage<T> = {
  items: T[]
  hasMore: boolean
  nextKey: KeysetCursorKey | null
  defaultSessionId?: string | null
}

function toIndexedProject(row: ProjectRow): IndexedProject {
  return {
    projectId: row.project_id,
    projectPath: row.project_path,
    lastActivityAtMs: row.last_activity_at_ms,
  }
}

function parseTaskSnapshot(value: string | null): RawSessionTask[] | null {
  if (value === null) return null
  try {
    return rawSessionTaskSchema.array().safeParse(JSON.parse(value)).data ?? null
  } catch {
    return null
  }
}

function toIndexedSession(row: SessionRow): IndexedSession {
  return {
    sessionId: row.session_id,
    currentProjectId: row.current_project_id,
    currentCwd: row.current_cwd,
    transcriptPath: row.transcript_path,
    fileSize: row.file_size,
    fileMtimeMs: row.file_mtime_ms,
    lastVisibleMessageAtMs: row.last_visible_message_at_ms,
    customTitle: row.custom_title,
    aiTitle: row.ai_title,
    lastPrompt: row.last_prompt,
    summaryHint: row.summary_hint,
    firstPrompt: row.first_prompt,
    firstPromptLocked: row.first_prompt_locked === null ? null : row.first_prompt_locked === 1,
    commandFallback: row.command_fallback,
    gitBranch: row.git_branch,
    isSidechain: row.is_sidechain === null ? null : row.is_sidechain === 1,
    entrypoint: row.entrypoint,
    sessionKind: row.session_kind,
    taskSnapshot: parseTaskSnapshot(row.task_snapshot_json),
    taskSnapshotVersion: row.task_snapshot_version,
    taskSnapshotUpdatedAtMs: row.task_snapshot_updated_at_ms,
    isValidSessionId: row.is_valid_session_id === 1,
  }
}

function page<T>(items: T[], limit: number, key: (item: T) => KeysetCursorKey): IndexedPage<T> {
  const pageItems = items.slice(0, limit)
  return { items: pageItems, hasMore: items.length > limit, nextKey: items.length > limit ? key(pageItems.at(-1)!) : null }
}

const sessionColumns =
  'session_id, current_project_id, current_cwd, transcript_path, file_size, file_mtime_ms, last_visible_message_at_ms, custom_title, ai_title, last_prompt, summary_hint, first_prompt, first_prompt_locked, command_fallback, git_branch, is_sidechain, entrypoint, session_kind, task_snapshot_json, task_snapshot_version, task_snapshot_updated_at_ms, is_valid_session_id'
export const listableSessionPredicate = `
  is_valid_session_id = 1
  AND transcript_path IS NOT NULL
  AND COALESCE(is_sidechain, 0) = 0
  AND COALESCE(custom_title, ai_title, last_prompt, summary_hint, CASE WHEN first_prompt_locked = 1 THEN first_prompt ELSE command_fallback END) IS NOT NULL
`
const projectHasListableSessionsPredicate = `
  EXISTS (
    SELECT 1 FROM session_index
    WHERE current_project_id = project_index.project_id
      AND ${listableSessionPredicate}
  )
`
const sessionActivitySortSql = 'COALESCE(last_visible_message_at_ms, file_mtime_ms)'

function sessionActivitySort(session: IndexedSession): number | null {
  return session.lastVisibleMessageAtMs ?? session.fileMtimeMs
}

export class TranscriptIndexStore {
  constructor(private readonly db: DatabaseSync) {}

  listProjects(): IndexedProject[] {
    return (
      this.db
        .prepare(`
      SELECT project_id, project_path, last_activity_at_ms
      FROM project_index
      WHERE ${projectHasListableSessionsPredicate}
      ORDER BY last_activity_at_ms DESC NULLS LAST, project_id
    `)
        .all() as ProjectRow[]
    ).map(toIndexedProject)
  }

  listProjectsPage(input: { limit: number; after?: KeysetCursorKey | null }): IndexedPage<IndexedProject> {
    const rows =
      input.after?.sort === null
        ? (this.db
            .prepare(`
        SELECT project_id, project_path, last_activity_at_ms
        FROM project_index
        WHERE ${projectHasListableSessionsPredicate}
          AND last_activity_at_ms IS NULL AND project_id > ?
        ORDER BY last_activity_at_ms DESC NULLS LAST, project_id
        LIMIT ?
      `)
            .all(input.after.id, input.limit + 1) as ProjectRow[])
        : input.after
          ? (this.db
              .prepare(`
          SELECT project_id, project_path, last_activity_at_ms
          FROM project_index
          WHERE ${projectHasListableSessionsPredicate} AND (
            (last_activity_at_ms IS NOT NULL AND (last_activity_at_ms < ? OR (last_activity_at_ms = ? AND project_id > ?)))
            OR last_activity_at_ms IS NULL
          )
          ORDER BY last_activity_at_ms DESC NULLS LAST, project_id
          LIMIT ?
        `)
              .all(input.after.sort, input.after.sort, input.after.id, input.limit + 1) as ProjectRow[])
          : (this.db
              .prepare(`
          SELECT project_id, project_path, last_activity_at_ms
          FROM project_index
          WHERE ${projectHasListableSessionsPredicate}
          ORDER BY last_activity_at_ms DESC NULLS LAST, project_id
          LIMIT ?
        `)
              .all(input.limit + 1) as ProjectRow[])
    return page(rows.map(toIndexedProject), input.limit, (project) => ({ sort: project.lastActivityAtMs, id: project.projectId }))
  }

  getProject(projectId: string): IndexedProject | null {
    const row = this.db
      .prepare(`
      SELECT project_id, project_path, last_activity_at_ms
      FROM project_index WHERE project_id = ?
    `)
      .get(projectId) as ProjectRow | undefined
    return row ? toIndexedProject(row) : null
  }

  listProjectSessions(projectId: string): IndexedSession[] {
    return (
      this.db
        .prepare(`
      SELECT ${sessionColumns}
      FROM session_index
      WHERE current_project_id = ? AND ${listableSessionPredicate}
      ORDER BY ${sessionActivitySortSql} DESC NULLS LAST, session_id
    `)
        .all(projectId) as SessionRow[]
    ).map(toIndexedSession)
  }

  listProjectSessionsPage(projectId: string, input: { limit: number; after?: KeysetCursorKey | null }): IndexedPage<IndexedSession> {
    const rows =
      input.after?.sort === null
        ? (this.db
            .prepare(`
        SELECT ${sessionColumns}
        FROM session_index
        WHERE current_project_id = ? AND ${listableSessionPredicate} AND ${sessionActivitySortSql} IS NULL AND session_id > ?
        ORDER BY ${sessionActivitySortSql} DESC NULLS LAST, session_id
        LIMIT ?
      `)
            .all(projectId, input.after.id, input.limit + 1) as SessionRow[])
        : input.after
          ? (this.db
              .prepare(`
          SELECT ${sessionColumns}
          FROM session_index
          WHERE current_project_id = ? AND ${listableSessionPredicate} AND (
            (${sessionActivitySortSql} IS NOT NULL AND (${sessionActivitySortSql} < ? OR (${sessionActivitySortSql} = ? AND session_id > ?)))
            OR ${sessionActivitySortSql} IS NULL
          )
          ORDER BY ${sessionActivitySortSql} DESC NULLS LAST, session_id
          LIMIT ?
        `)
              .all(projectId, input.after.sort, input.after.sort, input.after.id, input.limit + 1) as SessionRow[])
          : (this.db
              .prepare(`
          SELECT ${sessionColumns}
          FROM session_index
          WHERE current_project_id = ? AND ${listableSessionPredicate}
          ORDER BY ${sessionActivitySortSql} DESC NULLS LAST, session_id
          LIMIT ?
        `)
              .all(projectId, input.limit + 1) as SessionRow[])
    const defaultRow = this.db
      .prepare(`
      SELECT session_id FROM session_index
      WHERE current_project_id = ? AND ${listableSessionPredicate}
      ORDER BY ${sessionActivitySortSql} DESC NULLS LAST, session_id
      LIMIT 1
    `)
      .get(projectId) as { session_id: string } | undefined
    return { ...page(rows.map(toIndexedSession), input.limit, (session) => ({ sort: sessionActivitySort(session), id: session.sessionId })), defaultSessionId: defaultRow?.session_id ?? null }
  }

  getSession(sessionId: string): IndexedSession | null {
    const row = this.db
      .prepare(`
      SELECT ${sessionColumns}
      FROM session_index WHERE session_id = ?
    `)
      .get(sessionId) as SessionRow | undefined
    return row ? toIndexedSession(row) : null
  }

  listTranscriptSessions(): IndexedSession[] {
    return (
      this.db
        .prepare(`
      SELECT ${sessionColumns}
      FROM session_index
      WHERE transcript_path IS NOT NULL
         OR EXISTS (SELECT 1 FROM session_raw_transcript_lines WHERE session_id = session_index.session_id)
    `)
        .all() as SessionRow[]
    ).map(toIndexedSession)
  }

  upsertSession(input: {
    sessionId: string
    transcriptPath: string | null
    fileSize?: number | null
    fileMtimeMs?: number | null
    currentCwd?: string | null
    customTitle?: string | null
    aiTitle?: string | null
    lastPrompt?: string | null
    summaryHint?: string | null
    firstPrompt?: string | null
    firstPromptLocked?: boolean | null
    commandFallback?: string | null
    gitBranch?: string | null
    isSidechain?: boolean | null
    entrypoint?: string | null
    sessionKind?: string | null
    isValidSessionId?: boolean
    forceCurrent?: boolean
  }): void {
    const now = Date.now()
    const forceCurrent = input.forceCurrent ? 1 : 0
    const cwd = input.currentCwd ? normalizeProjectPath(input.currentCwd) : null
    const projectId = cwd ? projectIdFromPath(cwd) : null
    const previousProjectId = projectId
      ? (this.db.prepare('SELECT current_project_id FROM session_index WHERE session_id = ?').get(input.sessionId) as { current_project_id: string | null } | undefined)?.current_project_id
      : undefined
    const current = this.db
      .prepare(`
      INSERT INTO session_index (
        session_id, current_project_id, current_cwd, transcript_path, file_size, file_mtime_ms,
        custom_title, ai_title, last_prompt, summary_hint, first_prompt, first_prompt_locked, command_fallback,
        git_branch, is_sidechain, entrypoint, session_kind, is_valid_session_id, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        current_project_id = CASE WHEN (?20 = 1 OR excluded.file_mtime_ms >= COALESCE(session_index.file_mtime_ms, -1)) THEN COALESCE(excluded.current_project_id, session_index.current_project_id) ELSE session_index.current_project_id END,
        current_cwd = CASE WHEN (?20 = 1 OR excluded.file_mtime_ms >= COALESCE(session_index.file_mtime_ms, -1)) THEN COALESCE(excluded.current_cwd, session_index.current_cwd) ELSE session_index.current_cwd END,
        transcript_path = CASE WHEN (?20 = 1 OR excluded.file_mtime_ms >= COALESCE(session_index.file_mtime_ms, -1)) THEN excluded.transcript_path ELSE session_index.transcript_path END,
        file_size = CASE WHEN (?20 = 1 OR excluded.file_mtime_ms >= COALESCE(session_index.file_mtime_ms, -1)) THEN excluded.file_size ELSE session_index.file_size END,
        file_mtime_ms = CASE WHEN (?20 = 1 OR excluded.file_mtime_ms >= COALESCE(session_index.file_mtime_ms, -1)) THEN excluded.file_mtime_ms ELSE session_index.file_mtime_ms END,
        custom_title = CASE WHEN (?20 = 1 OR excluded.file_mtime_ms >= COALESCE(session_index.file_mtime_ms, -1)) THEN COALESCE(excluded.custom_title, session_index.custom_title) ELSE session_index.custom_title END,
        ai_title = CASE WHEN (?20 = 1 OR excluded.file_mtime_ms >= COALESCE(session_index.file_mtime_ms, -1)) THEN COALESCE(excluded.ai_title, session_index.ai_title) ELSE session_index.ai_title END,
        last_prompt = CASE WHEN (?20 = 1 OR excluded.file_mtime_ms >= COALESCE(session_index.file_mtime_ms, -1)) THEN COALESCE(excluded.last_prompt, session_index.last_prompt) ELSE session_index.last_prompt END,
        summary_hint = CASE WHEN (?20 = 1 OR excluded.file_mtime_ms >= COALESCE(session_index.file_mtime_ms, -1)) THEN COALESCE(excluded.summary_hint, session_index.summary_hint) ELSE session_index.summary_hint END,
        first_prompt = CASE
          WHEN excluded.file_mtime_ms < COALESCE(session_index.file_mtime_ms, -1) THEN session_index.first_prompt
          WHEN session_index.first_prompt_locked = 1 THEN session_index.first_prompt
          ELSE COALESCE(excluded.first_prompt, session_index.first_prompt)
        END,
        first_prompt_locked = CASE
          WHEN excluded.file_mtime_ms < COALESCE(session_index.file_mtime_ms, -1) THEN session_index.first_prompt_locked
          WHEN session_index.first_prompt_locked = 1 THEN 1
          ELSE COALESCE(excluded.first_prompt_locked, session_index.first_prompt_locked)
        END,
        command_fallback = CASE WHEN (?20 = 1 OR excluded.file_mtime_ms >= COALESCE(session_index.file_mtime_ms, -1)) THEN COALESCE(session_index.command_fallback, excluded.command_fallback) ELSE session_index.command_fallback END,
        git_branch = CASE WHEN (?20 = 1 OR excluded.file_mtime_ms >= COALESCE(session_index.file_mtime_ms, -1)) THEN COALESCE(excluded.git_branch, session_index.git_branch) ELSE session_index.git_branch END,
        is_sidechain = CASE WHEN (?20 = 1 OR excluded.file_mtime_ms >= COALESCE(session_index.file_mtime_ms, -1)) THEN COALESCE(session_index.is_sidechain, excluded.is_sidechain) ELSE session_index.is_sidechain END,
        entrypoint = CASE WHEN (?20 = 1 OR excluded.file_mtime_ms >= COALESCE(session_index.file_mtime_ms, -1)) THEN COALESCE(excluded.entrypoint, session_index.entrypoint) ELSE session_index.entrypoint END,
        session_kind = CASE WHEN (?20 = 1 OR excluded.file_mtime_ms >= COALESCE(session_index.file_mtime_ms, -1)) THEN COALESCE(excluded.session_kind, session_index.session_kind) ELSE session_index.session_kind END,
        is_valid_session_id = MAX(session_index.is_valid_session_id, excluded.is_valid_session_id),
        updated_at_ms = CASE WHEN (?20 = 1 OR excluded.file_mtime_ms >= COALESCE(session_index.file_mtime_ms, -1)) THEN excluded.updated_at_ms ELSE session_index.updated_at_ms END
      RETURNING current_project_id
    `)
      .get(
        input.sessionId,
        projectId,
        cwd,
        input.transcriptPath,
        input.fileSize ?? null,
        input.fileMtimeMs ?? null,
        input.customTitle ?? null,
        input.aiTitle ?? null,
        input.lastPrompt ?? null,
        input.summaryHint ?? null,
        input.firstPrompt ?? null,
        input.firstPromptLocked === undefined || input.firstPromptLocked === null ? null : input.firstPromptLocked ? 1 : 0,
        input.commandFallback ?? null,
        input.gitBranch ?? null,
        input.isSidechain === undefined || input.isSidechain === null ? null : input.isSidechain ? 1 : 0,
        input.entrypoint ?? null,
        input.sessionKind ?? null,
        (input.isValidSessionId ?? isValidSessionId(input.sessionId)) ? 1 : 0,
        now,
        forceCurrent,
      ) as { current_project_id: string | null }
    if (cwd) this.upsertProject(cwd, null, now)
    if (previousProjectId && previousProjectId !== current.current_project_id) {
      this.recomputeProjectActivity(previousProjectId)
      if (current.current_project_id) this.recomputeProjectActivity(current.current_project_id)
    }
  }

  updateTaskSnapshot(sessionId: string, snapshot: TaskSnapshotUpdate): boolean {
    const row = this.db.prepare('SELECT task_snapshot_version FROM session_index WHERE session_id = ?').get(sessionId) as { task_snapshot_version: string | null } | undefined
    if (!row || row.task_snapshot_version === snapshot.version) return false
    const now = snapshot.updatedAtMs ?? Date.now()
    const result = this.db
      .prepare(`
      UPDATE session_index
      SET task_snapshot_json = ?, task_snapshot_version = ?, task_snapshot_updated_at_ms = ?, updated_at_ms = ?
      WHERE session_id = ?
    `)
      .run(JSON.stringify(snapshot.tasks), snapshot.version, now, now, sessionId)
    return result.changes > 0
  }

  updateSessionActivity(sessionId: string, activityAtMs: number | null): void {
    const session = this.getSession(sessionId)
    if (!session) return
    this.db.prepare('UPDATE session_index SET last_visible_message_at_ms = ? WHERE session_id = ?').run(activityAtMs, sessionId)
    if (session.currentProjectId) this.recomputeProjectActivity(session.currentProjectId)
  }

  clearTranscriptPath(sessionId: string): void {
    const projectId = this.getSession(sessionId)?.currentProjectId
    this.db
      .prepare(`
      UPDATE session_index
      SET transcript_path = NULL, file_size = NULL, file_mtime_ms = NULL, last_visible_message_at_ms = NULL, updated_at_ms = ?
      WHERE session_id = ?
    `)
      .run(Date.now(), sessionId)
    if (projectId) this.recomputeProjectActivity(projectId)
  }

  deleteSession(sessionId: string): void {
    const projectId = this.getSession(sessionId)?.currentProjectId
    this.db.prepare('DELETE FROM session_index WHERE session_id = ?').run(sessionId)
    if (projectId) this.recomputeProjectActivity(projectId)
  }

  recomputeProjectActivity(projectId: string): void {
    this.db
      .prepare(`
      UPDATE project_index SET last_activity_at_ms = (
        SELECT MAX(COALESCE(last_visible_message_at_ms, file_mtime_ms))
        FROM session_index WHERE current_project_id = ? AND ${listableSessionPredicate}
      ), updated_at_ms = ? WHERE project_id = ?
    `)
      .run(projectId, Date.now(), projectId)
  }

  upsertProject(projectPath: string, activityAtMs: number | null, now = Date.now()): void {
    const normalizedPath = normalizeProjectPath(projectPath)
    this.db
      .prepare(`
      INSERT INTO project_index (project_id, project_path, last_activity_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        project_path = excluded.project_path,
        last_activity_at_ms = CASE
          WHEN excluded.last_activity_at_ms IS NULL THEN project_index.last_activity_at_ms
          WHEN project_index.last_activity_at_ms IS NULL THEN excluded.last_activity_at_ms
          ELSE MAX(project_index.last_activity_at_ms, excluded.last_activity_at_ms)
        END,
        updated_at_ms = excluded.updated_at_ms
    `)
      .run(projectIdFromPath(normalizedPath), normalizedPath, activityAtMs, now)
  }
}
