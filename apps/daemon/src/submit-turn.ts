import type { ComposerImage, CreateTurnResponse, TurnSubmissionStatusResponse } from '@cotta/shared'
import { SessionExternallyOwnedError } from './live-turn-manager.js'
import { RequestIdConflictError } from './request-ledger.js'
import { locateSession, type ProjectRoutesInput, resolveSessionProject } from './routes/project-routes-shared.js'
import { resolveTurnOptions, validateTurnOptions } from './turn-options.js'

export class SubmitTurnError extends Error {
  constructor(readonly code: 'session_not_found' | 'unsupported_model' | 'unsupported_effort') {
    super(code)
  }
}

type SubmitTurnRequest = { projectId: string; sessionId: string; resume: boolean; text?: string; images?: ComposerImage[]; userMessageUuid: string }

/**
 * Submits a turn exactly once per `userMessageUuid`. A retry of a submission that was already accepted — still running,
 * finished, or only visible in the transcript after its receipt expired — returns the original result marked `replayed`
 * and runs nothing. A concurrent duplicate waits for the first attempt and shares its outcome. A submission that was
 * rejected leaves no receipt, so resending it executes normally.
 */
export async function submitTurn(input: ProjectRoutesInput, request: SubmitTurnRequest): Promise<CreateTurnResponse> {
  const ledger = input.requestLedger
  if (!ledger) return submitTurnUnchecked(input, request)
  return ledger.once('turn', request.userMessageUuid, request.sessionId, async () => {
    const accepted = acceptedSubmission(input, request)
    if (accepted) return { ...accepted, replayed: true as const }
    const result = await submitTurnUnchecked(input, request)
    ledger.record('turn', request.userMessageUuid, result.sessionId, result)
    return result
  })
}

/** The original result of an already accepted submission, or null when the daemon has no evidence it arrived. */
function acceptedSubmission(input: ProjectRoutesInput, request: SubmitTurnRequest): CreateTurnResponse | null {
  const { sessionId, userMessageUuid } = request
  const receipt = input.requestLedger?.receipt<CreateTurnResponse>('turn', userMessageUuid)
  if (receipt) {
    if (receipt.sessionId !== sessionId) throw new RequestIdConflictError('turn')
    return { projectId: receipt.result.projectId, sessionId: receipt.result.sessionId, userMessageUuid: receipt.result.userMessageUuid }
  }
  const runState = input.liveTurnManager.sessionRunState(sessionId)
  const known = runState?.activeUserMessageUuid === userMessageUuid || runState?.lastTurn?.id === userMessageUuid || input.requestLedger?.hasTranscriptTurn(sessionId, userMessageUuid)
  if (!known) return null
  // A brand-new session may not be indexed yet; its creating request names the project.
  const projectId = locateSession(input, sessionId)?.currentProjectId ?? (request.projectId || null)
  return projectId ? { projectId, sessionId, userMessageUuid } : null
}

/** What the daemon knows about one submission, for clients reconciling after a lost acknowledgement. */
export function turnSubmissionStatus(input: ProjectRoutesInput, sessionId: string, userMessageUuid: string): TurnSubmissionStatusResponse {
  const base = { sessionId, userMessageUuid }
  const runState = input.liveTurnManager.sessionRunState(sessionId)
  if (runState?.activeUserMessageUuid === userMessageUuid) return { ...base, status: runState.phase === 'requires_action' ? 'waiting' : 'running' }
  if (runState?.lastTurn?.id === userMessageUuid) return { ...base, status: 'completed', outcome: runState.lastTurn.outcome }
  if (input.requestLedger?.hasTranscriptTurn(sessionId, userMessageUuid)) return { ...base, status: 'completed' }
  const receipt = input.requestLedger?.receipt<CreateTurnResponse>('turn', userMessageUuid)
  if (receipt && receipt.sessionId === sessionId) return { ...base, status: 'accepted' }
  return { ...base, status: 'not_found' }
}

async function submitTurnUnchecked(input: ProjectRoutesInput, request: SubmitTurnRequest): Promise<CreateTurnResponse> {
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
