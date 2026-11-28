import type { ComposerImage, CreateTurnResponse } from '@cotta/shared'
import { SessionExternallyOwnedError } from './live-turn-manager.js'
import { locateSession, type ProjectRoutesInput, resolveSessionProject } from './routes/project-routes-shared.js'
import { resolveTurnOptions, validateTurnOptions } from './turn-options.js'

export class SubmitTurnError extends Error {
  constructor(readonly code: 'session_not_found' | 'unsupported_model' | 'unsupported_effort') {
    super(code)
  }
}

export async function submitTurn(
  input: ProjectRoutesInput,
  request: { projectId: string; sessionId: string; resume: boolean; text?: string; images?: ComposerImage[]; userMessageUuid: string },
): Promise<CreateTurnResponse> {
  let projectId = request.projectId
  if (request.resume) {
    const located = locateSession(input, request.sessionId)
    if (!located?.currentProjectId) throw new SubmitTurnError('session_not_found')
    await input.transcriptSyncer?.(located.currentProjectId, request.sessionId, located.fileSize ?? undefined)
    const session = resolveSessionProject(input, request.sessionId)
    if (!session?.currentProjectId) throw new SubmitTurnError('session_not_found')
    projectId = session.currentProjectId
  }

  if (input.sessionMetadataReader?.(request.sessionId) != null) throw new SessionExternallyOwnedError('Session is externally owned')
  const options = resolveTurnOptions({ sessionId: request.sessionId, settingsStore: input.settingsStore, turnOptionsStore: input.turnOptionsStore })
  const validation = validateTurnOptions(options, input.settingsStore)
  if (!validation.ok) throw new SubmitTurnError(validation.error)
  const result = await input.liveTurnManager.startTurn({
    projectId,
    sessionId: request.sessionId,
    resume: request.resume,
    text: request.text,
    images: request.images,
    userMessageUuid: request.userMessageUuid,
    permissionMode: options.permissionMode,
    model: options.model,
    effort: options.effort,
  })
  return { projectId, sessionId: result.sessionId, userMessageUuid: result.userMessageUuid }
}
