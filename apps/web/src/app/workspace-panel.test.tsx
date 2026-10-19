// @vitest-environment jsdom

import type { AppSettings, SessionSummary, SessionTimelineResponse } from '@cotta/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const timelineEffects: Array<(value: SessionTimelineResponse['pendingPermission']) => void> = []
const timelineTaskEffects: Array<(value: SessionTimelineResponse['tasks']) => void> = []
const timelineLiveTurnEffects: Array<(sessionId: string, userMessageUuid: string | null) => void> = []
const timelineListStaleEffects: Array<() => void> = []
const timelineAutoTasks = new Map<string, SessionTimelineResponse['tasks']>()
const timelineHistoryEnabled: boolean[] = []
const composerBeforeSubmits: Array<(() => void) | undefined> = []
const composerPendingTurnIds: Array<string | null> = []
const timelinePendingProps: unknown[] = []
let composerSetPending: ((value: unknown) => void) | undefined

vi.mock('../timeline', () => ({
  authoritativeTurnPhase: (_pending: unknown, observed: unknown) => observed,
  SessionTimeline: ({
    historyEnabled,
    onLiveTurnChange,
    onPendingPermissionChange,
    onSessionListStale,
    onTasksChange,
    pendingTurn,
    provisionalSlash,
    sessionId,
  }: {
    historyEnabled?: boolean
    onLiveTurnChange?: (sessionId: string, userMessageUuid: string | null) => void
    onPendingPermissionChange?: (value: SessionTimelineResponse['pendingPermission']) => void
    onSessionListStale?: () => void
    onTasksChange?: (value: SessionTimelineResponse['tasks']) => void
    pendingTurn?: unknown
    provisionalSlash?: unknown
    sessionId?: string | null
  }) => {
    useEffect(() => {
      timelineEffects.push(onPendingPermissionChange!)
      timelineTaskEffects.push(onTasksChange!)
      timelineLiveTurnEffects.push(onLiveTurnChange!)
      timelineListStaleEffects.push(onSessionListStale!)
      timelineHistoryEnabled.push(Boolean(historyEnabled))
      timelinePendingProps.push({ pendingTurn, provisionalSlash, sessionId })
      onPendingPermissionChange?.(null)
      onTasksChange?.(timelineAutoTasks.get(sessionId ?? '') ?? null)
    }, [historyEnabled, onPendingPermissionChange, onTasksChange, pendingTurn, provisionalSlash, sessionId])
    return null
  },
  SessionTaskList: ({ tasks }: { tasks: SessionTimelineResponse['tasks'] }) => <section aria-label="Session tasks">{tasks?.[0]?.subject}</section>,
}))
vi.mock('./permission-approval', () => ({ PermissionApprovalCard: () => null }))
vi.mock('./project-files', () => ({
  ExplorerPanel: ({
    onFilesLayoutChange,
    onPreviewLayoutChange,
  }: {
    onFilesLayoutChange: (layout: { paneWidth: number; previewWidth: number }) => void
    onPreviewLayoutChange: (layout: { paneWidth: number; previewWidth: number }) => void
  }) => {
    useEffect(() => onFilesLayoutChange({ paneWidth: 565, previewWidth: 380 }), [onFilesLayoutChange])
    return (
      <button type="button" onClick={() => onPreviewLayoutChange({ paneWidth: 760, previewWidth: 380 })}>
        Resize file preview
      </button>
    )
  },
}))
vi.mock('./turn-composer', () => ({
  ComposerLottieButton: () => null,
  TurnComposer: ({ onBeforeSubmit, pendingTurnId, setPendingTurn }: { onBeforeSubmit?: () => void; pendingTurnId: string | null; setPendingTurn: (value: unknown) => void }) => {
    composerBeforeSubmits.push(onBeforeSubmit)
    composerPendingTurnIds.push(pendingTurnId)
    composerSetPending = setPendingTurn
    return null
  },
}))

import { WorkspacePanel } from './workspace-panel'

afterEach(() => {
  cleanup()
  timelineEffects.length = 0
  timelineTaskEffects.length = 0
  timelineLiveTurnEffects.length = 0
  timelineListStaleEffects.length = 0
  timelineAutoTasks.clear()
  timelineHistoryEnabled.length = 0
  composerBeforeSubmits.length = 0
  composerPendingTurnIds.length = 0
  timelinePendingProps.length = 0
  composerSetPending = undefined
})

describe('WorkspacePanel', () => {
  function renderWorkspacePanel(props: Partial<Parameters<typeof WorkspacePanel>[0]> = {}) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={queryClient}>
        <WorkspacePanel
          chatHeader={null}
          githubLogin={null}
          explorerOpen={false}
          explorerPaneWidth={null}
          onExplorerPaneWidthChange={vi.fn()}
          onExplorerOpenChange={vi.fn()}
          projectId="project-1"
          projectName="Project"
          currentCwd={null}
          transcriptSignal={null}
          selectedSession={{ id: 'session-1' } as SessionSummary}
          selectedSessionId="session-1"
          setSelectedSessionId={vi.fn()}
          refreshSessionLists={vi.fn()}
          onSessionCreated={vi.fn()}
          settings={{} as AppSettings}
          sessionRuntime={null}
          projectDirectoryUnavailable={false}
          onForkSession={vi.fn()}
          onNotify={vi.fn()}
          {...props}
        />
      </QueryClientProvider>,
    )
  }

  it('routes slash submissions by their session and passes only the provisional descriptor', async () => {
    renderWorkspacePanel()
    await waitFor(() => expect(composerSetPending).toBeTypeOf('function'))
    act(() =>
      composerSetPending?.({
        kind: 'slash',
        projectId: 'project-1',
        sessionId: 'session-1',
        submissionUuid: 'u1',
        localKey: 'local',
        text: '/model opus',
        timestamp: 1,
        phase: 'submitting',
      }),
    )

    expect(timelinePendingProps.at(-1)).toMatchObject({ sessionId: 'session-1', pendingTurn: null, provisionalSlash: { submissionUuid: 'u1', text: '/model opus' } })
  })

  it('globally blocks submitting work but not submitted work after switching scope', async () => {
    const { rerender } = renderWorkspacePanel()
    await waitFor(() => expect(composerSetPending).toBeTypeOf('function'))
    act(() =>
      composerSetPending?.({
        kind: 'turn',
        projectId: 'project-1',
        sessionId: 'session-1',
        submissionUuid: 'pending-1',
        phase: 'submitting',
        turn: {},
      }),
    )
    await waitFor(() => expect(composerPendingTurnIds.at(-1)).toBe('pending-1'))

    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <WorkspacePanel
          chatHeader={null}
          githubLogin={null}
          explorerOpen={false}
          explorerPaneWidth={null}
          onExplorerPaneWidthChange={vi.fn()}
          onExplorerOpenChange={vi.fn()}
          projectId="project-2"
          projectName="Other"
          currentCwd={null}
          transcriptSignal={null}
          selectedSession={{ id: 'session-2' } as SessionSummary}
          selectedSessionId="session-2"
          setSelectedSessionId={vi.fn()}
          refreshSessionLists={vi.fn()}
          onSessionCreated={vi.fn()}
          settings={{} as AppSettings}
          sessionRuntime={null}
          projectDirectoryUnavailable={false}
          onForkSession={vi.fn()}
          onNotify={vi.fn()}
        />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(composerPendingTurnIds.at(-1)).toBe('pending-1'))
    expect(timelinePendingProps.at(-1)).toMatchObject({ sessionId: 'session-2', pendingTurn: null })

    act(() =>
      composerSetPending?.({
        kind: 'turn',
        projectId: 'project-1',
        sessionId: 'session-1',
        submissionUuid: 'pending-1',
        phase: 'submitted',
        turn: {},
      }),
    )
    await waitFor(() => expect(composerPendingTurnIds.at(-1)).toBeNull())
    expect(timelinePendingProps.at(-1)).toMatchObject({ sessionId: 'session-2', pendingTurn: null })
  })

  it('keeps the pending permission callback stable after its state update', async () => {
    renderWorkspacePanel()

    await waitFor(() => expect(timelineEffects).toHaveLength(1))
  })

  it('refreshes session lists once when a terminal turn emits both callbacks', async () => {
    const refreshSessionLists = vi.fn()
    renderWorkspacePanel({ refreshSessionLists })

    await waitFor(() => expect(timelineLiveTurnEffects).toHaveLength(1))
    act(() => {
      timelineLiveTurnEffects[0]?.('session-1', null)
      timelineListStaleEffects[0]?.()
    })

    expect(refreshSessionLists).toHaveBeenCalledTimes(1)
    expect(refreshSessionLists).toHaveBeenCalledWith(['project-1'], undefined)
  })

  it('does not enable history until the selected session summary matches', async () => {
    renderWorkspacePanel({ selectedSession: undefined })

    await waitFor(() => expect(timelineHistoryEnabled).toEqual([false]))
  })

  it('shows tasks in the composer region and keeps newly published tasks when switching sessions', async () => {
    const { rerender } = renderWorkspacePanel()
    await waitFor(() => expect(timelineTaskEffects).toHaveLength(1))
    act(() => timelineTaskEffects[0]?.([{ id: '1', subject: 'First task', status: 'pending', blockedBy: [] }]))
    await waitFor(() => expect(screen.getByLabelText('Session tasks').textContent).toBe('First task'))

    timelineAutoTasks.set('session-2', [{ id: '2', subject: 'Second task', status: 'pending', blockedBy: [] }])
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <WorkspacePanel
          chatHeader={null}
          githubLogin={null}
          explorerOpen={false}
          explorerPaneWidth={null}
          onExplorerPaneWidthChange={vi.fn()}
          onExplorerOpenChange={vi.fn()}
          projectId="project-1"
          projectName="Project"
          currentCwd={null}
          transcriptSignal={null}
          selectedSession={{ id: 'session-2' } as SessionSummary}
          selectedSessionId="session-2"
          setSelectedSessionId={vi.fn()}
          refreshSessionLists={vi.fn()}
          onSessionCreated={vi.fn()}
          settings={{} as AppSettings}
          sessionRuntime={null}
          projectDirectoryUnavailable={false}
          onForkSession={vi.fn()}
          onNotify={vi.fn()}
        />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByLabelText('Session tasks').textContent).toBe('Second task'))
  })

  it('expands the explorer pane when the file preview reaches its minimum', () => {
    const onExplorerPaneWidthChange = vi.fn()
    const { container } = renderWorkspacePanel({ explorerOpen: true, explorerPaneWidth: 565, onExplorerPaneWidthChange })
    const workspace = container.querySelector<HTMLElement>('.workspace-main-panel')!
    vi.spyOn(workspace, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 1000, width: 1000 } as DOMRect)

    fireEvent.click(screen.getByRole('button', { name: 'Resize file preview' }))

    expect(onExplorerPaneWidthChange).toHaveBeenCalledWith(680)
  })

  it('closes Files after dragging below the close threshold', async () => {
    const onExplorerOpenChange = vi.fn()
    const onExplorerPaneWidthChange = vi.fn()
    const { container } = renderWorkspacePanel({ explorerOpen: true, explorerPaneWidth: 565, onExplorerOpenChange, onExplorerPaneWidthChange })
    const workspace = container.querySelector<HTMLElement>('.workspace-main-panel')!
    vi.spyOn(workspace, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 1000, width: 1000 } as DOMRect)

    const handle = screen.getByLabelText('Resize explorer pane')
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, isPrimary: true, clientX: 435 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 800 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 800 })

    expect(onExplorerOpenChange).toHaveBeenCalledWith(false)
    expect(onExplorerPaneWidthChange).toHaveBeenCalledWith(565)
  })

  it('jumps to latest before submitting from an anchored search result', async () => {
    const onJumpToLatest = vi.fn()
    renderWorkspacePanel({ searchAnchorTurnId: 'turn-1', onJumpToLatest })

    await waitFor(() => expect(composerBeforeSubmits.at(-1)).toBe(onJumpToLatest))
    composerBeforeSubmits.at(-1)?.()
    expect(onJumpToLatest).toHaveBeenCalledOnce()
  })
})
