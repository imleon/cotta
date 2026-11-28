import type { AskUserQuestionDecisionRequest, ToolApprovalDecisionRequest } from '@cotta/shared'
import { canonicalJson } from './request-ledger.js'
import type { ProjectRoutesInput } from './routes/project-routes-shared.js'

/**
 * Outcome of answering a pending permission or question:
 * - `answered`: applied now.
 * - `already_answered`: a retry of an answer already applied with the same decision; nothing re-applied.
 * - `conflict`: this request was already answered with a different decision, which stays in effect.
 * - `invalid_update`: the decision cannot apply to this request (permissions only).
 * - `not_found`: no such pending request and no record of answering it (never existed, expired or runtime gone).
 */
export type AnswerOutcome<T> = { status: 'answered' } | { status: 'already_answered' } | { status: 'conflict'; decision: T } | { status: 'invalid_update' } | { status: 'not_found' }

type AnswerReceipt<T> = { decision: T }

function answerKey(sessionId: string, requestId: string): string {
  return `${sessionId}\0${requestId}`
}

function priorAnswer<T>(input: ProjectRoutesInput, kind: 'permission' | 'question', sessionId: string, requestId: string, decision: T): AnswerOutcome<T> {
  const receipt = input.requestLedger?.receipt<AnswerReceipt<T>>(kind, answerKey(sessionId, requestId))
  if (!receipt || receipt.sessionId !== sessionId) return { status: 'not_found' }
  return canonicalJson(receipt.result.decision) === canonicalJson(decision) ? { status: 'already_answered' } : { status: 'conflict', decision: receipt.result.decision }
}

export function answerPermission(input: ProjectRoutesInput, sessionId: string, requestId: string, decision: ToolApprovalDecisionRequest): AnswerOutcome<ToolApprovalDecisionRequest> | null {
  const respond = input.liveTurnManager.respondToPermission
  if (!respond) return null
  const result = respond.call(input.liveTurnManager, sessionId, requestId, decision)
  if (result?.status === 'answered') {
    input.requestLedger?.record('permission', answerKey(sessionId, requestId), sessionId, { decision })
    return result
  }
  if (result?.status === 'invalid_update') return result
  return priorAnswer(input, 'permission', sessionId, requestId, decision)
}

export function answerQuestion(input: ProjectRoutesInput, sessionId: string, requestId: string, decision: AskUserQuestionDecisionRequest): AnswerOutcome<AskUserQuestionDecisionRequest> | null {
  const respond = input.liveTurnManager.respondToQuestion
  if (!respond) return null
  const result = respond.call(input.liveTurnManager, sessionId, requestId, decision)
  if (result?.status === 'answered') {
    input.requestLedger?.record('question', answerKey(sessionId, requestId), sessionId, { decision })
    return result
  }
  return priorAnswer(input, 'question', sessionId, requestId, decision)
}
