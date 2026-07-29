import { lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Hono } from 'hono'
import {
  appSettingsSchema,
  createProjectRequestSchema,
  createTurnRequestSchema,
  modelCatalogResponseSchema,
  projectSessionsQuerySchema,
  projectSessionsQueryResponseSchema,
  permissionModeSchema,
  sessionInfoResponseSchema,
  sessionRuntimeResponseSchema,
  settingsResponseSchema,
  settingsUpdateRequestSchema,
  type AppSettings,
  type CreateTurnRequest,
  type CreateTurnResponse,
  type DefaultTurnOption,
  type EffortLevel,
  type ModelCatalogItem,
  type ModelSelection,
  type ListVersionsEvent,
  type PermissionMode,
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
} from '@cotta/shared'
import { projectIdFromPath, projectPathFromId, type ClaudeCodeApi } from '../claude-code-api.js'
import { ListCursorError } from '../list-cursor.js'
import type { SessionSummaryCache } from '../session-summary-cache.js'
import type { LiveEventStore } from '../live-event-store.js'
import type { LiveTurnManager } from '../live-turn-manager.js'
import type { ModelCatalogProvider } from '../model-catalog.js'
import type { SettingsStore } from '../settings-store.js'
import { projectSessionTimeline, sessionMessagesForTurn } from '../timeline-projection.js'

export type ProjectRoutesLiveTurnManager = Pick<LiveTurnManager, 'ensureRuntime' | 'interrupt' | 'sessionRunState' | 'startTurn' | 'subscribe'>
export type ProjectRoutesLiveEventStore = Pick<LiveEventStore, 'listSessionEvents'>

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

function isPathInside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function projectsRoot(): string {
  return resolve(process.env.COTTA_PROJECTS_ROOT ?? homedir())
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
  return { phase: 'idle', activeTurnId: null }
}

function overlayLiveSessionRunState<T extends { sessions: Array<{ id: string }> }>(
  liveTurnManager: ProjectRoutesLiveTurnManager,
  response: T,
): T {
  return {
    ...response,
    sessions: response.sessions.map((session) => ({
      ...session,
      runState: liveTurnManager.sessionRunState(session.id) ?? defaultRunState(),
    })),
  }
}

function matchingCatalogModel(models: ModelCatalogItem[], model: string): ModelCatalogItem | undefined {
  return models.find((item) => item.value === model || item.resolvedModel === model)
}

function readSettings(settingsStore?: SettingsStore): AppSettings {
  return appSettingsSchema.parse(settingsStore?.getAll('global') ?? {})
}

type ResolvedTurnOptions = {
  permissionMode: PermissionMode
  model: ModelSelection | DefaultTurnOption | null
  effort: EffortLevel | DefaultTurnOption | null
}

function resolveTurnOptions(input: { body?: Pick<CreateTurnRequest, 'permissionMode' | 'model' | 'effort'>; projectId: string; sessionId?: string; settingsStore?: SettingsStore }): ResolvedTurnOptions {
  const globalSettings = readSettings(input.settingsStore)
  const sessionSettings = input.sessionId ? input.settingsStore?.getSessionSettings(input.projectId, input.sessionId) : null
  return {
    permissionMode: input.body?.permissionMode ?? sessionSettings?.permissionMode ?? globalSettings.defaultPermissionMode ?? 'default',
    model: input.body?.model ?? sessionSettings?.model ?? globalSettings.defaultModel ?? null,
    effort: input.body?.effort ?? sessionSettings?.effort ?? globalSettings.defaultEffort ?? null,
  }
}

function sdkModel(model: ResolvedTurnOptions['model']): ModelSelection | undefined {
  return !model || model === 'default' ? undefined : model
}

function sdkEffort(effort: ResolvedTurnOptions['effort']): EffortLevel | undefined {
  return !effort || effort === 'default' ? undefined : effort
}

function persistedTurnOptions(options: ResolvedTurnOptions) {
  return { ...options, model: sdkModel(options.model) ?? null, effort: sdkEffort(options.effort) ?? null }
}

function validateTurnOptions(options: ResolvedTurnOptions, settingsStore?: SettingsStore): { ok: true } | { ok: false; error: 'unsupported_model' | 'unsupported_effort' } {
  const modelValue = sdkModel(options.model)
  const effortValue = sdkEffort(options.effort)
  if (!modelValue && !effortValue) return { ok: true }
  const catalog = readSettings(settingsStore).modelCatalog
  if (!catalog) return { ok: true }
  const model = modelValue ? matchingCatalogModel(catalog.models, modelValue) : catalog.models[0]
  if (!model) return { ok: false, error: 'unsupported_model' }
  if (effortValue && (!model.supportsEffort || !model.supportedEffortLevels?.includes(effortValue))) return { ok: false, error: 'unsupported_effort' }
  return { ok: true }
}

export function registerProjectRoutes(
  app: Hono,
  input: { claudeCodeApi: ClaudeCodeApi; liveTurnManager: ProjectRoutesLiveTurnManager; modelCatalogProvider: ModelCatalogProvider; settingsStore?: SettingsStore; liveEventStore?: ProjectRoutesLiveEventStore; sessionSummaryCache?: SessionSummaryCache },
): void {
  app.get('/api/settings', (c) => c.json(settingsResponseSchema.parse({ settings: readSettings(input.settingsStore) })))

  app.put('/api/settings', async (c) => {
    try {
      const body = settingsUpdateRequestSchema.parse(await c.req.json())
      input.settingsStore?.setMany('global', body.settings)
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
      const response: ProjectSessionsResponse = input.sessionSummaryCache ? result : overlayLiveSessionRunState(input.liveTurnManager, result)
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
      const options = resolveTurnOptions({ body, projectId, settingsStore: input.settingsStore })
      const validation = validateTurnOptions(options, input.settingsStore)
      if (!validation.ok) return c.json({ error: validation.error }, 400)
      const model = sdkModel(options.model)
      const effort = sdkEffort(options.effort)
      const result = await input.liveTurnManager.startTurn({
        projectId,
        text: body.text,
        userMessageUuid: body.userMessageUuid,
        permissionMode: options.permissionMode,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      })
      input.settingsStore?.setSessionSettings(projectId, result.sessionId, persistedTurnOptions(options))
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
      const options = resolveTurnOptions({ body, projectId, sessionId, settingsStore: input.settingsStore })
      const validation = validateTurnOptions(options, input.settingsStore)
      if (!validation.ok) return c.json({ error: validation.error }, 400)
      const model = sdkModel(options.model)
      const effort = sdkEffort(options.effort)
      const result = await input.liveTurnManager.startTurn({
        projectId,
        sessionId,
        text: body.text,
        userMessageUuid: body.userMessageUuid,
        permissionMode: options.permissionMode,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      })
      input.settingsStore?.setSessionSettings(projectId, result.sessionId, persistedTurnOptions(options))
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

  app.get('/api/projects/:projectId/sessions/:sessionId/info', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const sessionId = c.req.param('sessionId')
      const session = await input.claudeCodeApi.getSessionInfo(projectId, sessionId)
      if (!session) return c.json({ error: 'session_not_found' }, 404)
      const settings = readSettings(input.settingsStore)
      const response: SessionInfoResponse = {
        ...session,
        runState: input.liveTurnManager.sessionRunState(sessionId) ?? defaultRunState(),
        availablePermissionModes: permissionModeSchema.options,
        availableModels: settings.modelCatalog?.models ?? [],
      }
      return c.json(sessionInfoResponseSchema.parse(response))
    } catch (error) {
      console.error('session:info failed', error)
      return c.json({ error: 'session_info_failed' }, 500)
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
      const options = resolveTurnOptions({ projectId, sessionId, settingsStore: input.settingsStore })
      const model = sdkModel(options.model)
      const effort = sdkEffort(options.effort)
      input.liveTurnManager.ensureRuntime({
        projectId,
        sessionId,
        permissionMode: options.permissionMode,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      })
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
      const response: SessionTimelineResponse = {
        ...projectSessionTimeline(c.req.param('sessionId'), messages, {
          limitTurns: parseLimit(c.req.query('limitTurns'), 10, 100),
          cursor: parseCursor(c.req.query('cursor')),
        }),
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
