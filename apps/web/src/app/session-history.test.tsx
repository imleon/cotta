// @vitest-environment jsdom

import type { ProjectSessionsResponse, ProjectSummary, SessionSummary } from '@cotta/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchProjectSessionsMock } = vi.hoisted(() => ({ fetchProjectSessionsMock: vi.fn() }))

vi.mock('../api', () => ({
  fetchProjectSessions: fetchProjectSessionsMock,
  fetchProjects: vi.fn(),
  queryProjectSessions: vi.fn(),
  PaginationCursorStaleError: class PaginationCursorStaleError extends Error {},
}))

import { ProjectSessionRail } from './session-history'

const project = (id: string, name = id): ProjectSummary => ({ id, name })
const session = (id: string, projectId = 'p1'): SessionSummary => ({ id, projectId, title: id, occupiedBy: null, occupiedStatus: 'idle', kind: null })

function page(sessions: SessionSummary[], hasMore = false): ProjectSessionsResponse {
  return { project: project('p1', 'P1'), sessions, defaultSessionId: sessions[0]?.id ?? null, hasMore, nextCursor: null }
}

function renderRail(props: Partial<Parameters<typeof ProjectSessionRail>[0]> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ProjectSessionRail
        projects={[project('p1', 'P1')]}
        pins={[]}
        selectedProjectId="p1"
        selectedSessionId="s1"
        visibleSessionStates={{}}
        onSelectProject={vi.fn()}
        onSelectSession={vi.fn()}
        onSessionCursorStale={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  fetchProjectSessionsMock.mockReset()
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => cleanup())

describe('ProjectSessionRail', () => {
  it('shows Restart only for the selected session with a runtime', async () => {
    fetchProjectSessionsMock.mockResolvedValue(
      page([
        { ...session('s1'), hasRuntime: true },
        { ...session('s2'), hasRuntime: true },
      ]),
    )
    const onRestartSession = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()

    renderRail({ onRestartSession })

    await user.click(await screen.findByLabelText('More actions for s1'))
    await user.click(screen.getByRole('menuitem', { name: 'Restart' }))
    expect(onRestartSession).toHaveBeenCalledWith('s1')
    await user.click(screen.getByLabelText('More actions for s2'))
    expect(screen.queryByRole('menuitem', { name: 'Restart' })).toBeNull()
  })

  it('shows and scrolls to a highlighted session outside the first rail window without chasing pagination', async () => {
    const firstPage = Array.from({ length: 10 }, (_, index) => session(`s${index + 1}`))
    fetchProjectSessionsMock.mockResolvedValue(page(firstPage, true))
    const onHighlightedSessionSeen = vi.fn()

    const { container } = renderRail({
      selectedSessionId: 's15',
      selectedSessionSummary: session('s15'),
      highlightedSession: { projectId: 'p1', sessionId: 's15' },
      onHighlightedSessionSeen,
    })

    await waitFor(() => expect(container.querySelectorAll('[data-session-id]')).toHaveLength(11))
    const row = container.querySelector<HTMLButtonElement>('[data-session-id="s15"]')!
    expect(fetchProjectSessionsMock.mock.calls.map(([, , limit]) => limit)).toEqual([10])
    expect([...container.querySelectorAll('[data-session-id]')].map((item) => item.getAttribute('data-session-id'))).toEqual([...firstPage.map(({ id }) => id), 's15'])
    expect(row.className).toContain('highlighted')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(onHighlightedSessionSeen).toHaveBeenCalledTimes(1)
  })

  it('renders and expands selected project context outside the project pages', async () => {
    fetchProjectSessionsMock.mockResolvedValue({ ...page([], false), project: project('p2', 'P2') })

    renderRail({
      projects: [project('p1', 'P1')],
      selectedProjectId: 'p2',
      selectedSessionId: 's2',
      selectedProjectContext: project('p2', 'P2'),
      selectedSessionSummary: session('s2', 'p2'),
      highlightedSession: { projectId: 'p2', sessionId: 's2' },
    })

    expect(await screen.findByRole('button', { name: /Collapse P2 sessions/ })).toBeTruthy()
    expect(document.querySelector('[data-session-id="s2"]')).toBeTruthy()
  })

  it('deduplicates the selected row when a later window reaches it', async () => {
    const firstPage = Array.from({ length: 10 }, (_, index) => session(`s${index + 1}`))
    fetchProjectSessionsMock.mockImplementation((_projectId: string, _cursor: string | null, limit: number) =>
      Promise.resolve(page(limit > 10 ? [...firstPage, session('s15')] : firstPage, limit <= 10)),
    )

    const { container } = renderRail({ selectedSessionId: 's15', selectedSessionSummary: session('s15') })
    await waitFor(() => expect(container.querySelectorAll('[data-session-id]')).toHaveLength(11))
    await userEvent.click(screen.getByRole('button', { name: 'Show more sessions for P1' }))
    await waitFor(() => expect(fetchProjectSessionsMock).toHaveBeenLastCalledWith('p1', null, 20))

    expect(container.querySelectorAll('[data-session-id="s15"]')).toHaveLength(1)
  })

  it.each([
    ['success', 'status-success', 'Cotta completed'],
    ['error', 'status-danger', 'Cotta failed'],
  ] as const)('renders a %s completed Cotta turn with its status color', async (lastTurnOutcome, className, label) => {
    fetchProjectSessionsMock.mockResolvedValue(page([{ ...session('s1'), occupiedBy: 'cotta', lastTurnOutcome }]))
    const { container } = renderRail({ selectedSessionId: 's2' })

    await screen.findByLabelText(label)
    const badge = container.querySelector('.status-badge')!
    expect(badge.className).toContain(className)
    expect(badge.getAttribute('aria-label')).toBe(label)
  })

  it('renders task-only Cotta runtime as background with the busy status class', async () => {
    fetchProjectSessionsMock.mockResolvedValue(page([{ ...session('s1'), occupiedBy: 'cotta', occupiedStatus: 'background' }]))
    const { container } = renderRail({ selectedSessionId: 's2' })

    await screen.findByLabelText('Cotta background')
    expect(container.querySelector('.status-badge')?.className).toContain('status-cotta-background')
  })

  it('keeps a selected completed session visibly completed until the list refreshes', async () => {
    fetchProjectSessionsMock.mockResolvedValue(page([{ ...session('s1'), occupiedBy: 'cotta', lastTurnOutcome: 'success' }]))
    const { container } = renderRail()

    await screen.findByLabelText('Cotta completed')
    expect(container.querySelector('.status-badge')?.className).toContain('status-success')
  })
})
