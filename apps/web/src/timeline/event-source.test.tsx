// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TimelineSnapshotStaleError } from '../api'
import { SessionTimeline } from './index'

const { fetchSessionTimelineMock, fetchSessionTimelineControlMock, fetchTurnSubagentsTreeMock, fetchTurnSubagentTranscriptMock } = vi.hoisted(() => ({
  fetchSessionTimelineMock: vi.fn((_sessionId?: string, _options?: unknown) => new Promise(() => undefined)),
  fetchSessionTimelineControlMock: vi.fn(),
  fetchTurnSubagentsTreeMock: vi.fn(),
  fetchTurnSubagentTranscriptMock: vi.fn(),
}))

vi.mock('../api', () => ({
  fetchSessionRawMessages: vi.fn(),
  fetchSessionTimeline: fetchSessionTimelineMock,
  fetchSessionTimelineControl: fetchSessionTimelineControlMock,
  fetchTurnSubagentsTree: fetchTurnSubagentsTreeMock,
  fetchTurnSubagentTranscript: fetchTurnSubagentTranscriptMock,
  TimelineSnapshotStaleError: class extends Error {},
}))

class EventSourceMock {
  static instances: EventSourceMock[] = []
  readonly close = vi.fn()
  onmessage: ((event: MessageEvent) => void) | null = null
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    EventSourceMock.instances.push(this)
  }
}

function emptyTimeline(version = '1') {
  return {
    sessionId: 'session',
    turns: [],
    runtimeTurnProjection: null,
    turnOptions: { permissionMode: null, model: null, effort: null },
    contextUsage: null,
    liveBackgroundTasks: null,
    runState: null,
    activity: { owner: null, phase: 'idle', activeTurnId: null },
    pendingPermission: null,
    tasks: [],
    hasMore: false,
    hasNewer: false,
    nextCursor: null,
    snapshotFromTurnId: null,
    anchorTurnId: null,
    state: { sessionId: 'session', version },
  }
}

function setPanelScroll(panel: HTMLElement, { clientHeight, scrollHeight, scrollTop }: { clientHeight: number; scrollHeight: number; scrollTop: number }) {
  Object.defineProperties(panel, {
    clientHeight: { configurable: true, value: clientHeight },
    scrollHeight: { configurable: true, value: scrollHeight },
    scrollTop: { configurable: true, writable: true, value: scrollTop },
  })
}

function timelinePanel(container: HTMLElement) {
  const panel = container.querySelector<HTMLElement>('.timeline-panel')
  if (!panel) throw new Error('timeline panel not found')
  return panel
}

function emitLiveTurn() {
  const events = EventSourceMock.instances[0]
  events?.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'user', uuid: 'user-1', session_id: 'session', message: { role: 'user', content: 'hello' } }) }))
  events?.onmessage?.(
    new MessageEvent('message', {
      data: JSON.stringify({ type: 'assistant', uuid: 'assistant-1', session_id: 'session', message: { id: 'message-1', role: 'assistant', content: [{ type: 'text', text: 'partial' }] } }),
    }),
  )
}

function emitTerminalResult() {
  EventSourceMock.instances[0]?.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'result', subtype: 'success', session_id: 'session' }) }))
}

afterEach(() => {
  cleanup()
  EventSourceMock.instances = []
  fetchSessionTimelineMock.mockClear()
  fetchSessionTimelineControlMock.mockReset()
  fetchTurnSubagentsTreeMock.mockReset()
  fetchTurnSubagentTranscriptMock.mockReset()
  vi.unstubAllGlobals()
})

describe('timeline EventSource lifecycle', () => {
  it('refetches the Timeline once after a terminal live event', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    fetchSessionTimelineMock.mockResolvedValue(emptyTimeline('1'))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId="session" />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(fetchSessionTimelineMock).toHaveBeenCalledOnce())
    emitLiveTurn()
    emitTerminalResult()
    await waitFor(() => expect(fetchSessionTimelineMock).toHaveBeenCalledTimes(2))
    emitTerminalResult()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchSessionTimelineMock).toHaveBeenCalledTimes(2)
  })

  it('updates tasks from a control refresh without fetching the full timeline', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    fetchSessionTimelineMock.mockResolvedValue({
      ...emptyTimeline('1'),
      tasks: [{ id: '1', subject: 'Initial task', status: 'pending', blockedBy: [] }],
    })
    fetchSessionTimelineControlMock.mockResolvedValue({
      sessionId: 'session',
      turnOptions: { permissionMode: null, model: null, effort: null },
      contextUsage: null,
      liveBackgroundTasks: null,
      runState: null,
      activity: { owner: null, phase: 'idle', activeTurnId: null },
      pendingPermission: null,
      tasks: [{ id: '2', subject: 'Refreshed task', status: 'in_progress', blockedBy: [] }],
      state: { sessionId: 'session', version: '2' },
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onTasksChange = vi.fn()
    const view = (version: string | null) => (
      <QueryClientProvider client={queryClient}>
        <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId="session" timelineControlSignal={version ? { epoch: 'epoch', version } : null} onTasksChange={onTasksChange} />
      </QueryClientProvider>
    )
    const { rerender } = render(view(null))

    await waitFor(() => expect(onTasksChange).toHaveBeenLastCalledWith([{ id: '1', subject: 'Initial task', status: 'pending', blockedBy: [] }]))
    rerender(view('2'))

    await waitFor(() => expect(onTasksChange).toHaveBeenLastCalledWith([{ id: '2', subject: 'Refreshed task', status: 'in_progress', blockedBy: [] }]))
    expect(fetchSessionTimelineControlMock).toHaveBeenCalledOnce()
    expect(fetchSessionTimelineMock).toHaveBeenCalledOnce()
  })

  it('retries the full refetch when a later control version still confirms the pending slash runtime is terminal', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    fetchSessionTimelineMock.mockResolvedValue(emptyTimeline())
    fetchSessionTimelineControlMock.mockResolvedValue({
      ...emptyTimeline('2'),
      runState: { phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'u1', outcome: 'success' } },
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = (version: string) => (
      <QueryClientProvider client={queryClient}>
        <SessionTimeline
          timeZone="Asia/Shanghai"
          projectId="project"
          sessionId="session"
          provisionalSlash={{ submissionUuid: 'u1', localKey: 'local', text: '/clear', timestamp: 1, phase: 'submitted' }}
          timelineControlSignal={{ epoch: 'epoch', version }}
        />
      </QueryClientProvider>
    )
    const { rerender } = render(view('2'))

    await waitFor(() => expect(fetchSessionTimelineMock).toHaveBeenCalledTimes(2))
    expect(fetchSessionTimelineMock.mock.calls).toEqual([
      ['session', { pendingSubmissionUuid: 'u1' }],
      ['session', { pendingSubmissionUuid: 'u1' }],
    ])
    rerender(view('3'))
    await waitFor(() => expect(fetchSessionTimelineControlMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(fetchSessionTimelineMock).toHaveBeenCalledTimes(3))
  })

  it('does not let a terminal direct v2 response overwrite a requested v3 transcript', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    let resolveV2!: (value: unknown) => void
    fetchSessionTimelineMock
      .mockResolvedValueOnce({ ...emptyTimeline('1'), tasks: [{ id: '1', subject: 'Initial task', status: 'pending', blockedBy: [] }] })
      .mockImplementationOnce(() => new Promise((resolve) => (resolveV2 = resolve)))
      .mockResolvedValueOnce({ ...emptyTimeline('3'), tasks: [{ id: '3', subject: 'Fresh v3 task', status: 'completed', blockedBy: [] }] })
    fetchSessionTimelineControlMock.mockResolvedValue({
      ...emptyTimeline('2'),
      runState: { phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'u1', outcome: 'success' } },
    })
    const onTasksChange = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = (transcriptVersion: string | null) => (
      <QueryClientProvider client={queryClient}>
        <SessionTimeline
          timeZone="Asia/Shanghai"
          projectId="project"
          sessionId="session"
          provisionalSlash={{ submissionUuid: 'u1', localKey: 'local', text: '/clear', timestamp: 1, phase: 'submitted' }}
          timelineControlSignal={{ epoch: 'epoch', version: '2' }}
          transcriptSignal={transcriptVersion ? { source: 'change', epoch: 'epoch', version: transcriptVersion, reset: true, invalidateFromTurnId: null } : null}
          onTasksChange={onTasksChange}
        />
      </QueryClientProvider>
    )
    const { rerender } = render(view(null))
    await waitFor(() => expect(fetchSessionTimelineMock).toHaveBeenCalledTimes(2))

    rerender(view('3'))
    await waitFor(() => expect(onTasksChange).toHaveBeenLastCalledWith([{ id: '3', subject: 'Fresh v3 task', status: 'completed', blockedBy: [] }]))
    resolveV2({ ...emptyTimeline('2'), tasks: [{ id: '2', subject: 'Stale v2 task', status: 'in_progress', blockedBy: [] }] })
    await act(async () => {})

    expect(onTasksChange).not.toHaveBeenCalledWith([{ id: '2', subject: 'Stale v2 task', status: 'in_progress', blockedBy: [] }])
    expect(fetchSessionTimelineMock.mock.calls.map(([, options]) => options)).toEqual([{ pendingSubmissionUuid: 'u1' }, { pendingSubmissionUuid: 'u1' }, { pendingSubmissionUuid: 'u1' }])
  })

  it('shows a control refresh error and retries only when requested', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    fetchSessionTimelineMock.mockResolvedValue(emptyTimeline('1'))
    fetchSessionTimelineControlMock.mockRejectedValueOnce(new Error('control unavailable')).mockResolvedValueOnce({
      sessionId: 'session',
      turnOptions: { permissionMode: null, model: null, effort: null },
      contextUsage: null,
      liveBackgroundTasks: null,
      runState: null,
      activity: { owner: null, phase: 'idle', activeTurnId: null },
      pendingPermission: null,
      tasks: null,
      state: { sessionId: 'session', version: '2' },
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId="session" timelineControlSignal={{ epoch: 'epoch', version: '2' }} />
      </QueryClientProvider>,
    )

    await screen.findByText((text) => text.includes('control unavailable'))
    expect(fetchSessionTimelineControlMock).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(fetchSessionTimelineControlMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText((text) => text.includes('control unavailable'))).toBeNull())
  })

  it('does not let an older full response overwrite current control state or surface stale control failures', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    let resolveFull!: (value: unknown) => void
    let rejectControl!: (error: Error) => void
    fetchSessionTimelineMock.mockImplementationOnce(() => new Promise((resolve) => (resolveFull = resolve)))
    fetchSessionTimelineControlMock.mockImplementationOnce(() => new Promise((_resolve, reject) => (rejectControl = reject)))
    const onTasksChange = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = (version: string | null) => (
      <QueryClientProvider client={queryClient}>
        <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId="session" timelineControlSignal={version ? { epoch: 'epoch', version } : null} onTasksChange={onTasksChange} />
      </QueryClientProvider>
    )
    const { rerender } = render(view(null))
    await waitFor(() => expect(fetchSessionTimelineMock).toHaveBeenCalledOnce())
    rerender(view('2'))
    await waitFor(() => expect(fetchSessionTimelineControlMock).toHaveBeenCalledOnce())
    resolveFull({ ...emptyTimeline('1'), tasks: [{ id: 'full', subject: 'Stale task', status: 'pending', blockedBy: [] }] })
    rejectControl(new Error('stale control unavailable'))
    await act(async () => {})

    expect(onTasksChange).not.toHaveBeenCalledWith([{ id: 'full', subject: 'Stale task', status: 'pending', blockedBy: [] }])
    expect(screen.queryByText((text) => text.includes('stale control unavailable'))).toBeNull()
  })

  it('applies a v3 full timeline response after retaining a control-only v2 signal', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    fetchSessionTimelineMock
      .mockResolvedValueOnce({ ...emptyTimeline('1'), tasks: [{ id: '1', subject: 'Initial task', status: 'pending', blockedBy: [] }] })
      .mockResolvedValueOnce({ ...emptyTimeline('3'), tasks: [{ id: '3', subject: 'Full refresh task', status: 'completed', blockedBy: [] }] })
    fetchSessionTimelineControlMock.mockResolvedValue({
      sessionId: 'session',
      turnOptions: { permissionMode: null, model: null, effort: null },
      contextUsage: null,
      liveBackgroundTasks: null,
      runState: null,
      activity: { owner: null, phase: 'idle', activeTurnId: null },
      pendingPermission: null,
      tasks: [{ id: '2', subject: 'Control refresh task', status: 'in_progress', blockedBy: [] }],
      state: { sessionId: 'session', version: '2' },
    })
    const onTasksChange = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = (controlVersion: string | null, transcriptVersion: string | null) => (
      <QueryClientProvider client={queryClient}>
        <SessionTimeline
          timeZone="Asia/Shanghai"
          projectId="project"
          sessionId="session"
          timelineControlSignal={controlVersion ? { epoch: 'epoch', version: controlVersion } : null}
          transcriptSignal={transcriptVersion ? { source: 'change', epoch: 'epoch', version: transcriptVersion, reset: true, invalidateFromTurnId: null } : null}
          onTasksChange={onTasksChange}
        />
      </QueryClientProvider>
    )
    const { rerender } = render(view(null, null))

    await waitFor(() => expect(onTasksChange).toHaveBeenLastCalledWith([{ id: '1', subject: 'Initial task', status: 'pending', blockedBy: [] }]))
    rerender(view('2', null))
    await waitFor(() => expect(onTasksChange).toHaveBeenLastCalledWith([{ id: '2', subject: 'Control refresh task', status: 'in_progress', blockedBy: [] }]))
    rerender(view('2', '3'))

    await waitFor(() => expect(onTasksChange).toHaveBeenLastCalledWith([{ id: '3', subject: 'Full refresh task', status: 'completed', blockedBy: [] }]))
    expect(fetchSessionTimelineControlMock).toHaveBeenCalledOnce()
  })

  it('initializes pagination from snapshot catchup after rejecting an older initial HTTP response', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    let resolveInitial!: (value: unknown) => void
    let resolveCatchup!: (value: unknown) => void
    const turn = (id: string) => ({ primaryUserUuid: id, messages: [{ type: 'user', uuid: id, message: { role: 'user', content: id } }] })
    fetchSessionTimelineMock
      .mockReset()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveInitial = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveCatchup = resolve)))
      .mockResolvedValueOnce({ ...emptyTimeline('2'), turns: [turn('older prompt')] })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = (snapshot: boolean) => (
      <QueryClientProvider client={queryClient}>
        <SessionTimeline
          timeZone="Asia/Shanghai"
          projectId="project"
          sessionId="session"
          transcriptSignal={snapshot ? { source: 'snapshot', epoch: 'epoch', version: '2', reset: false, invalidateFromTurnId: null } : null}
        />
      </QueryClientProvider>
    )
    const { rerender } = render(view(false))
    await waitFor(() => expect(fetchSessionTimelineMock).toHaveBeenCalledOnce())

    rerender(view(true))
    expect(fetchSessionTimelineMock).toHaveBeenCalledOnce()
    await act(async () => resolveInitial({ ...emptyTimeline('1'), turns: [turn('stale prompt')], hasMore: true, nextCursor: 'stale-cursor' }))
    await waitFor(() => expect(fetchSessionTimelineMock).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('stale prompt')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Load older' })).toBeNull()
    expect(fetchSessionTimelineMock).toHaveBeenNthCalledWith(2, 'session', {})

    await act(async () => resolveCatchup({ ...emptyTimeline('2'), turns: [turn('current prompt')], hasMore: true, nextCursor: 'catchup-cursor' }))
    await screen.findByText('current prompt')
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }))
    await screen.findByText('older prompt')
    expect(fetchSessionTimelineMock).toHaveBeenNthCalledWith(3, 'session', { cursor: 'catchup-cursor' })
    expect(screen.getByText('current prompt')).toBeTruthy()
    expect(screen.queryByText('stale prompt')).toBeNull()
  })

  it('preserves loaded older turns and their pagination on snapshot catchup', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    const turn = (id: string) => ({ primaryUserUuid: id, messages: [{ type: 'user', uuid: id, message: { role: 'user', content: id } }] })
    fetchSessionTimelineMock
      .mockReset()
      .mockResolvedValueOnce({ ...emptyTimeline(), turns: [turn('latest prompt')], hasMore: true, nextCursor: 'initial-cursor' })
      .mockResolvedValueOnce({ ...emptyTimeline(), turns: [turn('older prompt')], hasMore: true, nextCursor: 'older-cursor' })
      .mockResolvedValueOnce({ ...emptyTimeline('2'), turns: [turn('older prompt'), turn('latest prompt'), turn('new prompt')], snapshotFromTurnId: 'older prompt' })
      .mockResolvedValue(emptyTimeline('2'))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = (snapshot: boolean) => (
      <QueryClientProvider client={queryClient}>
        <SessionTimeline
          timeZone="Asia/Shanghai"
          projectId="project"
          sessionId="session"
          transcriptSignal={snapshot ? { source: 'snapshot', epoch: 'epoch', version: '2', reset: false, invalidateFromTurnId: null } : null}
        />
      </QueryClientProvider>
    )
    const { rerender } = render(view(false))
    fireEvent.click(await screen.findByRole('button', { name: 'Load older' }))
    await screen.findByText('older prompt')

    rerender(view(true))
    await screen.findByText('new prompt')
    expect(screen.getByText('older prompt')).toBeTruthy()
    expect(screen.getByText('latest prompt')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }))
    await waitFor(() =>
      expect(fetchSessionTimelineMock.mock.calls).toEqual([
        ['session', {}],
        ['session', { cursor: 'initial-cursor' }],
        ['session', { fromTurnId: 'older prompt' }],
        ['session', { cursor: 'older-cursor' }],
      ]),
    )
  })

  it.each(['search anchor', 'empty window'] as const)('preserves accepted %s pagination on snapshot catchup', async (window) => {
    vi.stubGlobal('EventSource', EventSourceMock)
    const anchored = window === 'search anchor'
    const turn = (id: string) => ({ primaryUserUuid: id, messages: [{ type: 'user', uuid: id, message: { role: 'user', content: id } }] })
    fetchSessionTimelineMock
      .mockReset()
      .mockResolvedValueOnce({ ...emptyTimeline(), turns: anchored ? [turn('anchor prompt')] : [], hasMore: anchored, nextCursor: anchored ? 'anchor-cursor' : null })
      .mockResolvedValueOnce({ ...emptyTimeline('2'), turns: [turn('refreshed prompt')], hasMore: !anchored, nextCursor: anchored ? null : 'unaccepted-cursor' })
      .mockResolvedValue(emptyTimeline('2'))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = (snapshot: boolean) => (
      <QueryClientProvider client={queryClient}>
        <SessionTimeline
          timeZone="Asia/Shanghai"
          projectId="project"
          sessionId="session"
          searchAnchorTurnId={anchored ? 'anchor prompt' : null}
          transcriptSignal={snapshot ? { source: 'snapshot', epoch: 'epoch', version: '2', reset: false, invalidateFromTurnId: null } : null}
        />
      </QueryClientProvider>
    )
    const { rerender } = render(view(false))
    await screen.findByText(anchored ? 'anchor prompt' : 'What should we build?')

    rerender(view(true))
    await screen.findByText('refreshed prompt')
    expect(fetchSessionTimelineMock).toHaveBeenNthCalledWith(2, 'session', anchored ? { anchorTurnId: 'anchor prompt' } : {})
    if (anchored) {
      fireEvent.click(screen.getByRole('button', { name: 'Load older' }))
      await waitFor(() => expect(fetchSessionTimelineMock).toHaveBeenNthCalledWith(3, 'session', { cursor: 'anchor-cursor' }))
    } else {
      expect(screen.queryByRole('button', { name: 'Load older' })).toBeNull()
      expect(fetchSessionTimelineMock).toHaveBeenCalledTimes(2)
    }
  })

  it('uses a preflighted anchored page without fetching it again on mount', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['session-timeline', 'session', 'user-anchor'], {
      ...emptyTimeline(),
      anchorTurnId: 'user-anchor',
      turns: [{ primaryUserUuid: 'user-anchor', messages: [{ type: 'user', uuid: 'user-anchor', message: { role: 'user', content: 'preflighted prompt' } }] }],
    })

    render(
      <QueryClientProvider client={queryClient}>
        <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId="session" searchAnchorTurnId="user-anchor" />
      </QueryClientProvider>,
    )

    await screen.findByText('preflighted prompt')
    expect(fetchSessionTimelineMock).not.toHaveBeenCalled()
  })

  it('keeps the search anchor on transcript append and reset refreshes', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    const anchoredTimeline = (version: string) => ({ ...emptyTimeline(version), anchorTurnId: 'user-anchor', hasNewer: true })
    fetchSessionTimelineMock.mockResolvedValueOnce(anchoredTimeline('1')).mockResolvedValueOnce(anchoredTimeline('2')).mockResolvedValueOnce(anchoredTimeline('3'))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = (version: string | null, reset = false) => (
      <QueryClientProvider client={queryClient}>
        <SessionTimeline
          timeZone="Asia/Shanghai"
          projectId="project"
          sessionId="session"
          searchAnchorTurnId="user-anchor"
          transcriptSignal={version ? { source: 'change', epoch: 'epoch', version, reset, invalidateFromTurnId: reset ? null : 'user-anchor' } : null}
        />
      </QueryClientProvider>
    )
    const { rerender } = render(view(null))
    await waitFor(() => expect(fetchSessionTimelineMock).toHaveBeenCalledTimes(1))

    rerender(view('2'))
    await waitFor(() => expect(fetchSessionTimelineMock).toHaveBeenCalledTimes(2))
    rerender(view('3', true))
    await waitFor(() => expect(fetchSessionTimelineMock).toHaveBeenCalledTimes(3))

    expect(fetchSessionTimelineMock.mock.calls.map(([, options]) => options)).toEqual([{ anchorTurnId: 'user-anchor' }, { anchorTurnId: 'user-anchor' }, { anchorTurnId: 'user-anchor' }])
  })

  it.each(['initial', 'query refresh', 'append', 'reset', 'snapshot', 'load older'] as const)('leaves a stale search anchor once on %s and fetches latest without an anchor', async (entry) => {
    vi.stubGlobal('EventSource', EventSourceMock)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onJumpToLatest = vi.fn()
    const onNotify = vi.fn()
    const stale = new TimelineSnapshotStaleError('anchor missing')
    const anchored = {
      ...emptyTimeline(),
      anchorTurnId: 'user-anchor',
      hasMore: entry === 'load older',
      nextCursor: entry === 'load older' ? 'older-cursor' : null,
      turns: [{ primaryUserUuid: 'user-anchor', messages: [{ type: 'user', uuid: 'user-anchor', message: { role: 'user', content: 'historical prompt' } }] }],
    }
    const latest = { ...emptyTimeline('2'), turns: [{ primaryUserUuid: 'latest', messages: [{ type: 'user', uuid: 'latest', message: { role: 'user', content: 'latest prompt' } }] }] }
    fetchSessionTimelineMock.mockReset().mockResolvedValue(latest)
    if (entry !== 'initial') fetchSessionTimelineMock.mockResolvedValueOnce(anchored)
    fetchSessionTimelineMock.mockRejectedValueOnce(stale)
    function View({ refresh }: { refresh: boolean }) {
      const [anchor, setAnchor] = useState<string | null>('user-anchor')
      return (
        <QueryClientProvider client={queryClient}>
          <SessionTimeline
            timeZone="Asia/Shanghai"
            projectId="project"
            sessionId="session"
            searchAnchorTurnId={anchor}
            transcriptSignal={
              refresh && ['append', 'reset', 'snapshot'].includes(entry)
                ? { source: entry === 'snapshot' ? 'snapshot' : 'change', epoch: 'epoch', version: '2', reset: entry === 'reset', invalidateFromTurnId: entry === 'reset' ? null : 'user-anchor' }
                : null
            }
            onJumpToLatest={() => {
              onJumpToLatest()
              setAnchor(null)
            }}
            onNotify={onNotify}
          />
        </QueryClientProvider>
      )
    }
    const { rerender } = render(<View refresh={false} />)
    if (entry !== 'initial') {
      await screen.findByText('historical prompt')
      if (entry === 'query refresh')
        await act(async () => {
          await queryClient.invalidateQueries({ queryKey: ['session-timeline', 'session', 'user-anchor'] })
        })
      else if (entry === 'load older') fireEvent.click(screen.getByText('Load older'))
      else rerender(<View refresh />)
    }
    await screen.findByText('latest prompt')
    expect(onJumpToLatest).toHaveBeenCalledTimes(1)
    expect(onNotify).toHaveBeenCalledTimes(1)
    expect(onNotify).toHaveBeenCalledWith({ message: 'Original message can no longer be located. Showing latest messages.', tone: 'error' })
    const requests = fetchSessionTimelineMock.mock.calls.map(([, options]) => options as { anchorTurnId?: string } | undefined)
    expect(requests.at(-1)).toEqual({})
    const anchoredRequests = requests.filter((options) => options?.anchorTurnId === 'user-anchor')
    expect(anchoredRequests).toHaveLength(entry === 'initial' || entry === 'load older' ? 1 : 2)
    expect(requests.findIndex((options) => Object.keys(options ?? {}).length === 0)).toBeGreaterThan(requests.lastIndexOf(anchoredRequests.at(-1)))
  })

  it.each(['initial', 'refresh'] as const)('does not leave a search anchor for an ordinary %s error', async (entry) => {
    vi.stubGlobal('EventSource', EventSourceMock)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onJumpToLatest = vi.fn()
    const onNotify = vi.fn()
    fetchSessionTimelineMock.mockReset().mockImplementation(() => new Promise(() => undefined))
    if (entry === 'refresh') fetchSessionTimelineMock.mockResolvedValueOnce({ ...emptyTimeline(), anchorTurnId: 'user-anchor' })
    fetchSessionTimelineMock.mockRejectedValueOnce(new Error('network unavailable'))
    const view = (refresh: boolean) => (
      <QueryClientProvider client={queryClient}>
        <SessionTimeline
          timeZone="Asia/Shanghai"
          projectId="project"
          sessionId="session"
          searchAnchorTurnId="user-anchor"
          onJumpToLatest={onJumpToLatest}
          onNotify={onNotify}
          transcriptSignal={refresh ? { source: 'change', epoch: 'epoch', version: '2', reset: false, invalidateFromTurnId: 'user-anchor' } : null}
        />
      </QueryClientProvider>
    )
    const { rerender } = render(view(false))
    if (entry === 'refresh') {
      await waitFor(() => expect(screen.getByLabelText('Session workspace')).toBeTruthy())
      rerender(view(true))
    }
    await screen.findByText((content) => content.includes('network unavailable'))
    expect(onJumpToLatest).not.toHaveBeenCalled()
    expect(onNotify).not.toHaveBeenCalled()
    expect(fetchSessionTimelineMock.mock.calls.every(([, options]) => JSON.stringify(options) === JSON.stringify({ anchorTurnId: 'user-anchor' }))).toBe(true)
  })

  it.each(['initial', 'refresh'] as const)('ignores a stale %s response after selecting another session', async (entry) => {
    vi.stubGlobal('EventSource', EventSourceMock)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onJumpToLatest = vi.fn()
    const onNotify = vi.fn()
    let rejectStale!: (error: Error) => void
    fetchSessionTimelineMock.mockReset()
    if (entry === 'refresh') fetchSessionTimelineMock.mockResolvedValueOnce({ ...emptyTimeline(), anchorTurnId: 'user-anchor' })
    fetchSessionTimelineMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectStale = reject
        }),
    )
    fetchSessionTimelineMock.mockResolvedValue({
      ...emptyTimeline('2'),
      sessionId: 'other',
      turns: [{ primaryUserUuid: 'other', messages: [{ type: 'user', uuid: 'other', message: { role: 'user', content: 'other session prompt' } }] }],
    })
    const view = (sessionId: string, refresh = false) => (
      <QueryClientProvider client={queryClient}>
        <SessionTimeline
          timeZone="Asia/Shanghai"
          projectId="project"
          sessionId={sessionId}
          searchAnchorTurnId="user-anchor"
          onJumpToLatest={onJumpToLatest}
          onNotify={onNotify}
          transcriptSignal={refresh ? { source: 'change', epoch: 'epoch', version: '2', reset: false, invalidateFromTurnId: 'user-anchor' } : null}
        />
      </QueryClientProvider>
    )
    const { rerender } = render(view('session'))
    if (entry === 'refresh') {
      await waitFor(() => expect(screen.getByLabelText('Session workspace')).toBeTruthy())
      rerender(view('session', true))
    }
    await waitFor(() => expect(rejectStale).toBeTypeOf('function'))
    rerender(view('other'))
    await screen.findByText('other session prompt')
    await act(async () => {
      rejectStale(new TimelineSnapshotStaleError('old anchor missing'))
    })
    expect(onJumpToLatest).not.toHaveBeenCalled()
    expect(onNotify).not.toHaveBeenCalled()
    expect(screen.getByText('other session prompt')).toBeTruthy()
    expect(fetchSessionTimelineMock.mock.calls.filter(([sessionId]) => sessionId === 'other')).toEqual([['other', { anchorTurnId: 'user-anchor' }]])
  })

  it('handles the same stale anchor independently after switching sessions', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onJumpToLatest = vi.fn()
    const onNotify = vi.fn()
    fetchSessionTimelineMock.mockReset().mockRejectedValue(new TimelineSnapshotStaleError('anchor missing'))
    const view = (sessionId: string) => (
      <QueryClientProvider client={queryClient}>
        <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId={sessionId} searchAnchorTurnId="user-anchor" onJumpToLatest={onJumpToLatest} onNotify={onNotify} />
      </QueryClientProvider>
    )

    const { rerender } = render(view('first'))
    await waitFor(() => expect(onJumpToLatest).toHaveBeenCalledTimes(1))
    rerender(view('second'))
    await waitFor(() => expect(onJumpToLatest).toHaveBeenCalledTimes(2))
    expect(onNotify).toHaveBeenCalledTimes(2)
    expect(fetchSessionTimelineMock.mock.calls.map(([sessionId]) => sessionId)).toEqual(['first', 'second'])
  })

  it('excludes live events from an anchored historical window', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    fetchSessionTimelineMock.mockResolvedValue({
      ...emptyTimeline(),
      anchorTurnId: 'user-anchor',
      turns: [{ primaryUserUuid: 'user-anchor', messages: [{ type: 'user', uuid: 'user-anchor', message: { role: 'user', content: 'historical prompt' } }] }],
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId="session" searchAnchorTurnId="user-anchor" />
      </QueryClientProvider>,
    )
    await screen.findByText('historical prompt')
    expect(screen.queryByText('Jump to latest')).toBeNull()

    act(() => emitLiveTurn())

    expect(screen.queryByText('hello')).toBeNull()
    expect(screen.queryByText('partial')).toBeNull()
    expect(screen.getByText('Jump to latest')).toBeTruthy()
  })

  it('updates pending permission from selected-session timeline refreshes', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    const approval = { requestId: 'request-1', toolUseID: 'tool-1', toolName: 'Bash', input: { command: 'npm test' } }
    fetchSessionTimelineMock
      .mockResolvedValueOnce(emptyTimeline('1'))
      .mockResolvedValueOnce({
        ...emptyTimeline('2'),
        runState: { phase: 'requires_action', activeUserMessageUuid: 'user-1', pendingPermission: approval },
        activity: { owner: 'cotta', phase: 'waiting', activeTurnId: 'user-1' },
        pendingPermission: approval,
      })
      .mockResolvedValueOnce(emptyTimeline('3'))
    const onPendingPermissionChange = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = (version: string | null) => (
      <QueryClientProvider client={queryClient}>
        <SessionTimeline
          timeZone="Asia/Shanghai"
          projectId="project"
          sessionId="session"
          transcriptSignal={version ? { source: 'change', epoch: 'epoch', version, reset: true, invalidateFromTurnId: null } : null}
          onPendingPermissionChange={onPendingPermissionChange}
        />
      </QueryClientProvider>
    )
    const { rerender } = render(view(null))
    await waitFor(() => expect(onPendingPermissionChange).toHaveBeenLastCalledWith(null))

    rerender(view('2'))
    await waitFor(() => expect(onPendingPermissionChange).toHaveBeenLastCalledWith(approval))

    rerender(view('3'))
    await waitFor(() => expect(onPendingPermissionChange).toHaveBeenLastCalledWith(null))
  })

  it('keeps the latest phase active when the active turn is outside the loaded window', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    fetchSessionTimelineMock.mockResolvedValue({
      ...emptyTimeline(),
      runState: { phase: 'running', activeUserMessageUuid: 'user-1', lastTurn: null },
      activity: { owner: 'cotta', phase: 'busy', activeTurnId: 'user-1' },
    })
    const onLatestTurnPhaseChange = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId="session" onLatestTurnPhaseChange={onLatestTurnPhaseChange} />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(onLatestTurnPhaseChange).toHaveBeenLastCalledWith('submitted'))
  })

  it('atomically replaces a provisional slash row with its authoritative U1 user echo', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    fetchSessionTimelineMock.mockResolvedValue(emptyTimeline())
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function View() {
      const [provisional, setProvisional] = useState({ submissionUuid: 'u1', localKey: 'local', text: '/unknown arg', timestamp: 1, phase: 'submitted' as const })
      return (
        <QueryClientProvider client={queryClient}>
          <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId="session" provisionalSlash={provisional} onPendingTurnReconciled={() => setProvisional(null as never)} />
        </QueryClientProvider>
      )
    }
    const { container } = render(<View />)
    await screen.findByText('/unknown arg')

    act(() =>
      EventSourceMock.instances[0]?.onmessage?.(
        new MessageEvent('message', { data: JSON.stringify({ type: 'user', uuid: 'u1', session_id: 'session', message: { role: 'user', content: '/unknown arg' } }) }),
      ),
    )

    await waitFor(() => expect(container.querySelector('[data-provisional-command="true"]')).toBeNull())
    expect(screen.getAllByText('/unknown arg')).toHaveLength(1)
    expect(container.querySelector('.justify-end')).toBeTruthy()
  })

  it('keeps unresolved terminal evidence out of the reducer and refetches the full timeline', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    let resolveTerminal!: (value: unknown) => void
    fetchSessionTimelineMock.mockResolvedValueOnce(emptyTimeline()).mockImplementationOnce(() => new Promise((resolve) => (resolveTerminal = resolve)))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(
      <QueryClientProvider client={queryClient}>
        <SessionTimeline
          timeZone="Asia/Shanghai"
          projectId="project"
          sessionId="session"
          provisionalSlash={{ submissionUuid: 'u1', localKey: 'local', text: '/clear', timestamp: 1, phase: 'submitted' }}
        />
      </QueryClientProvider>,
    )
    await screen.findByText('/clear')

    act(() => emitTerminalResult())

    await waitFor(() => expect(fetchSessionTimelineMock).toHaveBeenCalledTimes(2))
    expect(view.container.querySelector('.turn-card:not([data-provisional-command="true"])')).toBeNull()
    resolveTerminal(emptyTimeline('2'))
  })

  it('adopts a correlated U2 root and merges feedback arriving before and after it into one command row', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    fetchSessionTimelineMock.mockResolvedValue(emptyTimeline())
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function View() {
      const [provisional, setProvisional] = useState({ submissionUuid: 'u1', localKey: 'local', text: '/model opus', timestamp: 1, phase: 'submitted' as const })
      return (
        <QueryClientProvider client={queryClient}>
          <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId="session" provisionalSlash={provisional} onPendingTurnReconciled={() => setProvisional(null as never)} />
        </QueryClientProvider>
      )
    }
    const { container } = render(<View />)
    await screen.findByText('/model opus')
    const emit = (value: unknown) => EventSourceMock.instances[0]?.onmessage?.(new MessageEvent('message', { data: JSON.stringify(value) }))
    act(() => {
      emit({ type: 'system', subtype: 'local_command', uuid: 'before', parentUuid: 'u2', session_id: 'session', content: '<local-command-stdout>before</local-command-stdout>' })
      emit({ type: 'assistant', uuid: 'u2', user_message_uuid: 'u1', session_id: 'session', local_command_source: '/model opus' })
    })
    await waitFor(() => expect(container.querySelector('[data-provisional-command="true"]')).toBeNull())
    act(() => emit({ type: 'system', subtype: 'local_command', uuid: 'after', parentUuid: 'u2', session_id: 'session', content: '<local-command-stdout>after</local-command-stdout>' }))

    await waitFor(() => expect(screen.getAllByText('/model opus (before · after)')).toHaveLength(1))
    expect(container.querySelectorAll('[data-provisional-command="true"]')).toHaveLength(0)
  })

  it('drains buffered feedback for any local-command root without clearing an unrelated provisional', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    fetchSessionTimelineMock.mockResolvedValue(emptyTimeline())
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <SessionTimeline
          timeZone="Asia/Shanghai"
          projectId="project"
          sessionId="session"
          provisionalSlash={{ submissionUuid: 'u1', localKey: 'local', text: '/model opus', timestamp: 1, phase: 'submitted' }}
        />
      </QueryClientProvider>,
    )
    await screen.findByText('/model opus')
    const emit = (value: unknown) => EventSourceMock.instances[0]?.onmessage?.(new MessageEvent('message', { data: JSON.stringify(value) }))

    act(() => {
      emit({ type: 'system', subtype: 'local_command', uuid: 'feedback', parentUuid: 'other', session_id: 'session', content: '<local-command-stdout>done</local-command-stdout>' })
      emit({ type: 'assistant', uuid: 'other', session_id: 'session', local_command_source: '/clear' })
    })

    await screen.findByText('/clear (done)')
    expect(container.querySelector('[data-provisional-command="true"]')).toBeTruthy()
  })

  it('keeps runtime U1 for controls and terminal while visible messages move to U2', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    fetchSessionTimelineMock.mockResolvedValue(emptyTimeline())
    const onLiveTurnChange = vi.fn()
    const onPendingTurnReconciled = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <SessionTimeline
          timeZone="Asia/Shanghai"
          projectId="project"
          sessionId="session"
          provisionalSlash={{ submissionUuid: 'u1', localKey: 'local', text: '/model opus', timestamp: 1, phase: 'submitted' }}
          onLiveTurnChange={onLiveTurnChange}
          onPendingTurnReconciled={onPendingTurnReconciled}
        />
      </QueryClientProvider>,
    )
    await screen.findByText('/model opus')
    const emit = (value: unknown) => EventSourceMock.instances[0]?.onmessage?.(new MessageEvent('message', { data: JSON.stringify(value) }))

    act(() => {
      emit({ type: 'assistant', uuid: 'u2', user_message_uuid: 'u1', session_id: 'session', local_command_source: '/model opus' })
      emit({ type: 'assistant', uuid: 'answer', session_id: 'session', message: { id: 'message', role: 'assistant', content: [{ type: 'text', text: 'visible U2 response' }] } })
    })
    await screen.findByText('visible U2 response')
    expect(onPendingTurnReconciled).toHaveBeenCalledWith('session', 'u1')
    expect(onLiveTurnChange).toHaveBeenCalledWith('session', 'u1')
    act(() => emitTerminalResult())

    await waitFor(() => expect(onLiveTurnChange).toHaveBeenLastCalledWith('session', null))
    expect(onLiveTurnChange.mock.calls.filter(([, id]) => id === 'u2')).toHaveLength(0)
    await waitFor(() => expect(fetchSessionTimelineMock).toHaveBeenCalledTimes(2))
  })

  it('forces a full timeline refetch on terminal-only result and clears provisional after projection', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    fetchSessionTimelineMock.mockResolvedValueOnce(emptyTimeline()).mockResolvedValueOnce({
      ...emptyTimeline('2'),
      runtimeTurnProjection: { submissionUuid: 'u1', kind: 'terminal-only' },
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function View() {
      const [provisional, setProvisional] = useState({ submissionUuid: 'u1', localKey: 'local', text: '/clear', timestamp: 1, phase: 'submitted' as const })
      return (
        <QueryClientProvider client={queryClient}>
          <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId="session" provisionalSlash={provisional} onPendingTurnReconciled={() => setProvisional(null as never)} />
        </QueryClientProvider>
      )
    }
    const { container } = render(<View />)
    await screen.findByText('/clear')
    act(() => emitTerminalResult())

    await waitFor(() => expect(fetchSessionTimelineMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(container.querySelector('[data-provisional-command="true"]')).toBeNull())
    expect(screen.queryByText('/clear')).toBeNull()
  })

  it('does not let an old U0 clear provisional and waits for exact U1 to U2 projection in a containing window', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    const old = { primaryUserUuid: 'u0', messages: [{ type: 'system', subtype: 'local_command', uuid: 'u0', content: '/model old' }] }
    const projected = { primaryUserUuid: 'u2', messages: [{ type: 'assistant', uuid: 'u2', local_command_source: '/model opus' }] }
    fetchSessionTimelineMock
      .mockResolvedValueOnce({ ...emptyTimeline(), turns: [old] })
      .mockResolvedValueOnce({ ...emptyTimeline('2'), turns: [old, projected], runtimeTurnProjection: { submissionUuid: 'u1', kind: 'visible', visibleTurnUuid: 'u2' } })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function View() {
      const [provisional, setProvisional] = useState({ submissionUuid: 'u1', localKey: 'local', text: '/model opus', timestamp: 1, phase: 'submitted' as const })
      const [signal, setSignal] = useState<null | { source: 'change'; epoch: string; version: string; reset: boolean; invalidateFromTurnId: null }>(null)
      return (
        <QueryClientProvider client={queryClient}>
          <button type="button" onClick={() => setSignal({ source: 'change', epoch: 'epoch', version: '2', reset: true, invalidateFromTurnId: null })}>
            refresh
          </button>
          <SessionTimeline
            timeZone="Asia/Shanghai"
            projectId="project"
            sessionId="session"
            provisionalSlash={provisional}
            transcriptSignal={signal}
            onPendingTurnReconciled={() => setProvisional(null as never)}
          />
        </QueryClientProvider>
      )
    }
    const { container } = render(<View />)
    await screen.findByText('/model old')
    expect(container.querySelector('[data-provisional-command="true"]')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
    await screen.findByText('/model opus')
    await waitFor(() => expect(container.querySelector('[data-provisional-command="true"]')).toBeNull())
    expect(screen.getAllByText(/\/model (?:old|opus)/)).toHaveLength(2)
  })

  it('renders a provisional slash row without message affordances or response chrome', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    fetchSessionTimelineMock.mockResolvedValue(emptyTimeline())
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <SessionTimeline
          timeZone="Asia/Shanghai"
          projectId="project"
          sessionId="session"
          provisionalSlash={{ submissionUuid: 'submission', localKey: 'local', text: '/model opus', timestamp: 1, phase: 'submitted' }}
        />
      </QueryClientProvider>,
    )

    await screen.findByText('/model opus')
    const row = container.querySelector('[data-provisional-command="true"]')
    expect(row).toBeTruthy()
    expect(row?.querySelector('[data-message-uuid], [aria-label="Turn response"], .turn-footer')).toBeNull()
    expect(container.querySelector('.timeline-empty-state')).toBeNull()
  })

  it('does not show a response skeleton for a submitted local-command-only turn', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    fetchSessionTimelineMock.mockResolvedValue({
      ...emptyTimeline(),
      runState: { phase: 'running', activeUserMessageUuid: 'command', lastTurn: null },
      activity: { owner: 'cotta', phase: 'busy', activeTurnId: 'command' },
      turns: [
        {
          primaryUserUuid: 'command',
          messages: [{ type: 'system', subtype: 'local_command', uuid: 'command', content: '<command-name>/model</command-name><command-message>model</command-message>' }],
        },
      ],
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId="session" />
      </QueryClientProvider>,
    )

    await screen.findByText('/model')
    expect(container.querySelector('[aria-label="Turn response"]')).toBeNull()
  })

  it('shows one turn cooking footer for visible external activity without an active turn id', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    fetchSessionTimelineMock.mockResolvedValue({
      ...emptyTimeline(),
      activity: { owner: 'external', phase: 'busy', activeTurnId: null },
      turns: [
        {
          primaryUserUuid: 'user-1',
          messages: [{ type: 'user', uuid: 'user-1', message: { role: 'user', content: 'hello' } }],
        },
      ],
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId="session" />
      </QueryClientProvider>,
    )

    await screen.findByText('hello')
    expect(container.querySelectorAll('.cli-cooking')).toHaveLength(1)
    expect(container.querySelector('.timeline-panel > .cli-cooking')).toBeNull()
  })

  it('shows active task text before the cooking verb for a visible external turn', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    fetchSessionTimelineMock.mockResolvedValue({
      ...emptyTimeline(),
      activity: { owner: 'external', phase: 'busy', activeTurnId: null },
      tasks: [{ id: '1', subject: 'Fallback subject', activeForm: '验证 Task 创建', status: 'in_progress', blockedBy: [] }],
      turns: [
        {
          primaryUserUuid: 'user-1',
          entrypoint: 'cli',
          messages: [
            { type: 'user', uuid: 'user-1', message: { role: 'user', content: 'hello' } },
            { type: 'assistant', uuid: 'assistant-1', message: { id: 'message-1', role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
          ],
        },
      ],
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId="session" />
      </QueryClientProvider>,
    )

    await screen.findByText('answer')
    expect(screen.getByText('验证 Task 创建…')).toBeTruthy()
    expect(container.querySelectorAll('.cli-cooking')).toHaveLength(1)
    expect(container.querySelector('.timeline-panel > .cli-cooking')).toBeNull()
  })

  it('does not reopen a settled turn for external activity', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    fetchSessionTimelineMock.mockResolvedValue({
      ...emptyTimeline(),
      activity: { owner: 'external', phase: 'busy', activeTurnId: null },
      turns: [
        {
          primaryUserUuid: 'user-1',
          durationMs: 21_000,
          messages: [
            { type: 'user', uuid: 'user-1', message: { role: 'user', content: 'hello' } },
            { type: 'assistant', uuid: 'assistant-1', message: { id: 'message-1', role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
          ],
        },
      ],
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId="session" />
      </QueryClientProvider>,
    )

    await screen.findByText('answer')
    expect(container.querySelector('.cli-cooking')).toBeNull()
    expect(screen.getByText(/ for 21s$/)).toBeTruthy()
  })

  it('shows active task text before the generic cooking verb for the active turn', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    fetchSessionTimelineMock.mockResolvedValue({
      ...emptyTimeline(),
      tasks: [{ id: '1', subject: 'Fallback subject', activeForm: '验证 Task 创建', status: 'in_progress', blockedBy: [] }],
      runState: { phase: 'running', activeUserMessageUuid: 'user-1', lastTurn: null },
      activity: { owner: 'cotta', phase: 'busy', activeTurnId: 'user-1' },
      turns: [
        {
          primaryUserUuid: 'user-1',
          messages: [
            { type: 'user', uuid: 'user-1', message: { role: 'user', content: 'hello' } },
            { type: 'assistant', uuid: 'assistant-1', message: { id: 'message-1', role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
          ],
        },
      ],
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId="session" />
      </QueryClientProvider>,
    )

    await screen.findByText('answer')
    expect(screen.getByText('验证 Task 创建…')).toBeTruthy()
  })

  it('keeps a transcript-owned turn active while run state still owns it', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    fetchSessionTimelineMock.mockResolvedValue({
      ...emptyTimeline(),
      runState: { phase: 'running', activeUserMessageUuid: 'user-1', lastTurn: null },
      activity: { owner: 'cotta', phase: 'busy', activeTurnId: 'user-1' },
      turns: [
        {
          primaryUserUuid: 'user-1',
          messages: [
            { type: 'user', uuid: 'user-1', message: { role: 'user', content: 'hello' } },
            { type: 'assistant', uuid: 'assistant-1', message: { id: 'message-1', role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
          ],
        },
      ],
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId="session" />
      </QueryClientProvider>,
    )

    await screen.findByText('answer')
    expect(container.querySelector('.cli-cooking')).not.toBeNull()
  })

  it('shows Fork for a settled transcript response while the session is running', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    fetchSessionTimelineMock.mockResolvedValue({
      sessionId: 'session',
      turns: [
        {
          primaryUserUuid: 'user-1',
          durationMs: 1,
          messages: [
            { type: 'user', uuid: 'user-1', message: { role: 'user', content: 'hello' } },
            { type: 'assistant', uuid: 'assistant-1', message: { id: 'message-1', role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
          ],
        },
      ],
      turnOptions: { permissionMode: null, model: null, effort: null },
      contextUsage: null,
      liveBackgroundTasks: null,
      runState: null,
      activity: { owner: null, phase: 'idle', activeTurnId: null },
      pendingPermission: null,
      tasks: [],
      hasMore: false,
      hasNewer: false,
      nextCursor: null,
      snapshotFromTurnId: null,
      anchorTurnId: null,
      state: { sessionId: 'session', version: '1' },
    })
    const onForkSession = vi.fn().mockResolvedValue(undefined)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={queryClient}>
        <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId="session" onForkSession={onForkSession} />
      </QueryClientProvider>,
    )

    const fork = await screen.findByRole('button', { name: 'Fork session from this response' })
    fireEvent.click(fork)
    await waitFor(() => expect(onForkSession).toHaveBeenCalledWith('assistant-1'))
  })

  it('copies cwd and session id from both turn footers', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    fetchSessionTimelineMock.mockResolvedValue({
      ...emptyTimeline(),
      turns: [
        {
          primaryUserUuid: 'user-1',
          primaryUserTimestampMs: 1,
          durationMs: 1,
          durationTimestampMs: 2,
          entrypoint: 'sdk-ts',
          userCwd: '/repo/start',
          responseCwd: '/repo/end',
          messages: [
            { type: 'user', uuid: 'user-1', message: { role: 'user', content: 'hello' } },
            { type: 'assistant', uuid: 'assistant-1', message: { id: 'message-1', role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
          ],
        },
      ],
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={queryClient}>
        <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId="session" />
      </QueryClientProvider>,
    )

    const cwdButtons = await screen.findAllByRole('button', { name: 'Copy working directory' })
    const sessionButtons = screen.getAllByRole('button', { name: 'Copy session ID' })
    fireEvent.click(cwdButtons[0]!)
    fireEvent.click(cwdButtons[1]!)
    fireEvent.click(sessionButtons[0]!)
    fireEvent.click(sessionButtons[1]!)
    await waitFor(() => expect(writeText.mock.calls.map(([value]) => value)).toEqual(['/repo/start', '/repo/end', 'session', 'session']))
  })

  it('refetches a selected subagent transcript when its tree version changes', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    HTMLDialogElement.prototype.showModal = vi.fn()
    HTMLDialogElement.prototype.close = vi.fn()
    fetchSessionTimelineMock.mockResolvedValue({
      ...emptyTimeline(),
      turns: [
        {
          primaryUserUuid: 'user-1',
          subagentCount: 1,
          messages: [{ type: 'user', uuid: 'user-1', message: { role: 'user', content: 'hello' } }],
        },
      ],
    })
    fetchTurnSubagentsTreeMock.mockResolvedValue({
      sessionId: 'session',
      ownerTurnId: 'user-1',
      tree: [{ metadataReady: true, agentId: 'agent-1', parentAgentId: null, agentType: 'Explore', name: null, description: null, model: null, transcriptVersion: 'v1', transcriptModifiedAtMs: null }],
    })
    const v1 = {
      sessionId: 'session',
      ownerTurnId: 'user-1',
      agentId: 'agent-1',
      transcript: { version: 'v1', turns: [{ primaryUserUuid: 'sub-user-1', messages: [{ type: 'user', uuid: 'sub-user-1', message: { role: 'user', content: 'old task' } }] }] },
    }
    const v2 = {
      ...v1,
      transcript: {
        version: 'v2',
        turns: [
          { primaryUserUuid: 'sub-user-1', messages: [{ type: 'user', uuid: 'sub-user-1', message: { role: 'user', content: 'updated task' } }] },
          { primaryUserUuid: 'sub-user-2', messages: [{ type: 'user', uuid: 'sub-user-2', message: { role: 'user', content: 'appended task' } }] },
        ],
      },
    }
    let resolveV2!: (value: typeof v2) => void
    fetchTurnSubagentTranscriptMock.mockResolvedValueOnce(v1).mockImplementationOnce(() => new Promise((resolve) => (resolveV2 = resolve)))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={queryClient}>
        <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId="session" />
      </QueryClientProvider>,
    )

    fireEvent.click((await screen.findAllByRole('button', { name: 'View subagents' }))[0]!)
    fireEvent.click((await screen.findByText('Explore')).closest('button')!)
    expect(await screen.findByText('old task')).toBeTruthy()

    act(() => {
      queryClient.setQueryData(['turn-subagents-tree', 'session', 'user-1'], {
        sessionId: 'session',
        ownerTurnId: 'user-1',
        tree: [
          { metadataReady: true, agentId: 'agent-1', parentAgentId: null, agentType: 'Explore', name: null, description: null, model: null, transcriptVersion: 'v2', transcriptModifiedAtMs: null },
        ],
      })
    })

    await waitFor(() => expect(fetchTurnSubagentTranscriptMock).toHaveBeenCalledTimes(2))
    expect(screen.getByText('old task')).toBeTruthy()
    expect(screen.queryByLabelText('Loading subagent transcript')).toBeNull()

    await act(async () => resolveV2(v2))
    expect(await screen.findByText('updated task')).toBeTruthy()
    expect(screen.getByText('appended task')).toBeTruthy()
    expect(screen.queryByText('old task')).toBeNull()
  })

  it('connects before history confirmation while keeping history fetch gated', () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onLiveTurnChange = vi.fn()
    const onSessionListStale = vi.fn()
    const view = (sessionId: string | null, historyEnabled: boolean) => (
      <QueryClientProvider client={queryClient}>
        <SessionTimeline
          timeZone="Asia/Shanghai"
          projectId="project"
          sessionId={sessionId}
          historyEnabled={historyEnabled}
          onLiveTurnChange={onLiveTurnChange}
          onSessionListStale={onSessionListStale}
        />
      </QueryClientProvider>
    )
    const { rerender } = render(view('session', false))

    expect(EventSourceMock.instances).toHaveLength(1)
    expect(EventSourceMock.instances[0]?.url).toBe('/api/sessions/session/events')
    expect(fetchSessionTimelineMock).not.toHaveBeenCalled()

    act(() => {
      EventSourceMock.instances[0]?.onmessage?.(
        new MessageEvent('message', { data: JSON.stringify({ type: 'user', uuid: 'user-1', session_id: 'session', message: { role: 'user', content: 'hello' } }) }),
      )
      EventSourceMock.instances[0]?.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'result', subtype: 'success', session_id: 'session' }) }))
    })
    expect(onLiveTurnChange).toHaveBeenNthCalledWith(1, 'session', 'user-1')
    expect(onLiveTurnChange).toHaveBeenNthCalledWith(2, 'session', null)
    expect(onSessionListStale).toHaveBeenCalledOnce()

    rerender(view('session', true))
    expect(EventSourceMock.instances).toHaveLength(1)
    expect(fetchSessionTimelineMock).toHaveBeenCalledOnce()

    rerender(view(null, false))
    expect(EventSourceMock.instances[0]?.close).toHaveBeenCalledOnce()
  })

  it('does not leave a failed turn reconciling', () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId="session" historyEnabled={false} />
      </QueryClientProvider>,
    )

    act(() => {
      const events = EventSourceMock.instances[0]
      events?.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'user', uuid: 'user-1', session_id: 'session', message: { role: 'user', content: 'hello' } }) }))
      events?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'assistant', uuid: 'assistant-1', session_id: 'session', message: { id: 'message-1', role: 'assistant', content: [{ type: 'text', text: 'partial' }] } }),
        }),
      )
      events?.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'cotta_live_turn_failed', error: 'boom', session_id: 'session' }) }))
    })

    expect(screen.getByText('Turn failed: boom')).toBeTruthy()
    expect(container.querySelector('.cli-cooking')).toBeNull()
  })

  it('keeps the turn footer reconciling when its last frame is transcript-owned', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    fetchSessionTimelineMock.mockResolvedValue({
      sessionId: 'session',
      turns: [
        {
          primaryUserUuid: 'user-1',
          messages: [
            { type: 'user', uuid: 'user-1', message: { role: 'user', content: 'hello' } },
            { type: 'assistant', uuid: 'assistant-1', message: { id: 'message-1', role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
          ],
        },
      ],
      turnOptions: { permissionMode: null, model: null, effort: null },
      contextUsage: null,
      liveBackgroundTasks: null,
      runState: null,
      activity: { owner: null, phase: 'idle', activeTurnId: null },
      pendingPermission: null,
      tasks: [],
      hasMore: false,
      hasNewer: false,
      nextCursor: null,
      snapshotFromTurnId: null,
      anchorTurnId: null,
      state: { sessionId: 'session', version: '1' },
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId="session" />
      </QueryClientProvider>,
    )
    await screen.findByText('answer')

    act(() => {
      const events = EventSourceMock.instances[0]
      events?.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'user', uuid: 'user-1', session_id: 'session', message: { role: 'user', content: 'hello' } }) }))
      events?.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'result', subtype: 'success', session_id: 'session' }) }))
    })

    expect(screen.getAllByText('TRANSCRIPT')).not.toHaveLength(0)
    expect(container.querySelector('.cli-cooking')).not.toBeNull()
  })

  it('keeps following after a delayed programmatic scroll event', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    let resize: ResizeObserverCallback | null = null
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback
        }
        observe = vi.fn()
        disconnect = vi.fn()
      },
    )
    fetchSessionTimelineMock.mockResolvedValue(emptyTimeline())
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId="session" />
      </QueryClientProvider>,
    )
    await screen.findByText('What should we build?')
    const panel = timelinePanel(container)
    setPanelScroll(panel, { clientHeight: 100, scrollHeight: 300, scrollTop: 120 })
    fireEvent.scroll(panel)
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to latest message' }))

    act(emitLiveTurn)
    await screen.findByText('partial')
    setPanelScroll(panel, { clientHeight: 100, scrollHeight: 360, scrollTop: panel.scrollTop })
    fireEvent.scroll(panel)
    act(() => resize?.([], {} as ResizeObserver))

    expect(panel.scrollTop).toBe(360)
    expect(screen.queryByRole('button', { name: 'Scroll to latest message' })).toBeNull()
  })

  it('resets bottom follow when the same component switches sessions', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const pendingTurn = (id: string) => ({ primaryUserUuid: id, messages: [{ type: 'user', uuid: id, message: { role: 'user', content: id } }] })
    const view = (sessionId: string) => (
      <QueryClientProvider client={queryClient}>
        <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId={sessionId} historyEnabled={false} pendingTurn={pendingTurn(`turn-${sessionId}`)} pendingPhase="submitted" />
      </QueryClientProvider>
    )
    const { container, rerender } = render(view('session-a'))
    const panel = timelinePanel(container)
    setPanelScroll(panel, { clientHeight: 100, scrollHeight: 300, scrollTop: 120 })
    fireEvent.scroll(panel)
    expect(screen.getByRole('button', { name: 'Scroll to latest message' })).toBeTruthy()

    setPanelScroll(panel, { clientHeight: 100, scrollHeight: 400, scrollTop: panel.scrollTop })
    rerender(view('session-b'))

    expect(panel.scrollTop).toBe(400)
    expect(screen.queryByRole('button', { name: 'Scroll to latest message' })).toBeNull()
  })

  it('does not steal scroll after user scrolls away from bottom', async () => {
    vi.stubGlobal('EventSource', EventSourceMock)
    let resize: ResizeObserverCallback | null = null
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback
        }
        observe = vi.fn()
        disconnect = vi.fn()
      },
    )
    fetchSessionTimelineMock.mockResolvedValue(emptyTimeline())
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <SessionTimeline timeZone="Asia/Shanghai" projectId="project" sessionId="session" />
      </QueryClientProvider>,
    )
    await screen.findByText('What should we build?')
    const panel = timelinePanel(container)
    setPanelScroll(panel, { clientHeight: 100, scrollHeight: 300, scrollTop: 120 })
    fireEvent.scroll(panel)

    act(emitLiveTurn)
    await screen.findByText('partial')
    setPanelScroll(panel, { clientHeight: 100, scrollHeight: 360, scrollTop: panel.scrollTop })
    act(() => resize?.([], {} as ResizeObserver))

    expect(panel.scrollTop).toBe(120)
    expect(screen.getByRole('button', { name: 'Scroll to latest message' })).toBeTruthy()
  })
})
