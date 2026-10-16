import { sessionTimelineResponseSchema } from '@cotta/shared'
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
