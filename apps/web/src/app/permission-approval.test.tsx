// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { approvalFeedbackDecision, exitPlanModeApprovalOptions, PermissionApprovalCard } from './permission-approval'

const normalApproval = {
  requestId: 'request',
  toolUseID: 'tool',
  toolName: 'Bash',
  input: { command: 'npm test' },
  suggestions: [{ type: 'setMode' as const, mode: 'acceptEdits' as const, destination: 'session' as const }],
}

const exitPlanModeApproval = {
  requestId: 'request',
  toolUseID: 'tool',
  toolName: 'ExitPlanMode',
  input: {},
}

afterEach(cleanup)

describe('PermissionApprovalCard interactions', () => {
  it.each([
    ['Yes, and switch to accept edits for this session', { decision: 'allow_suggestion' }],
    ['Yes', { decision: 'allow' }],
    ['No', { decision: 'deny', message: 'Denied by user' }],
  ])('submits the exact normal approval decision for %s', async (name, decision) => {
    const onAnswer = vi.fn()
    render(<PermissionApprovalCard approval={normalApproval} onAnswer={onAnswer} />)

    await userEvent.click(screen.getByRole('button', { name }))

    expect(onAnswer).toHaveBeenCalledWith(normalApproval, decision)
  })

  it.each([['Approve', { decision: 'allow' }]])('submits the exact ExitPlanMode decision for %s', async (name, decision) => {
    const onAnswer = vi.fn()
    render(<PermissionApprovalCard approval={exitPlanModeApproval} onAnswer={onAnswer} />)

    await userEvent.click(screen.getByRole('button', { name }))

    expect(onAnswer).toHaveBeenCalledWith(exitPlanModeApproval, decision)
  })

  it('keeps blank ExitPlanMode feedback disabled and submits trimmed feedback', async () => {
    const onAnswer = vi.fn()
    render(<PermissionApprovalCard approval={exitPlanModeApproval} onAnswer={onAnswer} />)
    expect(screen.queryByRole('textbox', { name: 'Tell Claude what to change' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Feedback' }))
    const submit = screen.getByRole('button', { name: 'Submit feedback' })

    expect(submit).toHaveProperty('disabled', true)
    await userEvent.type(screen.getByRole('textbox', { name: 'Tell Claude what to change' }), '  revise the tests  ')
    expect(submit).toHaveProperty('disabled', false)
    await userEvent.click(submit)

    expect(onAnswer).toHaveBeenCalledWith(exitPlanModeApproval, { decision: 'deny', message: 'revise the tests' })
  })
})

describe('ExitPlanMode approval options', () => {
  it('offers the restore decision', () => {
    expect(exitPlanModeApprovalOptions()).toEqual([{ label: 'Approve', decision: { decision: 'allow' } }])
  })

  it('trims feedback into a deny decision and rejects blank feedback', () => {
    expect(approvalFeedbackDecision('  revise the tests  ')).toEqual({ decision: 'deny', message: 'revise the tests' })
    expect(approvalFeedbackDecision('   ')).toBeNull()
  })

  it('does not render bare approval choices for ExitPlanMode', () => {
    const html = renderToStaticMarkup(
      createElement(PermissionApprovalCard, {
        approval: {
          requestId: 'request',
          toolUseID: 'tool',
          toolName: 'ExitPlanMode',
          input: {},
          suggestions: [{ type: 'setMode', mode: 'default', destination: 'session' }],
        },
        onAnswer: () => undefined,
      }),
    )

    expect(html).toContain('>Approval</span>')
    expect(html).toContain('Claude has written up a plan and is ready to execute. Would you like to proceed?')
    expect(html).toContain('Approve')
    expect(html).toContain('Feedback')
    expect(html).not.toContain('Tell Claude what to change')
    expect(html).not.toContain('>Yes</button>')
    expect(html).not.toContain('>No</button>')
  })
})
