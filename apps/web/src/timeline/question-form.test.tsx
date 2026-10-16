// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TimelineQuestionFormContent } from './content'
import { AskUserQuestionToolContent } from './tools'

const question = (overrides: Record<string, unknown> = {}) => ({
  header: 'Choice',
  question: 'Pick one?',
  options: [{ label: 'A' }, { label: 'B' }],
  ...overrides,
})

describe('TimelineQuestionFormContent interactions', () => {
  afterEach(cleanup)
  it('selects and submits one answer', async () => {
    const onSubmit = vi.fn()
    render(<TimelineQuestionFormContent questions={[question()]} enabled onSubmit={onSubmit} />)

    await userEvent.click(screen.getByRole('radio', { name: 'A' }))
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onSubmit).toHaveBeenCalledWith({ 'Pick one?': 'A' }, {})
  })

  it('selects and submits multiple answers', async () => {
    const onSubmit = vi.fn()
    render(<TimelineQuestionFormContent questions={[question({ multiSelect: true })]} enabled onSubmit={onSubmit} />)

    await userEvent.click(screen.getByRole('checkbox', { name: 'A' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'B' }))
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onSubmit).toHaveBeenCalledWith({ 'Pick one?': 'A, B' }, {})
  })

  it('requires and submits an automatic Other answer without colliding with a real Other option', async () => {
    const onSubmit = vi.fn()
    render(<TimelineQuestionFormContent questions={[question({ options: [{ label: 'Other', description: 'Real option' }] })]} enabled onSubmit={onSubmit} />)
    await userEvent.click(screen.getByRole('radio', { name: 'Other' }))
    expect(screen.getByRole('button', { name: 'Submit' })).toHaveProperty('disabled', true)
    await userEvent.type(screen.getByRole('textbox', { name: 'Other answer for Pick one?' }), 'Something else')
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onSubmit).toHaveBeenCalledWith({ 'Pick one?': 'Something else' }, {})
  })

  it('clears Other text when Other is deselected or replaced', async () => {
    const onSubmit = vi.fn()
    const { unmount } = render(<TimelineQuestionFormContent questions={[question({ multiSelect: true })]} enabled onSubmit={onSubmit} />)

    await userEvent.click(screen.getByRole('checkbox', { name: /^Other/ }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Other answer for Pick one?' }), 'stale')
    await userEvent.click(screen.getByRole('checkbox', { name: /^Other/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'A' }))
    await userEvent.click(screen.getByRole('checkbox', { name: /^Other/ }))
    expect((screen.getByRole('textbox', { name: 'Other answer for Pick one?' }) as HTMLInputElement).value).toBe('')

    unmount()
    render(<TimelineQuestionFormContent questions={[question()]} enabled onSubmit={onSubmit} />)
    await userEvent.click(screen.getByRole('radio', { name: 'Other' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Other answer for Pick one?' }), 'replace me')
    await userEvent.click(screen.getByRole('radio', { name: 'A' }))
    await userEvent.click(screen.getByRole('radio', { name: /^Other/ }))
    expect((screen.getByRole('textbox', { name: 'Other answer for Pick one?' }) as HTMLInputElement).value).toBe('')
  })

  it('submits preview selection with notes and no Other choice', async () => {
    const onSubmit = vi.fn()
    render(<TimelineQuestionFormContent questions={[question({ options: [{ label: 'Compact', preview: '# Compact' }] })]} enabled onSubmit={onSubmit} />)

    expect(screen.queryByRole('radio', { name: 'Other' })).toBeNull()
    await userEvent.click(screen.getByRole('radio', { name: /Compact/ }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Notes for Pick one?' }), 'Use blue')
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onSubmit).toHaveBeenCalledWith({ 'Pick one?': 'Compact' }, { 'Pick one?': { preview: '# Compact', notes: 'Use blue' } })
  })

  it('keeps preview mode exclusive to single-select questions', () => {
    render(<TimelineQuestionFormContent questions={[question({ multiSelect: true, options: [{ label: 'Compact', preview: '# Compact' }] })]} enabled />)

    expect(screen.getByRole('checkbox', { name: /^Other/ })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Notes for Pick one?' })).toBeNull()
  })

  it('propagates the exact request and tool-use identities and resets for a new request', async () => {
    const onAnswerQuestion = vi.fn()
    const request = { requestId: 'request-1', toolUseID: 'tool-1', toolName: 'AskUserQuestion', input: { questions: [question()] } }
    const { rerender } = render(
      <AskUserQuestionToolContent input={{ questions: [question({ options: [{ label: 'Wrong' }] })] }} results={[]} questionRequest={request} onAnswerQuestion={onAnswerQuestion} />,
    )

    expect(screen.queryByRole('radio', { name: 'Wrong' })).toBeNull()
    await userEvent.click(screen.getByRole('radio', { name: 'A' }))
    rerender(
      <AskUserQuestionToolContent input={{ questions: [question()] }} results={[]} questionRequest={{ ...request, requestId: 'request-2', toolUseID: 'tool-2' }} onAnswerQuestion={onAnswerQuestion} />,
    )
    expect((screen.getByRole('radio', { name: 'A' }) as HTMLInputElement).checked).toBe(false)
    await userEvent.click(screen.getByRole('radio', { name: 'B' }))
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onAnswerQuestion).toHaveBeenCalledWith('request-2', { behavior: 'completed', toolUseID: 'tool-2', answers: { 'Pick one?': 'B' } })
  })

  it('keeps history and non-matching requests disabled', async () => {
    const onSubmit = vi.fn()
    const { rerender } = render(<TimelineQuestionFormContent questions={[question()]} onSubmit={onSubmit} />)

    expect(screen.getByRole('radio', { name: 'A' }).closest('fieldset')).toHaveProperty('disabled', true)
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull()
    rerender(<TimelineQuestionFormContent questions={[question()]} enabled={false} onSubmit={onSubmit} />)
    await userEvent.click(screen.getByRole('radio', { name: 'A' }))
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
