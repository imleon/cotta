import { type SessionRunState, sessionTimelineResponseSchema } from '@cotta/shared'
import { describe, expect, it, vi } from 'vitest'
import { readProjectSessions, readProjectTimeline } from './project-read-model.js'
import type { ProjectRoutesInput } from './routes/project-routes-shared.js'
import { memoryRawTranscriptCache, memoryTranscriptIndex, messages, project, sessions, timelineState } from './routes/project-routes-test-helpers.js'

function input(overrides: Partial<ProjectRoutesInput> = {}): ProjectRoutesInput {
  return {
    claudeCodeApi: {
      listProjectSessions: async (projectId) => (projectId === project.id ? { project, sessions, defaultSessionId: sessions[0]?.id ?? null, hasMore: false, nextCursor: null } : null),
    } as ProjectRoutesInput['claudeCodeApi'],
    transcriptIndex: memoryTranscriptIndex(),
    transcriptSyncer: async () => {},
    rawTranscriptCache: memoryRawTranscriptCache(messages),
    timelineVersionReader: () => timelineState.version,
    modelCatalogProvider: {} as ProjectRoutesInput['modelCatalogProvider'],
    liveTurnManager: {
      ensureRuntime: () => {},
      sessionRunState: () => null,
      runtimeTurnProjection: () => null,
      clearRuntimeTurnProjection: () => {},
      startTurn: async () => {
        throw new Error('not implemented')
      },
      acknowledgeCompletedTurn: () => false,
      interrupt: async () => false,
      subscribe: () => () => {},
    },
    ...overrides,
  }
}

describe('project read model', () => {
  it('reuses the live overlay for project sessions', async () => {
    const result = await readProjectSessions(
      input({
        liveTurnManager: {
          ...input().liveTurnManager,
          sessionRunState: (sessionId) => (sessionId === 'session-newest' ? { phase: 'running', activeUserMessageUuid: 'user-1', lastTurn: null } : null),
        },
      }),
      { projectId: project.id, limit: 10, cursor: null },
    )

    expect(result.sessions[0]).toMatchObject({ id: 'session-newest', occupiedBy: 'cotta', occupiedStatus: 'busy' })
  })

  it.each([
    { scope: 'control' as const, waitContext: false },
    { scope: 'control' as const, waitContext: true },
    { scope: undefined, waitContext: false },
    { scope: undefined, waitContext: true },
  ])('reads AUQ control state and version together after metadata resolves ($scope, waitContext=$waitContext)', async ({ scope, waitContext }) => {
    let releaseMetadata!: () => void
    let metadataStarted!: () => void
    const metadataReady = new Promise<void>((resolve) => {
      releaseMetadata = resolve
    })
    const started = new Promise<void>((resolve) => {
      metadataStarted = resolve
    })
    let runState: SessionRunState = { phase: 'running', activeUserMessageUuid: 'user-2', lastTurn: null }
    let version = 'before-auq'
    const pendingPermission = { requestId: 'req-2', toolUseID: 'tool-2', toolName: 'AskUserQuestion', input: { questions: [] } }
    const readInput = input({
      timelineMetadataReader: async () => {
        metadataStarted()
        await metadataReady
        return { turnMetadata: new Map(), turnOptions: { permissionMode: null, model: null, effort: null } }
      },
      timelineVersionReader: () => version,
      liveTurnManager: {
        ...input().liveTurnManager,
        sessionRunState: () => runState,
        contextUsage: async () => null,
      },
    })
    const reading = readProjectTimeline(readInput, {
      projectId: project.id,
      sessionId: 'session-newest',
      scope,
      limitTurns: 1,
      cursor: null,
      fromTurnId: null,
      anchorTurnId: null,
      pendingSubmissionUuid: null,
      waitContext,
      acknowledgeCompletedTurn: false,
    })
    await started
    runState = { phase: 'requires_action', activeUserMessageUuid: 'user-2', lastTurn: null, pendingPermission }
    version = 'after-auq'
    releaseMetadata()

    const result = await reading
    expect(result.state.version).toBe('after-auq')
    expect(result.runState).toEqual(runState)
    expect(result.pendingPermission).toEqual(pendingPermission)
    expect(result.activity).toEqual({ owner: 'cotta', phase: 'waiting', activeTurnId: 'user-2' })
  })

  it('validates project ownership and can read the full timeline without acknowledging completion', async () => {
    const transcriptSyncer = vi.fn()
    const acknowledgeCompletedTurn = vi.fn(() => true)
    const readInput = input({
      transcriptSyncer,
      timelineMetadataReader: async () => ({
        turnMetadata: new Map([['user-2', { durationMs: 42 }]]),
        turnOptions: { permissionMode: 'plan', model: null, effort: null },
      }),
      liveTurnManager: {
        ...input().liveTurnManager,
        sessionRunState: () => ({ phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'user-2', outcome: 'success' } }),
        runtimeTurnProjection: () => ({ submissionUuid: 'user-2', kind: 'visible', visibleTurnUuid: 'user-2' }),
        acknowledgeCompletedTurn,
      },
    })
    const options = {
      sessionId: 'session-newest',
      limitTurns: 1,
      cursor: null,
      fromTurnId: null,
      anchorTurnId: null,
      pendingSubmissionUuid: null,
      waitContext: false,
      acknowledgeCompletedTurn: false,
    }

    await expect(readProjectTimeline(readInput, { ...options, projectId: 'wrong-project' })).rejects.toMatchObject({ code: 'session_not_found' })
    expect(transcriptSyncer).not.toHaveBeenCalled()

    const result = sessionTimelineResponseSchema.parse(await readProjectTimeline(readInput, { ...options, projectId: project.id }))
    expect(transcriptSyncer).toHaveBeenCalledWith(project.id, 'session-newest', timelineState.fileSize)
    expect(result.turns[0]).toMatchObject({ primaryUserUuid: 'user-2', durationMs: 42 })
    expect(result.turnOptions.permissionMode).toBe('plan')
    expect(result.runtimeTurnProjection).toEqual({ submissionUuid: 'user-2', kind: 'visible', visibleTurnUuid: 'user-2' })
    expect(acknowledgeCompletedTurn).not.toHaveBeenCalled()
  })
})
