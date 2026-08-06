import { lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Hono } from 'hono'
import {
  createProjectRequestSchema,
  createTurnRequestSchema,
  deleteSessionRequestSchema,
  deleteSessionResponseSchema,
  forkSessionRequestSchema,
  forkSessionResponseSchema,
  modelCatalogResponseSchema,
  projectDirectoriesResponseSchema,
  projectSessionsQuerySchema,
  renameSessionRequestSchema,
  renameSessionResponseSchema,
  projectSessionsQueryResponseSchema,
  sessionInfoResponseSchema,
  sessionMetaUpdateRequestSchema,
  sessionRuntimeResponseSchema,
  sessionObservationSortSchema,
  sessionObservationsResponseSchema,
  settingsResponseSchema,
  turnMetaTranscriptResponseSchema,
  settingsUpdateRequestSchema,
  type CreateTurnResponse,
  type ListVersionsEvent,
  type ProjectDirectoriesResponse,
  type ProjectResponse,
  type ProjectsResponse,
  type ProjectSessionsQueryResponse,
  type ProjectSessionsResponse,
  type SessionInfoResponse,
  type SessionLiveEventsResponse,
  type SessionRawMessagesResponse,
  type SessionTimelineResponse,
  type SessionRunState,
  type SessionTimelineStateResponse,
  type TurnSummary,
} from '@cotta/shared'
import { projectIdFromPath, projectPathFromId, type ClaudeCodeApi } from '../claude-code-api.js'
import { ListCursorError } from '../list-cursor.js'
import type { SessionMetadata, SessionSummaryCache } from '../session-summary-cache.js'
import type { ClaudeSessionRegistry } from '../claude-session-registry.js'
import type { LiveEventStore } from '../live-event-store.js'
import type { LiveTurnManager } from '../live-turn-manager.js'
import type { ModelCatalogProvider } from '../model-catalog.js'
import type { SettingsStore } from '../settings-store.js'
import type { SessionMetaStore } from '../session-meta-store.js'
import { projectSessionTimeline, sessionMessagesForTurn } from '../timeline-projection.js'
import { normalizeModelEffortSelection, persistedTurnOptions, readSettings, resolveTurnOptions, validateTurnOptions } from '../turn-options.js'

export type ProjectRoutesLiveTurnManager = Pick<LiveTurnManager, 'interrupt' | 'sessionRunState' | 'startTurn' | 'subscribe'> & {
  ensureRuntime(input: Parameters<LiveTurnManager['ensureRuntime']>[0]): void | Promise<void>
  closeForExternalOwner?(sessionId: string): Promise<boolean>
}
export type ProjectRoutesLiveEventStore = Pick<LiveEventStore, 'listSessionEvents'>
export type ProjectRoutesSessionObservationReader = Pick<ClaudeSessionRegistry, 'listObservations'>
type TurnMetadataValue = Pick<TurnSummary, 'durationMs' | 'durationTimestampMs' | 'pendingBackgroundAgentCount' | 'awaySummary'>
type TimelineMetadata = { turnMetadata: ReadonlyMap<string, TurnMetadataValue>; sessionMeta: SessionTimelineResponse['sessionMeta'] }
export type ProjectRoutesTimelineMetadataReader = (projectId: string, sessionId: string) => TimelineMetadata | Promise<TimelineMetadata>
export type ProjectRoutesTurnMetaTranscriptReader = { listEntries(input: { sessionId?: string; limit: number; offset: number }): unknown }

function parseLimit(value: string | undefined, fallback: number, max = 10_000): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(max, Math.trunc(parsed)))
}

function parseLiveEventLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(1000, Math.trunc(parsed)))
}

function parseCursor(value: string | undefined): string | null {
  return value && value.trim() ? value.trim() : null
}

function encodeSse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function listCursorErrorResponse(error: unknown) {
  if (!(error instanceof ListCursorError)) return null
  return error.code === 'stale'
    ? { status: 409 as const, body: { error: 'pagination_cursor_stale' } }
    : { status: 400 as const, body: { error: 'invalid_cursor' } }
}

function applyTurnMetadata<T extends { turns: Array<{ primaryUserUuid: string }> }>(timeline: T, metadata: ReadonlyMap<string, TurnMetadataValue>): T {
  if (metadata.size === 0) return timeline
  return { ...timeline, turns: timeline.turns.map((turn) => {
    const value = metadata.get(turn.primaryUserUuid)
    return value ? { ...turn, ...value } : turn
  }) }
}

function isPathInside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function projectsRoot(): string {
  return resolve(process.env.COTTA_PROJECTS_ROOT ?? homedir())
}

function isSafeRelativeProjectPath(directoryPath: string): boolean {
  if (!directoryPath) return true
  if (directoryPath.includes('\0') || directoryPath.startsWith('/') || directoryPath.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(directoryPath)) return false
  return directoryPath.split(/[\\/]+/).every((segment) => segment && segment !== '.' && segment !== '..')
}

async function listProjectDirectories(parent = ''): Promise<ProjectDirectoriesResponse | { error: 'invalid_project_path' | 'projects_root_unavailable' | 'project_directories_failed' }> {
  const root = projectsRoot()
  if (!isSafeRelativeProjectPath(parent)) return { error: 'invalid_project_path' }
  try {
    if (!(await stat(root)).isDirectory()) return { error: 'projects_root_unavailable' }
    const resolvedRoot = await realpath(root)
    const parentPath = parent ? resolve(resolvedRoot, parent) : resolvedRoot
    const resolvedParent = await realpath(parentPath)
    if (!isPathInside(resolvedRoot, resolvedParent) || !(await stat(resolvedParent)).isDirectory()) return { error: 'invalid_project_path' }
    const directories = (await readdir(resolvedParent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: relative(resolvedRoot, resolve(resolvedParent, entry.name)) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return { parent, directories }
  } catch {
    return { error: 'project_directories_failed' }
  }
}

async function createProjectDirectory(directoryPath: string) {
  const root = projectsRoot()
  const segments = directoryPath.split(/[\\/]+/)

  try {
    if (!(await stat(root)).isDirectory()) return { error: 'projects_root_unavailable' as const }
    const resolvedRoot = await realpath(root)
    let current = resolvedRoot

    for (const [index, segment] of segments.entries()) {
      const target = resolve(current, segment)
      if (!isPathInside(resolvedRoot, target)) return { error: 'invalid_project_path' as const }
      const isFinal = index === segments.length - 1

      try {
        await lstat(target)
        if (isFinal) return { error: 'project_already_exists' as const }
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') return { error: 'project_create_failed' as const }
        await mkdir(target)
      }

      current = await realpath(target)
      if (!isPathInside(resolvedRoot, current)) return { error: 'invalid_project_path' as const }
    }

    return { project: { id: projectIdFromPath(current), name: segments.at(-1)!, path: current } }
  } catch (error) {
    return { error: 'project_create_failed' as const }
  }
}

function defaultRunState(): SessionRunState {
  return { phase: 'idle', activeUserMessageUuid: null }
}

function statusFromRunState(runState: SessionRunState): 'idle' | 'busy' | 'shell' | 'waiting' {
  if (runState.phase === 'running' || runState.phase === 'cli_busy') return 'busy'
  if (runState.phase === 'requires_action' || runState.phase === 'cli_waiting') return 'waiting'
  if (runState.phase === 'cli_shell') return 'shell'
  return 'idle'
}

function isBackgroundKind(kind: string | null | undefined): boolean {
  return kind === 'bg' || kind === 'daemon' || kind === 'daemon-worker'
}

function sessionRuntimeExternallyOwned(metadata: SessionMetadata | null | undefined): boolean {
  return metadata?.entrypoint === 'cli' && (isBackgroundKind(metadata.kind) || metadata.status !== 'idle')
}

function overlayLiveSessionRunState<T extends { sessions: Array<{ id: string }> }>(
  liveTurnManager: ProjectRoutesLiveTurnManager,
  response: T,
  sessionMetadataReader?: (sessionId: string) => SessionMetadata | null,
): T {
  return {
    ...response,
    sessions: response.sessions.map((session) => {
      const runState = liveTurnManager.sessionRunState(session.id) ?? defaultRunState()
      const metadata = sessionMetadataReader?.(session.id) ?? null
      return {
        ...session,
        status: runState.phase === 'idle' ? metadata?.status ?? 'idle' : statusFromRunState(runState),
        hasRunningShell: metadata?.hasRunningShell ?? false,
        kind: metadata?.kind ?? null,
        entrypoint: metadata?.entrypoint ?? null,
      }
    }),
  }
}

export function registerProjectRoutes(
  app: Hono,
  input: { claudeCodeApi: ClaudeCodeApi; liveTurnManager: ProjectRoutesLiveTurnManager; modelCatalogProvider: ModelCatalogProvider; settingsStore?: SettingsStore; sessionMetaStore?: SessionMetaStore; liveEventStore?: ProjectRoutesLiveEventStore; sessionSummaryCache?: SessionSummaryCache; sessionObservationReader?: ProjectRoutesSessionObservationReader; sessionMetadataReader?: (sessionId: string) => SessionMetadata | null; timelineMetadataReader?: ProjectRoutesTimelineMetadataReader; turnMetaTranscriptReader?: ProjectRoutesTurnMetaTranscriptReader },
): void {
  app.get('/api/debug/turn-meta-transcript', (c) => {
    if (!input.turnMetaTranscriptReader) return c.json({ error: 'turn_meta_transcript_unavailable' }, 503)
    const sessionId = c.req.query('sessionId')
    const limit = Number(c.req.query('limit') ?? 100)
    const offset = Number(c.req.query('offset') ?? 0)
    if (!Number.isInteger(limit) || limit < 1 || limit > 250 || !Number.isInteger(offset) || offset < 0) {
      return c.json({ error: 'invalid_turn_meta_transcript_query' }, 400)
    }
    return c.json(turnMetaTranscriptResponseSchema.parse(input.turnMetaTranscriptReader.listEntries({ sessionId, limit, offset })))
  })

  app.get('/api/debug/session-observations', (c) => {
    if (!input.sessionObservationReader) return c.json({ error: 'session_observations_unavailable' }, 503)
    const encodedSessionId = c.req.query('sessionId')
    const sessionId = encodedSessionId === undefined ? undefined : encodedSessionId || null
    const sort = sessionObservationSortSchema.safeParse(c.req.query('sort') ?? 'observedAtMs')
    const direction = c.req.query('direction') ?? 'desc'
    const limit = Number(c.req.query('limit') ?? 100)
    const offset = Number(c.req.query('offset') ?? 0)
    if (!sort.success || (direction !== 'asc' && direction !== 'desc') || !Number.isInteger(limit) || limit < 1 || limit > 250 || !Number.isInteger(offset) || offset < 0) {
      return c.json({ error: 'invalid_session_observations_query' }, 400)
    }
    return c.json(sessionObservationsResponseSchema.parse(input.sessionObservationReader.listObservations({ sessionId, sort: sort.data, direction, limit, offset })))
  })

  app.get('/api/settings', (c) => c.json(settingsResponseSchema.parse({ settings: readSettings(input.settingsStore) })))

  app.put('/api/settings', async (c) => {
    try {
      const body = settingsUpdateRequestSchema.safeParse(await c.req.json())
      if (!body.success) return c.json({ error: 'invalid_settings_update' }, 400)
      const settings = body.data.settings
      const normalized = settings.defaultModel === undefined
        ? settings
        : (() => {
            const pair = normalizeModelEffortSelection({ model: settings.defaultModel, effort: settings.defaultEffort! }, readSettings(input.settingsStore).modelCatalog)
            return { ...settings, defaultModel: pair.model, defaultEffort: pair.effort }
          })()
      input.settingsStore?.setMany('global', normalized)
      return c.json(settingsResponseSchema.parse({ settings: readSettings(input.settingsStore) }))
    } catch (error) {
      console.error('settings:update failed', error)
      return c.json({ error: 'settings_update_failed' }, 500)
    }
  })

  app.post('/api/settings/model-catalog/refresh', async (c) => {
    try {
      const projectId = c.req.query('projectId')
      const cwd = projectId ? projectPathFromId(projectId) : undefined
      if (projectId && !cwd) return c.json({ error: 'invalid_project_id' }, 400)
      input.settingsStore?.setMany('global', { modelCatalog: await input.modelCatalogProvider(cwd ?? undefined) })
      return c.json(settingsResponseSchema.parse({ settings: readSettings(input.settingsStore) }))
    } catch (error) {
      console.error('settings:model-catalog-refresh failed', error)
      return c.json({ error: 'model_catalog_refresh_failed' }, 500)
    }
  })

  app.get('/api/model-catalog', async (c) => {
    try {
      const projectId = c.req.query('projectId')
      const cwd = projectId ? projectPathFromId(projectId) : undefined
      if (projectId && !cwd) return c.json({ error: 'invalid_project_id' }, 400)
      return c.json(modelCatalogResponseSchema.parse(await input.modelCatalogProvider(cwd ?? undefined)))
    } catch (error) {
      console.error('model-catalog:list failed', error)
      return c.json({ error: 'model_catalog_failed' }, 500)
    }
  })

  app.get('/api/projects', async (c) => {
    try {
      const response: ProjectsResponse = await input.claudeCodeApi.listProjects({
        limit: parseLimit(c.req.query('limit'), 20),
        cursor: parseCursor(c.req.query('cursor')),
      })
      return c.json(response)
    } catch (error) {
      const cursorError = listCursorErrorResponse(error)
      if (cursorError) return c.json(cursorError.body, cursorError.status)
      console.error('projects:list failed', error)
      return c.json({ error: 'projects_list_failed' }, 500)
    }
  })

  app.get('/api/project-directories', async (c) => {
    try {
      const result = await listProjectDirectories(c.req.query('parent') ?? '')
      if ('error' in result) {
        const status = result.error === 'projects_root_unavailable' ? 503 : result.error === 'invalid_project_path' ? 400 : 500
        return c.json({ error: result.error }, status)
      }
      return c.json(projectDirectoriesResponseSchema.parse(result))
    } catch (error) {
      console.error('project-directories:list failed', error)
      return c.json({ error: 'project_directories_failed' }, 500)
    }
  })

  app.post('/api/projects', async (c) => {
    try {
      const parsed = createProjectRequestSchema.safeParse(await c.req.json())
      if (!parsed.success) return c.json({ error: 'invalid_project_path' }, 400)
      const result = await createProjectDirectory(parsed.data.directoryPath)
      if ('error' in result) {
        const status = result.error === 'project_already_exists' ? 409 : result.error === 'projects_root_unavailable' ? 503 : result.error === 'invalid_project_path' ? 400 : 500
        return c.json({ error: result.error }, status)
      }
      return c.json(result, 201)
    } catch (error) {
      console.error('projects:create failed', error)
      return c.json({ error: 'project_create_failed' }, 500)
    }
  })

  app.get('/api/projects/:projectId', async (c) => {
    try {
      const project = await input.claudeCodeApi.getProject(c.req.param('projectId'))
      if (!project) {
        return c.json({ error: 'project_not_found' }, 404)
      }
      const response: ProjectResponse = { project }
      return c.json(response)
    } catch (error) {
      console.error('projects:get failed', error)
      return c.json({ error: 'project_get_failed' }, 500)
    }
  })

  app.get('/api/projects/:projectId/sessions', async (c) => {
    try {
      const result = await input.claudeCodeApi.listProjectSessions(c.req.param('projectId'), {
        limit: parseLimit(c.req.query('limit'), 10),
        cursor: parseCursor(c.req.query('cursor')),
      })
      if (!result) {
        return c.json({ error: 'project_not_found' }, 404)
      }
      const response: ProjectSessionsResponse = input.sessionSummaryCache ? result : overlayLiveSessionRunState(input.liveTurnManager, result, input.sessionMetadataReader)
      return c.json(response)
    } catch (error) {
      const cursorError = listCursorErrorResponse(error)
      if (cursorError) return c.json(cursorError.body, cursorError.status)
      console.error('projects:sessions failed', error)
      return c.json({ error: 'project_sessions_failed' }, 500)
    }
  })

  app.post('/api/project-sessions/query', async (c) => {
    try {
      if (!input.sessionSummaryCache) return c.json({ error: 'project_sessions_query_unavailable' }, 503)
      const body = projectSessionsQuerySchema.parse(await c.req.json())
      const sessionsByProject = (await input.sessionSummaryCache.queryProjectSessions(body)).sessionsByProject
      const response: ProjectSessionsQueryResponse = projectSessionsQueryResponseSchema.parse({
        sessionsByProject,
      })
      return c.json(response)
    } catch (error) {
      console.error('project-sessions:query failed', error)
      return c.json({ error: 'project_sessions_query_failed' }, 500)
    }
  })

  app.get('/api/list-versions/events', (c) => {
    const cache = input.sessionSummaryCache
    if (!cache) return c.json({ error: 'list_versions_unavailable' }, 503)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(encoder.encode(': connected\n\n'))
        controller.enqueue(encoder.encode(encodeSse(cache.versionSnapshot)))
        const unsubscribe = cache.subscribe((event: ListVersionsEvent) => {
          controller.enqueue(encoder.encode(encodeSse(event)))
        })
        c.req.raw.signal.addEventListener('abort', () => {
          unsubscribe()
          controller.close()
        }, { once: true })
      },
    })
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  })

  app.post('/api/projects/refresh', async (c) => {
    try {
      if (!input.sessionSummaryCache) return c.json({ error: 'projects_refresh_unavailable' }, 503)
      await input.sessionSummaryCache.scheduleRefresh({ reason: 'manual' })
      return c.json({ ok: true })
    } catch (error) {
      console.error('projects:refresh failed', error)
      return c.json({ error: 'projects_refresh_failed' }, 500)
    }
  })

  app.post('/api/projects/:projectId/refresh', async (c) => {
    try {
      if (!input.sessionSummaryCache) return c.json({ error: 'projects_refresh_unavailable' }, 503)
      await input.sessionSummaryCache.scheduleRefresh({ reason: 'manual' })
      return c.json({ ok: true })
    } catch (error) {
      console.error('project:refresh failed', error)
      return c.json({ error: 'project_refresh_failed' }, 500)
    }
  })

  app.post('/api/projects/:projectId/sessions', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const body = createTurnRequestSchema.parse(await c.req.json())
      if (!body.sessionId) return c.json({ error: 'session_id_required' }, 400)
      const options = resolveTurnOptions({ projectId, sessionId: body.sessionId, settingsStore: input.settingsStore, sessionMetaStore: input.sessionMetaStore })
      const validation = validateTurnOptions(options, input.settingsStore)
      if (!validation.ok) return c.json({ error: validation.error }, 400)
      const model = options.model
      const effort = options.effort
      const result = await input.liveTurnManager.startTurn({
        projectId,
        sessionId: body.sessionId,
        resume: false,
        text: body.text,
        userMessageUuid: body.userMessageUuid,
        permissionMode: options.permissionMode,
        ...(model ? { model } : {}),
        effort,
      })
      const response: CreateTurnResponse = {
        projectId: c.req.param('projectId'),
        sessionId: result.sessionId,
        userMessageUuid: result.userMessageUuid,
      }
      return c.json(response, 202)
    } catch (error) {
      console.error('sessions:create failed', error)
      return c.json({ error: 'session_create_failed' }, 500)
    }
  })

  app.post('/api/projects/:projectId/sessions/:sessionId/turns', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const sessionId = c.req.param('sessionId')
      const body = createTurnRequestSchema.parse(await c.req.json())
      if (body.sessionId && body.sessionId !== sessionId) return c.json({ error: 'session_id_mismatch' }, 400)
      const options = resolveTurnOptions({ projectId, sessionId, settingsStore: input.settingsStore, sessionMetaStore: input.sessionMetaStore })
      const validation = validateTurnOptions(options, input.settingsStore)
      if (!validation.ok) return c.json({ error: validation.error }, 400)
      const model = options.model
      const effort = options.effort
      const result = await input.liveTurnManager.startTurn({
        projectId,
        sessionId,
        resume: true,
        text: body.text,
        userMessageUuid: body.userMessageUuid,
        permissionMode: options.permissionMode,
        ...(model ? { model } : {}),
        effort,
      })
      const response: CreateTurnResponse = {
        projectId: c.req.param('projectId'),
        sessionId: result.sessionId,
        userMessageUuid: result.userMessageUuid,
      }
      return c.json(response, 202)
    } catch (error) {
      console.error('turns:create failed', error)
      return c.json({ error: 'turn_create_failed' }, 500)
    }
  })

  app.post('/api/projects/:projectId/sessions/:sessionId/rename', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const sessionId = c.req.param('sessionId')
      const parsed = renameSessionRequestSchema.safeParse(await c.req.json())
      if (!parsed.success) return c.json({ error: 'invalid_session_title' }, 400)
      const renamed = await input.claudeCodeApi.renameSession(projectId, sessionId, parsed.data.title)
      if (!renamed) return c.json({ error: 'session_not_found' }, 404)
      await input.sessionSummaryCache?.scheduleRefresh({ reason: 'manual', projectId, sessionId })
      return c.json(renameSessionResponseSchema.parse({ ok: true }))
    } catch (error) {
      console.error('session:rename failed', error)
      return c.json({ error: 'session_rename_failed' }, 500)
    }
  })

  app.post('/api/projects/:projectId/sessions/:sessionId/fork', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const sourceSessionId = c.req.param('sessionId')
      const parsed = forkSessionRequestSchema.safeParse(await c.req.json())
      if (!parsed.success) return c.json({ error: 'invalid_fork_target' }, 400)
      const sessionId = await input.claudeCodeApi.forkSession(projectId, sourceSessionId, parsed.data.upToMessageId)
      if (!sessionId) return c.json({ error: 'session_not_found' }, 404)
      await input.sessionSummaryCache?.scheduleRefresh({ reason: 'manual', projectId, sessionId })
      return c.json(forkSessionResponseSchema.parse({ projectId, sessionId }), 201)
    } catch (error) {
      console.error('session:fork failed', error)
      return c.json({ error: 'session_fork_failed' }, 500)
    }
  })

  app.post('/api/projects/:projectId/sessions/:sessionId/delete', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const sessionId = c.req.param('sessionId')
      const parsed = deleteSessionRequestSchema.safeParse(await c.req.json())
      if (!parsed.success || parsed.data.confirmationSessionId !== sessionId) return c.json({ error: 'invalid_session_delete_confirmation' }, 400)
      const deleted = await input.claudeCodeApi.deleteSession(projectId, sessionId)
      if (!deleted) return c.json({ error: 'session_not_found' }, 404)
      await input.sessionSummaryCache?.scheduleRefresh({ reason: 'manual', projectId, sessionId })
      return c.json(deleteSessionResponseSchema.parse({ ok: true }))
    } catch (error) {
      console.error('session:delete failed', error)
      return c.json({ error: 'session_delete_failed' }, 500)
    }
  })

  app.get('/api/projects/:projectId/sessions/:sessionId/info', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const sessionId = c.req.param('sessionId')
      const session = await input.claudeCodeApi.getSessionInfo(projectId, sessionId)
      if (!session) return c.json({ error: 'session_not_found' }, 404)
      return c.json(sessionInfoResponseSchema.parse(session))
    } catch (error) {
      console.error('session:info failed', error)
      return c.json({ error: 'session_info_failed' }, 500)
    }
  })

  app.put('/api/projects/:projectId/sessions/:sessionId/meta', async (c) => {
    try {
      if (!input.sessionMetaStore) return c.json({ error: 'session_meta_unavailable' }, 503)
      const projectId = c.req.param('projectId')
      const sessionId = c.req.param('sessionId')
      const parsed = sessionMetaUpdateRequestSchema.safeParse(await c.req.json())
      if (!parsed.success) return c.json({ error: 'invalid_session_meta_update' }, 400)
      const body = parsed.data
      const normalized = body.model === undefined
        ? body
        : { ...body, ...normalizeModelEffortSelection({ model: body.model, effort: body.effort! }, readSettings(input.settingsStore).modelCatalog) }
      input.sessionMetaStore.setSessionMeta(projectId, sessionId, normalized)
      return c.json({ ok: true })
    } catch (error) {
      console.error('session:meta failed', error)
      return c.json({ error: 'session_meta_failed' }, 500)
    }
  })

  app.post('/api/projects/:projectId/sessions/:sessionId/runtime', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const sessionId = c.req.param('sessionId')
      const state = await input.claudeCodeApi.getSessionTimelineState(projectId, sessionId)
      if (!state) {
        return c.json({ error: 'session_not_found' }, 404)
      }
      const options = resolveTurnOptions({ projectId, sessionId, settingsStore: input.settingsStore, sessionMetaStore: input.sessionMetaStore })
      const validation = validateTurnOptions(options, input.settingsStore)
      if (!validation.ok) return c.json({ error: validation.error }, 400)
      const metadata = input.sessionMetadataReader?.(sessionId) ?? null
      if (!sessionRuntimeExternallyOwned(metadata)) {
        const model = options.model
        const effort = options.effort
        await input.liveTurnManager.ensureRuntime({
          projectId,
          sessionId,
          permissionMode: options.permissionMode,
          ...(model ? { model } : {}),
          effort,
        })
      }
      return c.json(sessionRuntimeResponseSchema.parse({
        ok: true,
        projectId,
        sessionId,
        settings: persistedTurnOptions(options),
      }))
    } catch (error) {
      console.error('session:runtime failed', error)
      return c.json({ error: 'session_runtime_failed' }, 500)
    }
  })

  async function interruptSession(sessionId: string) {
    return { interrupted: await input.liveTurnManager.interrupt(sessionId) }
  }

  app.post('/api/projects/:projectId/sessions/:sessionId/interrupt', async (c) => {
    try {
      return c.json(await interruptSession(c.req.param('sessionId')))
    } catch (error) {
      console.error('session:interrupt failed', error)
      return c.json({ error: 'session_interrupt_failed' }, 500)
    }
  })

  app.post('/api/projects/:projectId/sessions/:sessionId/turns/:turnId/interrupt', async (c) => {
    try {
      return c.json(await interruptSession(c.req.param('sessionId')))
    } catch (error) {
      console.error('turns:interrupt failed', error)
      return c.json({ error: 'turn_interrupt_failed' }, 500)
    }
  })

  app.get('/api/projects/:projectId/sessions/:sessionId/events', (c) => {
    const sessionId = c.req.param('sessionId')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(encoder.encode(': connected\n\n'))
        const unsubscribe = input.liveTurnManager.subscribe(sessionId, (event) => {
          controller.enqueue(encoder.encode(encodeSse(event)))
        })
        c.req.raw.signal.addEventListener('abort', () => {
          unsubscribe()
          controller.close()
        }, { once: true })
      },
    })
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  })

  app.get('/api/projects/:projectId/sessions/:sessionId/timeline/state', async (c) => {
    try {
      const state = await input.claudeCodeApi.getSessionTimelineState(
        c.req.param('projectId'),
        c.req.param('sessionId'),
      )
      if (!state) {
        return c.json({ error: 'session_not_found' }, 404)
      }
      const response: SessionTimelineStateResponse = { state }
      return c.json(response)
    } catch (error) {
      console.error('session:timeline-state failed', error)
      return c.json({ error: 'session_timeline_state_failed' }, 500)
    }
  })

  app.get('/api/projects/:projectId/sessions/:sessionId/timeline', async (c) => {
    try {
      const state = await input.claudeCodeApi.getSessionTimelineState(
        c.req.param('projectId'),
        c.req.param('sessionId'),
      )
      if (!state) {
        return c.json({ error: 'session_not_found' }, 404)
      }
      const messages = await input.claudeCodeApi.getSessionMessages(
        c.req.param('projectId'),
        c.req.param('sessionId'),
      )
      if (!messages) {
        return c.json({ error: 'session_not_found' }, 404)
      }
      const sessionId = c.req.param('sessionId')
      const timeline = projectSessionTimeline(sessionId, messages, {
        limitTurns: parseLimit(c.req.query('limitTurns'), 10, 100),
        cursor: parseCursor(c.req.query('cursor')),
      })
      let metadata: TimelineMetadata = { turnMetadata: new Map(), sessionMeta: { permissionMode: null, model: null, effort: null } }
      try {
        metadata = await input.timelineMetadataReader?.(c.req.param('projectId'), sessionId) ?? metadata
      } catch (error) {
        console.error('timeline-metadata-reader failed', error)
      }
      const response: SessionTimelineResponse = {
        ...applyTurnMetadata(timeline, metadata.turnMetadata),
        sessionMeta: metadata.sessionMeta,
        state,
      }
      return c.json(response)
    } catch (error) {
      console.error('session:timeline failed', error)
      return c.json({ error: 'session_timeline_failed' }, 500)
    }
  })

  app.get('/api/projects/:projectId/sessions/:sessionId/live-events', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const sessionId = c.req.param('sessionId')
      const state = await input.claudeCodeApi.getSessionTimelineState(projectId, sessionId)
      if (!state) {
        return c.json({ error: 'session_not_found' }, 404)
      }
      const response: SessionLiveEventsResponse = {
        sessionId,
        events: input.liveEventStore?.listSessionEvents(projectId, sessionId, parseLiveEventLimit(c.req.query('limit'), 500)) ?? [],
      }
      return c.json(response)
    } catch (error) {
      console.error('session:live-events failed', error)
      return c.json({ error: 'session_live_events_failed' }, 500)
    }
  })

  app.get('/api/projects/:projectId/live-sessions/:sessionId/events', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const sessionId = c.req.param('sessionId')
      const state = await input.claudeCodeApi.getSessionTimelineState(projectId, sessionId)
      if (!state) {
        return c.json({ error: 'session_not_found' }, 404)
      }
      const response: SessionLiveEventsResponse = {
        sessionId,
        events: input.liveEventStore?.listSessionEvents(projectId, sessionId, parseLiveEventLimit(c.req.query('limit'), 500)) ?? [],
      }
      return c.json(response)
    } catch (error) {
      console.error('session:live-events failed', error)
      return c.json({ error: 'session_live_events_failed' }, 500)
    }
  })

  app.get('/api/projects/:projectId/sessions/:sessionId/raw-messages', async (c) => {
    try {
      const messages = await input.claudeCodeApi.getSessionMessages(
        c.req.param('projectId'),
        c.req.param('sessionId'),
      )
      if (!messages) {
        return c.json({ error: 'session_not_found' }, 404)
      }
      const turnId = c.req.query('turnId')
      const turnMessages = turnId ? sessionMessagesForTurn(messages, turnId) : messages
      if (!turnMessages) {
        return c.json({ error: 'turn_not_found' }, 404)
      }
      const response: SessionRawMessagesResponse = {
        sessionId: c.req.param('sessionId'),
        messages: turnMessages,
      }
      return c.json(response)
    } catch (error) {
      console.error('session:raw-messages failed', error)
      return c.json({ error: 'session_raw_messages_failed' }, 500)
    }
  })
}
