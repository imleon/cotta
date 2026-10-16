import { approvalDescription, approvalSuggestionLabel, approvalTitle, type ToolApprovalDecisionRequest, type ToolApprovalRequest } from '@cotta/shared'
import { useState } from 'react'

type ApprovalAnswer = (approval: ToolApprovalRequest, decision: ToolApprovalDecisionRequest) => void

export function exitPlanModeApprovalOptions(): Array<{ label: string; decision: ToolApprovalDecisionRequest }> {
  return [{ label: 'Approve', decision: { decision: 'allow' } }]
}

export function approvalFeedbackDecision(value: string): ToolApprovalDecisionRequest | null {
  const message = value.trim()
  return message ? { decision: 'deny', message } : null
}

export function PermissionApprovalCard({ approval, answering = false, onAnswer }: { approval: ToolApprovalRequest; answering?: boolean; onAnswer: ApprovalAnswer }) {
  const [feedback, setFeedback] = useState('')
  const [showFeedback, setShowFeedback] = useState(false)
  const title = approvalTitle(approval)
  const description = approvalDescription(approval, title)
  const exitPlanModeOptions = approval.toolName === 'ExitPlanMode' ? exitPlanModeApprovalOptions() : []

  return (
    <div className="composer-approval" role="alertdialog" aria-labelledby="composer-approval-title">
      <div className="composer-approval-copy">
        <span id="composer-approval-title" className="composer-approval-title">
          {approval.toolName === 'ExitPlanMode' ? 'Approval' : 'Permission'}
        </span>
        <span className="composer-approval-question">{title}</span>
        {description ? <span>{description}</span> : null}
      </div>
      <div className={`composer-approval-actions${approval.toolName === 'ExitPlanMode' ? ' composer-approval-actions-stacked' : ''}`}>
        {approval.toolName === 'ExitPlanMode' ? (
          <>
            {exitPlanModeOptions.map(({ decision, label }, index) => (
              <button className="composer-approval-action-suggestion" type="button" disabled={answering} onClick={() => onAnswer(approval, decision)} key={index}>
                {label}
              </button>
            ))}
            {!showFeedback ? (
              <button className="composer-approval-action-request-changes" type="button" disabled={answering} onClick={() => setShowFeedback(true)}>
                Feedback
              </button>
            ) : null}
          </>
        ) : (
          <>
            {/* Product choice: offer only the SDK's primary suggestion; permission updates are not implicitly combined. */}
            {approval.suggestions?.[0] ? (
              <button className="composer-approval-action-suggestion" type="button" disabled={answering} onClick={() => onAnswer(approval, { decision: 'allow_suggestion' })}>
                {approvalSuggestionLabel(approval.suggestions[0])}
              </button>
            ) : null}
            <button className="composer-approval-action-yes" type="button" disabled={answering} onClick={() => onAnswer(approval, { decision: 'allow' })}>
              Yes
            </button>
            <button className="composer-approval-action-no" type="button" disabled={answering} onClick={() => onAnswer(approval, { decision: 'deny', message: 'Denied by user' })}>
              No
            </button>
          </>
        )}
      </div>
      {approval.toolName === 'ExitPlanMode' && showFeedback ? (
        <form
          className="composer-approval-feedback"
          onSubmit={(event) => {
            event.preventDefault()
            const decision = approvalFeedbackDecision(feedback)
            if (decision && !answering) onAnswer(approval, decision)
          }}
        >
          <input
            type="text"
            aria-label="Tell Claude what to change"
            placeholder="Tell Claude what to change"
            value={feedback}
            disabled={answering}
            onChange={(event) => setFeedback(event.target.value)}
          />
          <button type="submit" aria-label="Submit feedback" title="Submit feedback" disabled={answering || !approvalFeedbackDecision(feedback)}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M14 5v3.5a3 3 0 0 1-3 3H6" />
              <path d="m9 8.5-3 3 3 3" />
            </svg>
          </button>
        </form>
      ) : null}
    </div>
  )
}
