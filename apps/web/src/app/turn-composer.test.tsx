// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type ComponentProps, type ReactNode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveTurnOptions } from '../api'
import { UNKNOWN_SUBMISSION_RECOVERY_MS } from './composer-core'
import { type PendingSubmission, TurnComposer } from './turn-composer'

vi.mock('../api', () => ({ refreshProjects: vi.fn(), saveTurnOptions: vi.fn() }))

function renderComposer(ui: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('TurnComposer session selection', () => {
  it('opens Session info, copies it, and uploads an image from Add', async () => {
    let finishDecode!: () => void
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { clipboard: { writeText } }))
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => new Promise<ImageBitmap>((resolve) => (finishDecode = () => resolve({ close: vi.fn() } as unknown as ImageBitmap)))),
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ projectId: 'project-1', sessionId: 'session-1', userMessageUuid: 'message-1' }), { status: 202 })))
    renderComposer(
      <TurnComposer
        projectId="project-1"
        selectedSessionId="session-1"
        selectedSession={{ id: 'session-1', projectId: 'project-1', title: 'Session', occupiedBy: null, occupiedStatus: 'idle', kind: null }}
        activity={null}
        liveSessionId="session-1"
        liveUserMessageUuid={null}
        latestTurnPhase={null}
        pendingTurnId={null}
        setSelectedSessionId={vi.fn()}
        setPendingTurn={vi.fn()}
        refreshSessionLists={vi.fn()}
        onSessionCreated={vi.fn()}
        settings={{ timeZone: 'Asia/Shanghai', defaultModel: null, defaultEffort: 'medium', useOneMillionContext: true, autoCompactPercent: undefined }}
        sessionRuntime={{
          ok: true,
          projectId: 'project-1',
          sessionId: 'session-1',
          settings: { permissionMode: 'default', model: null, effort: null },
          initializationResult: { model: 'claude-test' },
          contextUsage: null,
        }}
        projectDirectoryUnavailable={false}
        turnOptions={null}
        externalPermissionMode={null}
        contextUsage={null}
        onNotify={vi.fn()}
      />,
    )
    const file = new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'image.png', { type: 'image/png' })
    const add = screen.getByRole('button', { name: 'Add' })
    await userEvent.click(add)
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Upload images' }))
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Session info' }))
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('dialog', { name: 'Session info' }).textContent).toContain('claude-test')
    let finishCopy!: () => void
    writeText.mockImplementationOnce(() => new Promise<void>((resolve) => (finishCopy = resolve)))
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('claude-test'))
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    finishCopy()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull())
    expect(document.activeElement).toBe(add)
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { clipboard: undefined }))
    await userEvent.click(add)
    await userEvent.click(screen.getByRole('menuitem', { name: 'Session info' }))
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(screen.getByRole('button', { name: 'Failed' })).toBeTruthy()
    fireEvent.click(screen.getByRole('dialog', { name: 'Session info' }))
    expect(document.activeElement).toBe(add)
    await userEvent.click(add)
    const input = screen.getByLabelText('Add image files') as HTMLInputElement
    const click = vi.spyOn(input, 'click')
    await userEvent.click(screen.getByRole('menuitem', { name: 'Upload images' }))
    expect(click).toHaveBeenCalledOnce()
    fireEvent.change(input, { target: { files: [file] } })
    expect(screen.getByPlaceholderText('Describe a task or ask a question').hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Submit' }).hasAttribute('disabled')).toBe(true)

    finishDecode()
    await screen.findByRole('img', { name: 'Attachment 1' })
    expect(screen.getByRole('button', { name: 'Submit' }).hasAttribute('disabled')).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))
    const request = vi.mocked(fetch).mock.calls[0]?.[1]
    expect(JSON.parse(String(request?.body))).toMatchObject({ images: [{ mediaType: 'image/png' }] })
    expect(JSON.parse(String(request?.body))).not.toHaveProperty('text')
  })

  it('rejects an oversized image batch before decoding', () => {
    const decode = vi.fn()
    const onNotify = vi.fn()
    vi.stubGlobal('createImageBitmap', decode)
    renderComposer(
      <TurnComposer
        projectId="project-1"
        selectedSessionId="session-1"
        selectedSession={{ id: 'session-1', projectId: 'project-1', title: 'Session', occupiedBy: null, occupiedStatus: 'idle', kind: null }}
        activity={null}
        liveSessionId="session-1"
        liveUserMessageUuid={null}
        latestTurnPhase={null}
        pendingTurnId={null}
        setSelectedSessionId={vi.fn()}
        setPendingTurn={vi.fn()}
        refreshSessionLists={vi.fn()}
        onSessionCreated={vi.fn()}
        settings={{ timeZone: 'Asia/Shanghai', defaultModel: null, defaultEffort: 'medium', useOneMillionContext: true, autoCompactPercent: undefined }}
        sessionRuntime={null}
        projectDirectoryUnavailable={false}
        turnOptions={null}
        externalPermissionMode={null}
        contextUsage={null}
        onNotify={onNotify}
      />,
    )
    const files = Array.from({ length: 11 }, (_, index) => new File(['x'], `${index}.png`, { type: 'image/png' }))
    fireEvent.change(screen.getByLabelText('Add image files'), { target: { files } })
    expect(decode).not.toHaveBeenCalled()
    expect(onNotify).toHaveBeenCalledWith({ message: 'You can import up to 10 images at once.', tone: 'error' })
  })

  it('rejects the whole batch when one image cannot be decoded', async () => {
    const onNotify = vi.fn()
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn((file: File) => (file.name === 'bad.png' ? Promise.reject(new Error('bad')) : Promise.resolve({ close: vi.fn() } as unknown as ImageBitmap))),
    )
    renderComposer(
      <TurnComposer
        projectId="project-1"
        selectedSessionId="session-1"
        selectedSession={{ id: 'session-1', projectId: 'project-1', title: 'Session', occupiedBy: null, occupiedStatus: 'idle', kind: null }}
        activity={null}
        liveSessionId="session-1"
        liveUserMessageUuid={null}
        latestTurnPhase={null}
        pendingTurnId={null}
        setSelectedSessionId={vi.fn()}
        setPendingTurn={vi.fn()}
        refreshSessionLists={vi.fn()}
        onSessionCreated={vi.fn()}
        settings={{ timeZone: 'Asia/Shanghai', defaultModel: null, defaultEffort: 'medium', useOneMillionContext: true, autoCompactPercent: undefined }}
        sessionRuntime={null}
        projectDirectoryUnavailable={false}
        turnOptions={null}
        externalPermissionMode={null}
        contextUsage={null}
        onNotify={onNotify}
      />,
    )
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    fireEvent.change(screen.getByLabelText('Add image files'), { target: { files: [new File([png], 'good.png', { type: 'image/png' }), new File([png], 'bad.png', { type: 'image/png' })] } })
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith({ message: 'bad.png: Browser could not decode an image.', tone: 'error' }))
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('keeps input editable but disables project-dependent controls without a project', async () => {
    const props: ComponentProps<typeof TurnComposer> = {
      projectId: null,
      selectedSessionId: null,
      selectedSession: null,
      activity: null,
      liveSessionId: null,
      liveUserMessageUuid: null,
      latestTurnPhase: null,
      pendingTurnId: null,
      setSelectedSessionId: vi.fn(),
      setPendingTurn: vi.fn(),
      refreshSessionLists: vi.fn(),
      onSessionCreated: vi.fn(),
      settings: { timeZone: 'Asia/Shanghai', defaultPermissionMode: 'plan', defaultModel: 'claude-test', defaultEffort: 'high', useOneMillionContext: true, autoCompactPercent: undefined },
      sessionRuntime: null,
      projectDirectoryUnavailable: false,
      turnOptions: null,
      externalPermissionMode: null,
      contextUsage: null,
      onNotify: vi.fn(),
    }

    renderComposer(<TurnComposer {...props} />)
    const input = screen.getByPlaceholderText('Select a project, describe a task or ask a question')
    expect(input.hasAttribute('disabled')).toBe(false)
    await userEvent.type(input, 'draft')
    expect((input as HTMLTextAreaElement).value).toBe('draft')
    expect(screen.getByRole('button', { name: 'Submit' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Model claude-test' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Permission mode: Plan' }).hasAttribute('disabled')).toBe(true)
  })

  it('reports slash commands with images as a toast', async () => {
    const onNotify = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close: vi.fn() } as unknown as ImageBitmap))
    vi.stubGlobal('fetch', vi.fn())
    renderComposer(
      <TurnComposer
        projectId="project-1"
        selectedSessionId="session-1"
        selectedSession={{ id: 'session-1', projectId: 'project-1', title: 'Session', occupiedBy: null, occupiedStatus: 'idle', kind: null }}
        activity={null}
        liveSessionId="session-1"
        liveUserMessageUuid={null}
        latestTurnPhase={null}
        pendingTurnId={null}
        setSelectedSessionId={vi.fn()}
        setPendingTurn={vi.fn()}
        refreshSessionLists={vi.fn()}
        onSessionCreated={vi.fn()}
        settings={{ timeZone: 'Asia/Shanghai', defaultModel: null, defaultEffort: 'medium', useOneMillionContext: true, autoCompactPercent: undefined }}
        sessionRuntime={null}
        projectDirectoryUnavailable={false}
        turnOptions={null}
        externalPermissionMode={null}
        contextUsage={null}
        onNotify={onNotify}
      />,
    )
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    fireEvent.change(screen.getByLabelText('Add image files'), { target: { files: [new File([png], 'image.png', { type: 'image/png' })] } })
    await screen.findByRole('img', { name: 'Attachment 1' })
    await userEvent.type(screen.getByPlaceholderText('Describe a task or ask a question'), '/compact')
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onNotify).toHaveBeenCalledWith({ message: 'Slash commands do not support images.', tone: 'error' })
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.queryByText('Slash commands do not support images.')).toBeNull()
  })

  it('creates a render-only pending submission for slash-looking input', async () => {
    const setPendingTurn = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ projectId: 'project-1', sessionId: 'session-1', userMessageUuid: 'message-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        ),
    )
    renderComposer(
      <TurnComposer
        projectId="project-1"
        selectedSessionId="session-1"
        selectedSession={{ id: 'session-1', projectId: 'project-1', title: 'Session', occupiedBy: null, occupiedStatus: 'idle', kind: null }}
        activity={null}
        liveSessionId="session-1"
        liveUserMessageUuid={null}
        latestTurnPhase={null}
        pendingTurnId={null}
        setSelectedSessionId={vi.fn()}
        setPendingTurn={setPendingTurn}
        refreshSessionLists={vi.fn()}
        onSessionCreated={vi.fn()}
        settings={{ timeZone: 'Asia/Shanghai', defaultModel: null, defaultEffort: 'medium', useOneMillionContext: true, autoCompactPercent: undefined }}
        sessionRuntime={null}
        projectDirectoryUnavailable={false}
        turnOptions={null}
        externalPermissionMode={null}
        contextUsage={null}
        onNotify={vi.fn()}
      />,
    )

    await userEvent.type(screen.getByPlaceholderText('Describe a task or ask a question'), '/model opus')
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))

    const submission = setPendingTurn.mock.calls[0]?.[0]
    expect(submission).toMatchObject({ kind: 'slash', text: '/model opus', phase: 'submitting' })
    expect(submission).not.toHaveProperty('turn')
  })

  it('runs the pre-submit navigation before creating a turn', async () => {
    const onBeforeSubmit = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ projectId: 'project-1', sessionId: 'session-1', userMessageUuid: 'message-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    renderComposer(
      <TurnComposer
        projectId="project-1"
        selectedSessionId="session-1"
        selectedSession={{ id: 'session-1', projectId: 'project-1', title: 'Session', occupiedBy: null, occupiedStatus: 'idle', kind: null }}
        activity={null}
        liveSessionId="session-1"
        liveUserMessageUuid={null}
        latestTurnPhase={null}
        pendingTurnId={null}
        setSelectedSessionId={vi.fn()}
        setPendingTurn={vi.fn()}
        refreshSessionLists={vi.fn()}
        onSessionCreated={vi.fn()}
        settings={{ timeZone: 'Asia/Shanghai', defaultModel: null, defaultEffort: 'medium', useOneMillionContext: true, autoCompactPercent: undefined }}
        sessionRuntime={null}
        projectDirectoryUnavailable={false}
        turnOptions={null}
        externalPermissionMode={null}
        contextUsage={null}
        onBeforeSubmit={onBeforeSubmit}
        onNotify={vi.fn()}
      />,
    )

    await userEvent.type(screen.getByPlaceholderText('Describe a task or ask a question'), 'hello')
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onBeforeSubmit).toHaveBeenCalledOnce()
  })

  it('shows only used categories and derives summary values from category kinds', async () => {
    renderComposer(
      <TurnComposer
        projectId="project-1"
        selectedSessionId="session-1"
        selectedSession={{ id: 'session-1', projectId: 'project-1', title: 'Session', occupiedBy: null, occupiedStatus: 'idle', kind: null }}
        activity={null}
        liveSessionId="session-1"
        liveUserMessageUuid={null}
        latestTurnPhase={null}
        pendingTurnId={null}
        setSelectedSessionId={vi.fn()}
        setPendingTurn={vi.fn()}
        refreshSessionLists={vi.fn()}
        onSessionCreated={vi.fn()}
        settings={{ timeZone: 'Asia/Shanghai', defaultModel: null, defaultEffort: 'medium', useOneMillionContext: true, autoCompactPercent: undefined }}
        sessionRuntime={null}
        projectDirectoryUnavailable={false}
        turnOptions={null}
        externalPermissionMode={null}
        contextUsage={{
          model: 'model-a',
          categories: [
            { name: 'Messages', tokens: 700, kind: 'used' },
            { name: 'Tools', tokens: 500, kind: 'used' },
            { name: 'Free category', tokens: 800, kind: 'free' },
            { name: 'Buffer category', tokens: 3_000, kind: 'buffer' },
            { name: 'Deferred category', tokens: 1_000, kind: 'deferred' },
          ],
          totalTokens: 1_500,
          autoCompactThreshold: 8_000,
          maxTokens: 10_000,
          percentage: 15,
          updatedAtMs: 123,
        }}
        onNotify={vi.fn()}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Context usage: 15%' }))

    const popover = screen.getByRole('dialog', { name: 'Context usage details' })
    expect(popover.textContent).toContain('Messages')
    expect(popover.textContent).toContain('Tools')
    expect(popover.textContent).not.toContain('Free category')
    expect(popover.textContent).not.toContain('Buffer category')
    expect(popover.textContent).not.toContain('Deferred category')
    expect(screen.getByText('Total used').parentElement?.textContent).toContain('1,200')
    expect(screen.getByText('Free space').parentElement?.textContent).toContain('800')
  })

  it('clears a successful pending submission after switching away from its scope', async () => {
    let resolveTurn!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (resolveTurn = resolve))),
    )
    const refreshSessionLists = vi.fn()
    const props: ComponentProps<typeof TurnComposer> = {
      projectId: 'project-1',
      selectedSessionId: 'session-a',
      selectedSession: { id: 'session-a', projectId: 'project-1', title: 'A', occupiedBy: null, occupiedStatus: 'idle', kind: null },
      activity: null,
      liveSessionId: 'session-a',
      liveUserMessageUuid: null,
      latestTurnPhase: null,
      pendingTurnId: null,
      setSelectedSessionId: vi.fn(),
      setPendingTurn: vi.fn(),
      refreshSessionLists,
      onSessionCreated: vi.fn(),
      settings: { timeZone: 'Asia/Shanghai', defaultModel: null, defaultEffort: 'medium', useOneMillionContext: true, autoCompactPercent: undefined },
      sessionRuntime: null,
      projectDirectoryUnavailable: false,
      turnOptions: { permissionMode: 'default', model: null, effort: null },
      externalPermissionMode: null,
      contextUsage: null,
      onNotify: vi.fn(),
    }
    function Harness() {
      const [selectedSessionId, setSelectedSessionId] = useState<string | null>('session-a')
      const [pending, setPending] = useState<PendingSubmission | null>(null)
      return (
        <>
          <button type="button" onClick={() => setSelectedSessionId('session-b')}>
            Select B
          </button>
          <output aria-label="Pending submission">{pending?.submissionUuid ?? ''}</output>
          <TurnComposer {...props} selectedSessionId={selectedSessionId} setSelectedSessionId={setSelectedSessionId} pendingTurnId={pending?.submissionUuid ?? null} setPendingTurn={setPending} />
        </>
      )
    }

    renderComposer(<Harness />)
    fireEvent.change(screen.getByPlaceholderText('Describe a task or ask a question'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByText('Select B'))
    expect(screen.getByPlaceholderText('Describe a task or ask a question').hasAttribute('disabled')).toBe(true)

    await act(async () =>
      resolveTurn(
        new Response(JSON.stringify({ projectId: 'project-1', sessionId: 'session-a', userMessageUuid: 'message-1' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    expect(screen.getByLabelText('Pending submission').textContent).toBe('')
    expect(screen.getByPlaceholderText('Describe a task or ask a question').hasAttribute('disabled')).toBe(false)
    expect(refreshSessionLists).toHaveBeenCalledWith('project-1', 'session-a')
  })

  it('keeps a failed submission frozen across session switches, then restores it on timeout', async () => {
    let rejectTurn!: (error: Error) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((_, reject) => (rejectTurn = reject))),
    )
    const props: ComponentProps<typeof TurnComposer> = {
      projectId: 'project-1',
      selectedSessionId: 'session-a',
      selectedSession: { id: 'session-a', projectId: 'project-1', title: 'A', occupiedBy: null, occupiedStatus: 'idle', kind: null },
      activity: null,
      liveSessionId: 'session-a',
      liveUserMessageUuid: null,
      latestTurnPhase: null,
      pendingTurnId: null,
      setSelectedSessionId: vi.fn(),
      setPendingTurn: vi.fn(),
      refreshSessionLists: vi.fn(),
      onSessionCreated: vi.fn(),
      settings: { timeZone: 'Asia/Shanghai', defaultModel: null, defaultEffort: 'medium', useOneMillionContext: true, autoCompactPercent: undefined },
      sessionRuntime: null,
      projectDirectoryUnavailable: false,
      turnOptions: { permissionMode: 'default', model: null, effort: null },
      externalPermissionMode: null,
      contextUsage: null,
      onNotify: vi.fn(),
    }
    function Harness() {
      const [selectedSessionId, setSelectedSessionId] = useState<string | null>('session-a')
      const [pending, setPending] = useState<PendingSubmission | null>(null)
      return (
        <>
          <button type="button" onClick={() => setSelectedSessionId('session-a')}>
            Select A
          </button>
          <button type="button" onClick={() => setSelectedSessionId('session-b')}>
            Select B
          </button>
          <TurnComposer {...props} selectedSessionId={selectedSessionId} setSelectedSessionId={setSelectedSessionId} pendingTurnId={pending?.submissionUuid ?? null} setPendingTurn={setPending} />
        </>
      )
    }

    renderComposer(<Harness />)
    fireEvent.change(screen.getByPlaceholderText('Describe a task or ask a question'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByText('Select B'))
    vi.useFakeTimers()
    await act(async () => rejectTurn(new Error('network')))
    expect((screen.getByPlaceholderText('Describe a task or ask a question') as HTMLTextAreaElement).value).toBe('hello')
    expect(screen.getByRole('button', { name: 'Submit' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByText('Select A'))
    expect((screen.getByPlaceholderText('Describe a task or ask a question') as HTMLTextAreaElement).value).toBe('hello')
    expect(screen.getByRole('button', { name: 'Submit' }).hasAttribute('disabled')).toBe(true)
    await act(async () => vi.advanceTimersByTimeAsync(UNKNOWN_SUBMISSION_RECOVERY_MS))
    expect((screen.getByPlaceholderText('Describe a task or ask a question') as HTMLTextAreaElement).value).toBe('hello')
    expect(screen.getByRole('button', { name: 'Submit' }).hasAttribute('disabled')).toBe(false)
    vi.useRealTimers()
  })

  it('synchronizes updated model and effort for the selected session', async () => {
    const props = {
      projectId: 'project-1',
      selectedSessionId: 'session-a',
      selectedSession: { id: 'session-a', projectId: 'project-1', title: 'A', occupiedBy: null, occupiedStatus: 'idle', kind: null },
      activity: null,
      liveSessionId: 'session-a',
      liveUserMessageUuid: null,
      latestTurnPhase: null,
      pendingTurnId: null,
      setSelectedSessionId: vi.fn(),
      setPendingTurn: vi.fn(),
      refreshSessionLists: vi.fn(),
      onSessionCreated: vi.fn(),
      settings: {
        timeZone: 'Asia/Shanghai',
        defaultModel: null,
        defaultEffort: 'medium' as const,
        useOneMillionContext: true,
        autoCompactPercent: undefined,
        modelCatalog: {
          models: [
            { value: 'model-a', displayName: 'Model A', description: '', supportsEffort: true, supportedEffortLevels: ['medium' as const, 'high' as const] },
            { value: 'model-b', displayName: 'Model B', description: '', supportsEffort: true, supportedEffortLevels: ['medium' as const, 'high' as const] },
          ],
        },
      },
      sessionRuntime: null,
      projectDirectoryUnavailable: false,
      turnOptions: { permissionMode: 'default' as const, model: 'model-a', effort: 'medium' as const },
      externalPermissionMode: null,
      contextUsage: null,
      onNotify: vi.fn(),
    } satisfies ComponentProps<typeof TurnComposer>
    const { rerender } = renderComposer(<TurnComposer {...props} />)
    expect(screen.getByRole('button', { name: 'Model Model A, effort medium' })).toBeTruthy()

    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TurnComposer {...props} turnOptions={{ permissionMode: 'default', model: 'model-b', effort: 'high' }} />
      </QueryClientProvider>,
    )

    expect(await screen.findByRole('button', { name: 'Model Model B, effort high' })).toBeTruthy()
  })

  it('protects a pending model save until newer turn options arrive', async () => {
    let resolveSave!: () => void
    vi.mocked(saveTurnOptions).mockReturnValueOnce(new Promise<void>((resolve) => (resolveSave = resolve)))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const props = {
      projectId: 'project-1',
      selectedSessionId: 'session-a',
      selectedSession: { id: 'session-a', projectId: 'project-1', title: 'A', occupiedBy: null, occupiedStatus: 'idle', kind: null },
      activity: null,
      liveSessionId: 'session-a',
      liveUserMessageUuid: null,
      latestTurnPhase: null,
      pendingTurnId: null,
      setSelectedSessionId: vi.fn(),
      setPendingTurn: vi.fn(),
      refreshSessionLists: vi.fn(),
      onSessionCreated: vi.fn(),
      settings: {
        timeZone: 'Asia/Shanghai',
        defaultModel: null,
        defaultEffort: 'medium' as const,
        useOneMillionContext: true,
        autoCompactPercent: undefined,
        modelCatalog: {
          models: [
            { value: 'model-a', displayName: 'Model A', description: '', supportsEffort: true, supportedEffortLevels: ['medium' as const] },
            { value: 'model-b', displayName: 'Model B', description: '', supportsEffort: true, supportedEffortLevels: ['medium' as const] },
          ],
        },
      },
      sessionRuntime: null,
      projectDirectoryUnavailable: false,
      turnOptions: { permissionMode: 'default' as const, model: 'model-a', effort: 'medium' as const },
      externalPermissionMode: null,
      contextUsage: null,
      onNotify: vi.fn(),
    } satisfies ComponentProps<typeof TurnComposer>
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <TurnComposer {...props} />
      </QueryClientProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Model Model A, effort medium' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Model B' }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'medium' }))
    rerender(
      <QueryClientProvider client={client}>
        <TurnComposer {...props} />
      </QueryClientProvider>,
    )
    expect(screen.getByRole('button', { name: 'Model Model B, effort medium' })).toBeTruthy()
    await act(async () => resolveSave())
    rerender(
      <QueryClientProvider client={client}>
        <TurnComposer {...props} turnOptions={{ permissionMode: 'default', model: 'model-b', effort: 'medium' }} />
      </QueryClientProvider>,
    )
    expect(await screen.findByRole('button', { name: 'Model Model B, effort medium' })).toBeTruthy()
  })

  it('keeps the saved model when refreshing its read model fails', async () => {
    vi.mocked(saveTurnOptions).mockResolvedValueOnce()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateQueries = vi.spyOn(client, 'invalidateQueries').mockRejectedValue(new Error('refresh failed'))
    const props = {
      projectId: 'project-1',
      selectedSessionId: 'session-a',
      selectedSession: { id: 'session-a', projectId: 'project-1', title: 'A', occupiedBy: null, occupiedStatus: 'idle', kind: null },
      activity: null,
      liveSessionId: 'session-a',
      liveUserMessageUuid: null,
      latestTurnPhase: null,
      pendingTurnId: null,
      setSelectedSessionId: vi.fn(),
      setPendingTurn: vi.fn(),
      refreshSessionLists: vi.fn(),
      onSessionCreated: vi.fn(),
      settings: {
        timeZone: 'Asia/Shanghai',
        defaultModel: null,
        defaultEffort: 'medium' as const,
        useOneMillionContext: true,
        autoCompactPercent: undefined,
        modelCatalog: {
          models: [
            { value: 'model-a', displayName: 'Model A', description: '', supportsEffort: true, supportedEffortLevels: ['medium' as const] },
            { value: 'model-b', displayName: 'Model B', description: '', supportsEffort: true, supportedEffortLevels: ['medium' as const] },
          ],
        },
      },
      sessionRuntime: null,
      projectDirectoryUnavailable: false,
      turnOptions: { permissionMode: 'default' as const, model: 'model-a', effort: 'medium' as const },
      externalPermissionMode: null,
      contextUsage: null,
      onNotify: vi.fn(),
    } satisfies ComponentProps<typeof TurnComposer>
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <TurnComposer {...props} />
      </QueryClientProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Model Model A, effort medium' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Model B' }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'medium' }))
    await waitFor(() => expect(saveTurnOptions).toHaveBeenCalled())
    await waitFor(() => expect(invalidateQueries).toHaveBeenCalled())
    rerender(
      <QueryClientProvider client={client}>
        <TurnComposer {...props} turnOptions={{ ...props.turnOptions, permissionMode: 'plan' }} />
      </QueryClientProvider>,
    )
    expect(screen.getByRole('button', { name: 'Model Model B, effort medium' })).toBeTruthy()
  })

  it('selects a new session after its identity is confirmed', async () => {
    const onSessionCreated = vi.fn()
    const setSelectedSessionId = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ projectId: 'project-1', sessionId: 'session-1', userMessageUuid: 'message-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const props: ComponentProps<typeof TurnComposer> = {
      projectId: 'project-1',
      selectedSessionId: null,
      selectedSession: null,
      activity: null,
      liveSessionId: null,
      liveUserMessageUuid: null,
      latestTurnPhase: null,
      pendingTurnId: null,
      setSelectedSessionId,
      setPendingTurn: vi.fn(),
      refreshSessionLists: vi.fn(),
      onSessionCreated,
      settings: { timeZone: 'Asia/Shanghai', defaultModel: null, defaultEffort: 'medium', useOneMillionContext: true, autoCompactPercent: undefined },
      sessionRuntime: null,
      projectDirectoryUnavailable: false,
      turnOptions: null,
      externalPermissionMode: null,
      contextUsage: null,
      onNotify: vi.fn(),
    }

    renderComposer(<TurnComposer {...props} />)
    await userEvent.type(screen.getByPlaceholderText('Describe a task or ask a question'), 'hello')
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))

    await waitFor(() => expect(onSessionCreated).toHaveBeenCalledWith('project-1', 'session-1'))
    expect(setSelectedSessionId).not.toHaveBeenCalled()
  })
})
