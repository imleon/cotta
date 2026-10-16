// @vitest-environment jsdom

import type { ListVersionsEvent } from '@cotta/shared'
import type { QueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mount: vi.fn(),
  rename: vi.fn(),
  sessions: vi.fn(),
  projects: vi.fn(),
  pins: vi.fn(),
  resolved: vi.fn(),
  rejected: vi.fn(),
  connectListVersions: vi.fn<(onEvent: (event: ListVersionsEvent) => void) => { close: () => void }>(() => ({ close: vi.fn() })),
  selectSession: vi.fn(),
  selection: vi.fn(),
}))

vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: mocks.mount }) }))
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  fetchAuthSession: async () => ({ authenticated: true, githubConfigured: false }),
  fetchSettings: async () => ({ settings: { defaultModel: 'default', defaultEffort: 'medium', useOneMillionContext: true } }),
  fetchProjects: mocks.projects,
  fetchSessionPins: mocks.pins,
  renameSession: mocks.rename,
  queryProjectSessions: mocks.sessions,
  connectListVersions: mocks.connectListVersions,
}))
vi.mock('./app/session-history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./app/session-history')>()),
  useProjectSessionSelection: () =>
    mocks.selection() ?? {
      selectedProjectId: null,
      selectedSessionId: null,
      projectList: [{ id: 'project', name: 'Project' }],
      projectsQuery: {},
      selectedProjectSessionsQuery: {},
      selectSession: mocks.selectSession,
    },
  ProjectSessionRail: ({
    onRenameSession,
    onSelectSession,
  }: {
    onRenameSession: (projectId: string, sessionId: string, title: string) => Promise<void>
    onSelectSession: (projectId: string, sessionId: string) => void
  }) => (
    <>
      <button type="button" onClick={() => void onRenameSession('project', 'session', 'New title').then(mocks.resolved, mocks.rejected)}>
        Submit rename
      </button>
      <button type="button" onClick={() => onSelectSession('project', 'session')}>
        Select session
      </button>
    </>
  ),
}))
vi.mock('./app/workspace-panel', () => ({ WorkspacePanel: ({ chatHeader }: { chatHeader: ReactElement }) => chatHeader, WorkspacePaneToggleIcon: () => null }))
vi.mock('./app/terminal-panel', () => ({
  TerminalPanel: ({ open, onClose, onConnectedChange }: { open: boolean; onClose: () => void; onConnectedChange: (connected: boolean) => void }) => (
    <div hidden={!open}>
      <div>Terminal connected</div>
      <button type="button" onClick={() => onConnectedChange(true)}>
        Connect terminal
      </button>
      <button type="button" onClick={onClose}>
        Close terminal
      </button>
    </div>
  ),
}))
vi.mock('./app/session-search-dialog', () => ({ SessionSearchDialog: () => null }))

let app: ReactElement<{ client: QueryClient }>
beforeAll(async () => {
  await import('./main')
  app = mocks.mount.mock.calls[0][0].props.children
})
beforeEach(() => {
  mocks.rename.mockReset().mockResolvedValue({ ok: true })
  mocks.sessions.mockReset().mockResolvedValue({ sessionsByProject: { project: { sessions: [], hasMore: false, nextCursor: null } } })
  mocks.projects.mockReset().mockResolvedValue({ projects: [], hasMore: false, nextCursor: null })
  mocks.pins.mockReset().mockResolvedValue({ pins: [] })
  mocks.resolved.mockClear()
  mocks.rejected.mockClear()
  mocks.selectSession.mockClear()
  mocks.selection.mockReset()
  mocks.connectListVersions.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  app.props.client.clear()
  vi.restoreAllMocks()
})

describe('terminal visibility', () => {
  it('keeps the terminal open when selecting a session and closes it explicitly', async () => {
    window.history.replaceState(null, '', '/?terminal=1&view=details#turn')
    render(app)
    await screen.findByRole('button', { name: 'Close terminal' })

    fireEvent.click(screen.getByRole('button', { name: 'Select session' }))

    expect(mocks.selectSession).toHaveBeenCalledExactlyOnceWith('project', 'session')
    expect(screen.getByRole('button', { name: 'Close terminal' })).toBeTruthy()
    expect(window.location.pathname).toBe('/')
    expect(window.location.search).toBe('?terminal=1&view=details')
    expect(window.location.hash).toBe('#turn')

    fireEvent.click(screen.getByRole('button', { name: 'Close terminal' }))

    expect(screen.queryByRole('button', { name: 'Close terminal' })).toBeNull()
    expect(window.location.pathname).toBe('/')
    expect(window.location.search).toBe('?view=details')
    expect(window.location.hash).toBe('#turn')
  })

  it('toggles Terminal from its sidebar control and follows popstate', async () => {
    window.history.replaceState(null, '', '/')
    render(app)
    await screen.findByRole('button', { name: 'Submit rename' })

    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))

    expect(await screen.findByRole('button', { name: 'Close terminal' })).toBeTruthy()
    expect(window.location.pathname).toBe('/')
    expect(window.location.search).toBe('?terminal=1')

    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))

    expect(screen.queryByRole('button', { name: 'Close terminal' })).toBeNull()
    expect(window.location.search).toBe('')

    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    expect(await screen.findByRole('button', { name: 'Close terminal' })).toBeTruthy()

    window.history.replaceState(null, '', '/')
    fireEvent.popState(window)

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close terminal' })).toBeNull())
  })

  it('does not show Terminal on a non-workspace route', async () => {
    window.history.replaceState(null, '', '/settings?terminal=1')
    render(app)

    await screen.findByRole('heading', { name: 'Settings' })

    expect(document.querySelector<HTMLElement>('.apps-view')?.hidden).toBe(true)
    expect(screen.queryByRole('button', { name: 'Close terminal' })).toBeNull()
  })

  it('shows a Terminal badge after connect and keeps it when hidden', async () => {
    window.history.replaceState(null, '', '/')
    render(app)
    await screen.findByRole('button', { name: 'Submit rename' })

    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Connect terminal' }))

    expect(screen.getByLabelText('1 connected terminal').textContent).toBe('1')

    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))

    expect(screen.queryByRole('button', { name: 'Close terminal' })).toBeNull()
    expect(screen.getByLabelText('1 connected terminal').textContent).toBe('1')

    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))

    expect(await screen.findByText('Terminal connected')).toBeTruthy()
  })
})

describe('list version connection', () => {
  it('stays connected across unrelated rerenders', async () => {
    render(app)
    await screen.findByRole('button', { name: 'Submit rename' })
    await waitFor(() => expect(app.props.client.getQueryState(['session-pins'])?.status).toBe('success'))
    const connections = mocks.connectListVersions.mock.calls.length

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit rename' }))
    })

    await waitFor(() => expect(mocks.resolved).toHaveBeenCalledTimes(1))
    expect(mocks.connectListVersions).toHaveBeenCalledTimes(connections)
    expect(mocks.sessions).toHaveBeenCalledTimes(1)
  })

  it('refetches pins for a session activity version', async () => {
    render(app)
    await screen.findByRole('button', { name: 'Submit rename' })
    await waitFor(() => expect(app.props.client.getQueryState(['session-pins'])?.status).toBe('success'))
    const onEvent = mocks.connectListVersions.mock.calls.at(-1)?.[0]
    if (!onEvent) throw new Error('List version callback was not registered')
    const baseEvent: ListVersionsEvent = {
      epoch: '00000000-0000-4000-8000-000000000001',
      projectsVersion: 0,
      projectVersions: [],
      sessionVersions: [],
      subagentVersions: [],
      sessionChanges: [],
    }

    await act(async () => onEvent(baseEvent))
    await waitFor(() => expect(mocks.pins).toHaveBeenCalledTimes(2))

    await act(async () =>
      onEvent({
        ...baseEvent,
        projectVersions: [{ projectId: 'project', version: 1 }],
        sessionVersions: [{ projectId: 'project', sessionId: 'session', version: 'activity-v1' }],
      }),
    )
    await waitFor(() => expect(mocks.pins).toHaveBeenCalledTimes(3))
  })
})

describe('workspace header', () => {
  it('shows the complete project and session identity in a native tooltip', async () => {
    mocks.selection.mockReturnValue({
      selectedProjectId: 'project',
      selectedSessionId: 'session',
      projectList: [{ id: 'project', name: 'coconut' }],
      projectsQuery: {},
      selectedProjectSessionsQuery: { data: { sessions: [{ id: 'session', title: 'A long session title', lastActivityAt: 0 }], hasMore: false, nextCursor: null } },
      selectSession: mocks.selectSession,
    })

    window.history.replaceState(null, '', '/')
    render(app)

    await waitFor(() => expect(document.querySelector('.project-session-title')?.getAttribute('title')).toBe('coconut / A long session title'))
  })
})

describe('rename completion boundary', () => {
  it.each(['success', 'sessions failure', 'pins failure', 'rename failure'] as const)('keeps the authoritative rename outcome for %s', async (scenario) => {
    render(app)
    await screen.findByRole('button', { name: 'Submit rename' })
    await waitFor(() => expect(app.props.client.getQueryState(['session-pins'])?.status).toBe('success'))
    const failure = new Error(`${scenario}: request failed`)
    if (scenario === 'sessions failure') mocks.sessions.mockRejectedValue(failure)
    if (scenario === 'pins failure') mocks.pins.mockRejectedValue(failure)
    if (scenario === 'rename failure') mocks.rename.mockRejectedValue(failure)
    const pinCallsBeforeRename = mocks.pins.mock.calls.length

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit rename' }))
    })

    expect(mocks.rename).toHaveBeenCalledExactlyOnceWith('project', 'session', 'New title')
    if (scenario === 'rename failure') {
      await waitFor(() => expect(mocks.rejected).toHaveBeenCalledExactlyOnceWith(failure))
      expect(mocks.resolved).not.toHaveBeenCalled()
      expect(mocks.sessions).not.toHaveBeenCalled()
      expect(mocks.pins).toHaveBeenCalledTimes(pinCallsBeforeRename)
      expect(screen.getByRole('status').textContent).toBe(`Failed to rename session: ${failure.message}`)
    } else {
      await waitFor(() => expect(mocks.resolved).toHaveBeenCalledTimes(1))
      expect(mocks.rejected).not.toHaveBeenCalled()
      expect(mocks.sessions).toHaveBeenCalledWith([{ projectId: 'project', limit: 10 }])
      expect(mocks.pins).toHaveBeenCalledTimes(pinCallsBeforeRename + 1)
      expect(screen.getByRole('status').textContent).toBe(scenario === 'success' ? 'Session renamed' : 'Session renamed, but lists could not be refreshed.')
    }
  })
})
