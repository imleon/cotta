import { rm } from 'node:fs/promises'
import {
  askUserQuestionDecisionRequestSchema,
  COMPOSER_TURN_BODY_MAX_BYTES,
  createTurnRequestSchema,
  deleteSessionRequestSchema,
  deleteSessionResponseSchema,
  forkSessionRequestSchema,
  forkSessionResponseSchema,
  renameSessionRequestSchema,
  renameSessionResponseSchema,
  restartSessionRuntimeResponseSchema,
  sessionContextUsageResponseSchema,
  sessionPinUpdateRequestSchema,
  sessionPinUpdateResponseSchema,
  sessionRuntimeResponseSchema,
  toolApprovalDecisionRequestSchema,
  toolApprovalDecisionResponseSchema,
  turnOptionsUpdateRequestSchema,
} from '@cotta/shared'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { shareAssetsRoot } from '../database.js'
import { ProjectDirectoryUnavailableError, SessionExternallyOwnedError, SessionProjectMismatchError, SessionTurnInProgressError } from '../live-turn-manager.js'
import { SubmitTurnError, submitTurn } from '../submit-turn.js'
import { normalizeModelEffortSelection, persistedTurnOptions, readSettings, resolveTurnOptions, validateTurnOptions } from '../turn-options.js'
import { locateSession, type ProjectRoutesInput, resolveSessionProject, type SessionMetadata } from './project-routes-shared.js'

const createTurnBodyLimit = bodyLimit({ maxSize: COMPOSER_TURN_BODY_MAX_BYTES, onError: (c) => c.json({ error: 'turn_request_too_large' }, 413) })

export function registerProjectSessionRoutes(app: Hono, input: ProjectRoutesInput): void {
  const turnOptionsUpdates = new Map<string, Promise<unknown>>()

  async function notifyTurnOptionsChanged(sessionId: string): Promise<void> {
    try {
      const projectId = locateSession(input, sessionId)?.currentProjectId
      if (projectId) input.indexChangeNotifier?.publishSessionVersion?.(projectId, sessionId, input.timelineVersionReader(projectId, sessionId))
    } catch (error) {
      console.error('session:turn-options notification failed', error)
    }
  }

  function serializeTurnOptionsUpdate<T>(sessionId: string, update: () => Promise<T>): Promise<T> {
    const previous = turnOptionsUpdates.get(sessionId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(update)
    turnOptionsUpdates.set(sessionId, current)
    void current
      .finally(() => {
        if (turnOptionsUpdates.get(sessionId) === current) turnOptionsUpdates.delete(sessionId)
      })
      .catch(() => undefined)
    return current
  }

  function sessionRuntimeExternallyOwned(metadata: SessionMetadata | null | undefined): boolean {
    return metadata !== null && metadata !== undefined
  }

  app.post('/api/projects/:projectId/sessions', createTurnBodyLimit, async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const parsed = createTurnRequestSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return c.json({ error: 'invalid_turn_request' }, 400)
      const body = parsed.data
      if (!body.sessionId) return c.json({ error: 'session_id_required' }, 400)
      return c.json(await submitTurn(input, { projectId, sessionId: body.sessionId, resume: false, text: body.text, images: body.images, userMessageUuid: body.userMessageUuid }), 202)
    } catch (error) {
      if (error instanceof SubmitTurnError) return c.json({ error: error.code }, error.code === 'session_not_found' ? 404 : 400)
      if (error instanceof ProjectDirectoryUnavailableError) return c.json({ error: 'project_directory_unavailable' }, 409)
      if (error instanceof SessionProjectMismatchError) return c.json({ error: 'session_project_mismatch' }, 409)
      if (error instanceof SessionExternallyOwnedError) return c.json({ error: 'session_externally_owned' }, 409)
      if (error instanceof SessionTurnInProgressError) return c.json({ error: 'session_turn_in_progress' }, 409)
      console.error('sessions:create failed', error)
      return c.json({ error: 'session_create_failed' }, 500)
    }
  })

  app.post('/api/sessions/:sessionId/turns', createTurnBodyLimit, async (c) => {
    try {
      const sessionId = c.req.param('sessionId')
      const parsed = createTurnRequestSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return c.json({ error: 'invalid_turn_request' }, 400)
      const body = parsed.data
      if (body.sessionId && body.sessionId !== sessionId) return c.json({ error: 'session_id_mismatch' }, 400)
      return c.json(await submitTurn(input, { projectId: '', sessionId, resume: true, text: body.text, images: body.images, userMessageUuid: body.userMessageUuid }), 202)
    } catch (error) {
      if (error instanceof SubmitTurnError) return c.json({ error: error.code }, error.code === 'session_not_found' ? 404 : 400)
      if (error instanceof ProjectDirectoryUnavailableError) return c.json({ error: 'project_directory_unavailable' }, 409)
      if (error instanceof SessionProjectMismatchError) return c.json({ error: 'session_project_mismatch' }, 409)
      if (error instanceof SessionExternallyOwnedError) return c.json({ error: 'session_externally_owned' }, 409)
      if (error instanceof SessionTurnInProgressError) return c.json({ error: 'session_turn_in_progress' }, 409)
      console.error('turns:create failed', error)
      return c.json({ error: 'turn_create_failed' }, 500)
    }
  })

  app.put('/api/sessions/:sessionId/pin', async (c) => {
    try {
      if (!input.sessionPinStore) return c.json({ error: 'session_pins_unavailable' }, 503)
      const parsed = sessionPinUpdateRequestSchema.safeParse(await c.req.json())
      if (!parsed.success) return c.json({ error: 'invalid_session_pin_update' }, 400)
      const sessionId = c.req.param('sessionId')
      const session = resolveSessionProject(input, sessionId)
      if (!session?.currentProjectId) return c.json({ error: 'session_not_found' }, 404)
      if (parsed.data.pinned) input.sessionPinStore.pin(session.currentProjectId, sessionId)
      else input.sessionPinStore.unpin(session.currentProjectId, sessionId)
      return c.json(sessionPinUpdateResponseSchema.parse({ ok: true }))
    } catch (error) {
      console.error('session:pin failed', error)
      return c.json({ error: 'session_pin_failed' }, 500)
    }
  })

  app.post('/api/projects/:projectId/sessions/:sessionId/rename', async (c) => {
    const projectId = c.req.param('projectId')
    const sessionId = c.req.param('sessionId')
    let title: string
    try {
      const parsed = renameSessionRequestSchema.safeParse(await c.req.json())
      if (!parsed.success) return c.json({ error: 'invalid_session_title' }, 400)
      title = parsed.data.title
      const renamed = await input.claudeCodeApi.renameSession(projectId, sessionId, title)
      if (!renamed) return c.json({ error: 'session_not_found' }, 404)
    } catch (error) {
      console.error('session:rename failed', sessionId, error)
      return c.json({ error: 'session_rename_failed' }, 500)
    }

    const change = { projectId, sessionId, kind: 'changed' as const }
    try {
      if (input.sessionSearchStore && !input.sessionSearchStore.updateTitle(sessionId, title)) throw new Error('Session is missing from the search index')
    } catch (error) {
      console.error('session:rename search index update failed', sessionId, error)
    }
    try {
      await input.syncTranscriptIndex?.(change)
    } catch (error) {
      console.error('session:rename index sync failed', sessionId, error)
    }
    try {
      input.indexChangeNotifier?.publishChange(change)
    } catch (error) {
      console.error('session:rename notification failed', sessionId, error)
    }
    return c.json(renameSessionResponseSchema.parse({ ok: true }))
  })

  app.post('/api/projects/:projectId/sessions/:sessionId/fork', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const sourceSessionId = c.req.param('sessionId')
      const parsed = forkSessionRequestSchema.safeParse(await c.req.json())
      if (!parsed.success) return c.json({ error: 'invalid_fork_target' }, 400)
      const sessionId = await input.claudeCodeApi.forkSession(projectId, sourceSessionId, parsed.data.upToMessageId)
      if (!sessionId) return c.json({ error: 'session_not_found' }, 404)
      const change = { projectId, sessionId, kind: 'changed' as const }
      await input.syncTranscriptIndex?.(change)
      input.indexChangeNotifier?.publishChange(change)
      return c.json(forkSessionResponseSchema.parse({ projectId, sessionId }), 201)
    } catch (error) {
      console.error('session:fork failed', error)
      return c.json({ error: 'session_fork_failed' }, 500)
    }
  })

  app.post('/api/projects/:projectId/sessions/:sessionId/delete', async (c) => {
    const projectId = c.req.param('projectId')
    const sessionId = c.req.param('sessionId')
    try {
      const parsed = deleteSessionRequestSchema.safeParse(await c.req.json())
      if (!parsed.success || parsed.data.confirmationSessionId !== sessionId) return c.json({ error: 'invalid_session_delete_confirmation' }, 400)
      const locatedSession = locateSession(input, sessionId)
      if (!locatedSession?.currentProjectId) return c.json({ error: 'session_not_found' }, 404)
      if (input.transcriptSyncer) await input.transcriptSyncer(locatedSession.currentProjectId, sessionId, locatedSession.fileSize ?? undefined)
      if (resolveSessionProject(input, sessionId)?.currentProjectId !== projectId) return c.json({ error: 'session_not_found' }, 404)
    } catch (error) {
      console.error('session:delete preflight failed', error)
      return c.json({ error: 'session_delete_failed' }, 500)
    }

    const runState = input.liveTurnManager.sessionRunState(sessionId)
    const turnWasRunning = runState !== null && runState.phase !== 'idle'
    try {
      await input.liveTurnManager.closeForExternalOwner?.(sessionId, 'Session was interrupted because it was deleted.', { rebuildAfterCliIdle: false })
    } catch (error) {
      console.error('session:delete runtime close failed', error)
      return c.json({ error: 'session_delete_runtime_close_failed' }, 500)
    }
    try {
      const deleted = await input.claudeCodeApi.deleteSession(projectId, sessionId)
      if (!deleted) return c.json({ error: turnWasRunning ? 'session_not_found_after_interrupt' : 'session_not_found' }, 404)
      input.liveTurnManager.clearRuntimeTurnProjection(sessionId)
    } catch (error) {
      console.error('session:delete failed', error)
      return c.json({ error: turnWasRunning ? 'session_delete_failed_after_interrupt' : 'session_delete_failed' }, 500)
    }

    // PRD lifecycle: revoke the session's shares and delete their frozen assets before reporting success; cleanup failure must not report success.
    try {
      for (const record of input.shareStore?.deleteBySession(sessionId) ?? []) await rm(shareAssetsRoot(record.token), { recursive: true, force: true })
    } catch (error) {
      console.error('session:delete share cleanup failed', error)
      return c.json({ error: 'session_delete_share_cleanup_failed' }, 500)
    }

    const change = { projectId, sessionId, kind: 'removed' as const }
    try {
      await input.syncTranscriptIndex?.(change)
    } catch (error) {
      console.error('session:delete index sync failed', error)
    }
    try {
      input.indexChangeNotifier?.publishChange(change)
    } catch (error) {
      console.error('session:delete notification failed', error)
    }
    return c.json(deleteSessionResponseSchema.parse({ ok: true }))
  })

  app.get('/api/sessions/:sessionId/context-usage', async (c) => {
    try {
      const sessionId = c.req.param('sessionId')
      if (!resolveSessionProject(input, sessionId)) return c.json({ error: 'session_not_found' }, 404)
      const waitForRefresh = c.req.query('wait') === 'true'
      return c.json(
        sessionContextUsageResponseSchema.parse({
          contextUsage: waitForRefresh
            ? ((await input.liveTurnManager.contextUsage?.(sessionId, true)) ?? input.sessionContextUsageStore?.getContextUsage(sessionId) ?? null)
            : (input.sessionContextUsageStore?.getContextUsage(sessionId) ?? null),
        }),
      )
    } catch (error) {
      console.error('session:context usage failed', error)
      return c.json({ error: 'session_context_usage_failed' }, 500)
    }
  })

  app.put('/api/sessions/:sessionId/turn-options', async (c) => {
    try {
      if (!input.turnOptionsStore) return c.json({ error: 'turn_options_unavailable' }, 503)
      const sessionId = c.req.param('sessionId')
      const parsed = turnOptionsUpdateRequestSchema.safeParse(await c.req.json())
      if (!parsed.success) return c.json({ error: 'invalid_turn_options_update' }, 400)
      const validationError = await serializeTurnOptionsUpdate(sessionId, async () => {
        const settings = readSettings(input.settingsStore)
        const normalized = parsed.data.model === undefined ? parsed.data : { ...parsed.data, ...normalizeModelEffortSelection({ model: parsed.data.model, effort: parsed.data.effort! }, settings) }
        const current = input.turnOptionsStore!.getSessionTurnOptions(sessionId)
        const prePlanPermissionMode =
          normalized.permissionMode === 'plan' ? resolveTurnOptions({ sessionId, settingsStore: input.settingsStore, turnOptionsStore: input.turnOptionsStore }).permissionMode : null
        const candidate = { permissionMode: current?.permissionMode ?? null, model: current?.model ?? null, effort: current?.effort ?? null, ...normalized }
        const candidateOptions = resolveTurnOptions({ sessionId, settingsStore: input.settingsStore, turnOptionsStore: { getSessionTurnOptions: () => candidate } })
        const validation = validateTurnOptions(candidateOptions, input.settingsStore)
        if (!validation.ok) return validation.error
        if (!input.turnOptionsStore!.setSessionTurnOptions(sessionId, normalized, Date.now(), prePlanPermissionMode)) throw new Error('Turn options update was superseded before commit')
        const options = resolveTurnOptions({ sessionId, settingsStore: input.settingsStore, turnOptionsStore: input.turnOptionsStore })
        let projectId: string | undefined
        try {
          projectId = resolveSessionProject(input, sessionId)?.currentProjectId ?? undefined
        } catch (error) {
          console.error('session:turn-options project resolve failed', error)
        }
        try {
          await input.liveTurnManager.syncExistingRuntimeOptions?.({
            ...(projectId ? { projectId } : {}),
            sessionId,
            permissionMode: options.permissionMode,
            model: options.model,
            effort: options.effort,
          })
        } catch (error) {
          console.error('session:turn-options runtime sync failed', error)
        }
        await notifyTurnOptionsChanged(sessionId)
        return null
      })
      if (validationError) return c.json({ error: validationError }, 400)
      return c.json({ ok: true })
    } catch (error) {
      console.error('session:turn-options failed', error)
      return c.json({ error: 'turn_options_failed' }, 500)
    }
  })

  app.post('/api/sessions/:sessionId/restart', async (c) => {
    try {
      const sessionId = c.req.param('sessionId')
      const locatedSession = locateSession(input, sessionId)
      if (!locatedSession?.currentProjectId) return c.json({ error: 'session_not_found' }, 404)
      if (!input.liveTurnManager.restartRuntime || !input.liveTurnManager.hasRuntime) return c.json({ error: 'session_restart_unavailable' }, 503)
      if (!input.liveTurnManager.hasRuntime(sessionId)) return c.json({ error: 'session_runtime_not_found' }, 409)
      if (input.transcriptSyncer) await input.transcriptSyncer(locatedSession.currentProjectId, sessionId, locatedSession.fileSize ?? undefined)
      const session = resolveSessionProject(input, sessionId)
      if (!session?.currentProjectId) return c.json({ error: 'session_not_found' }, 404)
      const metadata = input.sessionMetadataReader?.(sessionId) ?? null
      if (sessionRuntimeExternallyOwned(metadata)) {
        const restarted = await input.liveTurnManager.restartRuntime({ projectId: session.currentProjectId, sessionId, permissionMode: 'default', rebuild: false })
        input.indexChangeNotifier?.publishSessionVersion?.(session.currentProjectId, sessionId, input.timelineVersionReader(session.currentProjectId, sessionId))
        return c.json(restartSessionRuntimeResponseSchema.parse({ ok: true, restarted }))
      }
      const options = resolveTurnOptions({ sessionId, settingsStore: input.settingsStore, turnOptionsStore: input.turnOptionsStore })
      const validation = validateTurnOptions(options, input.settingsStore)
      if (!validation.ok) return c.json({ error: validation.error }, 400)
      const restarted = await input.liveTurnManager.restartRuntime({
        projectId: session.currentProjectId,
        sessionId,
        permissionMode: options.permissionMode,
        ...(options.model ? { model: options.model } : {}),
        effort: options.effort,
        rebuild: true,
      })
      input.indexChangeNotifier?.publishSessionVersion?.(session.currentProjectId, sessionId, input.timelineVersionReader(session.currentProjectId, sessionId))
      return c.json(restartSessionRuntimeResponseSchema.parse({ ok: true, restarted }))
    } catch (error) {
      if (error instanceof ProjectDirectoryUnavailableError) return c.json({ error: 'project_directory_unavailable' }, 409)
      if (error instanceof SessionProjectMismatchError) return c.json({ error: 'session_project_mismatch' }, 409)
      console.error('session:restart failed', error)
      return c.json({ error: 'session_restart_failed' }, 500)
    }
  })

  app.post('/api/sessions/:sessionId/runtime', async (c) => {
    try {
      const sessionId = c.req.param('sessionId')
      const locatedSession = locateSession(input, sessionId)
      if (!locatedSession?.currentProjectId) return c.json({ error: 'session_not_found' }, 404)
      if (input.transcriptSyncer) await input.transcriptSyncer(locatedSession.currentProjectId, sessionId, locatedSession.fileSize ?? undefined)
      const session = resolveSessionProject(input, sessionId)
      if (!session?.currentProjectId) return c.json({ error: 'session_not_found' }, 404)
      const options = resolveTurnOptions({ sessionId, settingsStore: input.settingsStore, turnOptionsStore: input.turnOptionsStore })
      const validation = validateTurnOptions(options, input.settingsStore)
      if (!validation.ok) return c.json({ error: validation.error }, 400)
      const metadata = input.sessionMetadataReader?.(sessionId) ?? null
      let initializationResult: unknown = null
      const externallyOwned = sessionRuntimeExternallyOwned(metadata)
      if (!externallyOwned) {
        const model = options.model
        const effort = options.effort
        initializationResult =
          (await input.liveTurnManager.ensureRuntime({
            projectId: session.currentProjectId,
            sessionId,
            permissionMode: options.permissionMode,
            ...(model ? { model } : {}),
            effort,
          })) ?? null
      }
      const contextUsage = (!externallyOwned ? await input.liveTurnManager.contextUsage?.(sessionId, true) : null) ?? input.sessionContextUsageStore?.getContextUsage(sessionId) ?? null
      return c.json(
        sessionRuntimeResponseSchema.parse({
          ok: true,
          projectId: session.currentProjectId,
          sessionId,
          settings: persistedTurnOptions(options),
          initializationResult,
          contextUsage,
        }),
      )
    } catch (error) {
      if (error instanceof ProjectDirectoryUnavailableError) return c.json({ error: 'project_directory_unavailable' }, 409)
      if (error instanceof SessionProjectMismatchError) return c.json({ error: 'session_project_mismatch' }, 409)
      console.error('session:runtime failed', error)
      return c.json({ error: 'session_runtime_failed' }, 500)
    }
  })

  async function interruptSession(sessionId: string) {
    return { interrupted: await input.liveTurnManager.interrupt(sessionId) }
  }

  app.post('/api/sessions/:sessionId/interrupt', async (c) => {
    try {
      return c.json(await interruptSession(c.req.param('sessionId')))
    } catch (error) {
      console.error('session:interrupt failed', error)
      return c.json({ error: 'session_interrupt_failed' }, 500)
    }
  })

  app.post('/api/sessions/:sessionId/permissions/:requestId', async (c) => {
    try {
      if (!input.liveTurnManager.respondToPermission) return c.json({ error: 'permissions_unavailable' }, 503)
      const parsed = toolApprovalDecisionRequestSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return c.json({ error: 'invalid_permission_decision' }, 400)
      const result = input.liveTurnManager.respondToPermission(c.req.param('sessionId'), c.req.param('requestId'), parsed.data)
      if (!result) return c.json({ error: 'permission_request_not_found' }, 404)
      if (result.status === 'invalid_update') return c.json({ error: 'invalid_permission_update' }, 400)
      return c.json(toolApprovalDecisionResponseSchema.parse({ ok: true }))
    } catch (error) {
      console.error('session:permission failed', error)
      return c.json({ error: 'session_permission_failed' }, 500)
    }
  })

  app.post('/api/sessions/:sessionId/questions/:requestId', async (c) => {
    try {
      if (!input.liveTurnManager.respondToQuestion) return c.json({ error: 'questions_unavailable' }, 503)
      const parsed = askUserQuestionDecisionRequestSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return c.json({ error: 'invalid_question_decision' }, 400)
      const result = input.liveTurnManager.respondToQuestion(c.req.param('sessionId'), c.req.param('requestId'), parsed.data)
      if (!result) return c.json({ error: 'question_request_not_found' }, 404)
      return c.json(toolApprovalDecisionResponseSchema.parse({ ok: true }))
    } catch (error) {
      console.error('session:question failed', error)
      return c.json({ error: 'session_question_failed' }, 500)
    }
  })
}
