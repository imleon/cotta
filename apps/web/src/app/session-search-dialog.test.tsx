// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ProjectSessionSearchResponse } from '@cotta/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { searchProjectSessionsMock } = vi.hoisted(() => ({ searchProjectSessionsMock: vi.fn() }))

vi.mock('../api', () => ({ searchProjectSessions: searchProjectSessionsMock }))

import { SessionSearchDialog } from './session-search-dialog'

const timestamp = new Date(2024, 0, 2, 3, 4).getTime()
const response: ProjectSessionSearchResponse = {
  query: 'needle',
  totalSessions: 2,
  totalMatches: 3,
  hasMore: true,
  nextCursor: 'cursor-2',
  results: [
    {
      project: { id: 'p1', name: 'Project' },
      session: { id: 's1', projectId: 'p1', title: 'Session', lastActivityAt: timestamp, occupiedBy: null, occupiedStatus: 'idle', kind: null },
      messageMatchCount: 3,
      truncatedMatches: true,
      matches: [
        { field: 'user', snippet: 'first needle', ranges: [{ start: 6, end: 12 }], messageTimestampMs: timestamp, locator: { turnId: 't1', messageUuid: 'm1', blockIndex: 1 } },
        { field: 'assistant', snippet: 'second needle', ranges: [{ start: 7, end: 13 }], locator: { turnId: 't2', messageUuid: 'm2', blockIndex: 2 } },
      ],
    },
  ],
}

function renderDialog(onSelect = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionSearchDialog open onClose={vi.fn()} onSelect={onSelect} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  searchProjectSessionsMock.mockReset().mockResolvedValue(response)
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  })
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => cleanup())

describe('SessionSearchDialog', () => {
  it('shows only message age and truncation guidance without source labels', async () => {
    renderDialog()
    await userEvent.type(screen.getByRole('searchbox'), 'needle')

    await screen.findByText((_, element) => Boolean(element?.classList.contains('session-search-snippet') && element.textContent === 'first needle'))
    const searchTitle = screen.getByText('Project').closest('.session-search-title')
    expect(searchTitle?.querySelector('.session-search-project-icon[aria-hidden="true"] > svg[data-icon="FolderOutlined"]')).toBeTruthy()
    expect(searchTitle?.querySelector('.session-search-project-name')?.textContent).toBe('Project')
    expect(screen.getByRole('button', { name: 'Load more results' })).toBeTruthy()
    expect(screen.getByText('More matches in this session. Refine your search.')).toBeTruthy()
    expect(screen.getAllByText('2y')).toHaveLength(1)
    expect(screen.queryByText('User')).toBeNull()
    expect(screen.queryByText('Assistant')).toBeNull()
    expect(screen.getByText('3 message matches in 2 sessions')).toBeTruthy()
    expect(screen.getAllByRole('option').map((option) => option.id)).toEqual(['s1:t1:m1:1', 's1:t2:m2:2'])
  })

  it('shows the matched metadata field in the result age position', async () => {
    searchProjectSessionsMock.mockResolvedValue({
      ...response,
      hasMore: false,
      nextCursor: null,
      results: [
        {
          ...response.results[0],
          truncatedMatches: false,
          matches: [
            { field: 'gitBranch', snippet: 'feature/needle', ranges: [{ start: 8, end: 14 }] },
            { field: 'cwd', snippet: '/work/needle', ranges: [{ start: 6, end: 12 }] },
          ],
        },
      ],
    })
    renderDialog()
    await userEvent.type(screen.getByRole('searchbox'), 'needle')

    const option = await screen.findByRole('option')
    expect(screen.getByText('Git branch').closest('.session-search-option')).toBe(option)
    expect(screen.getByText('Git branch').classList.contains('session-search-timestamp')).toBe(true)
    expect(screen.getByText('Git branch').classList.contains('session-search-tag')).toBe(true)
    expect(option.id).toBe('s1:metadata')
    expect(option.querySelector('.session-search-snippet')?.textContent).toBe('feature/needle')
    expect(screen.queryByText('/work/needle')).toBeNull()
  })

  it('keeps loaded results and offers retry when loading the next page fails', async () => {
    searchProjectSessionsMock.mockImplementation((_query: string, cursor: string | null) => (cursor === null ? Promise.resolve(response) : Promise.reject(new Error('network lost'))))
    renderDialog()
    await userEvent.type(screen.getByRole('searchbox'), 'needle')
    await screen.findAllByRole('option')

    await userEvent.click(screen.getByRole('button', { name: 'Load more results' }))

    await screen.findByRole('button', { name: 'Retry loading more results' })
    expect(screen.getAllByRole('option')).toHaveLength(2)
    expect(screen.queryByText('Search failed.')).toBeNull()
  })

  it('loads more sessions near the bottom while keeping current results visible', async () => {
    let resolveMore: ((value: ProjectSessionSearchResponse) => void) | undefined
    searchProjectSessionsMock.mockImplementation((_query: string, cursor: string | null) => {
      if (cursor === null) return Promise.resolve(response)
      return new Promise<ProjectSessionSearchResponse>((resolve) => {
        resolveMore = resolve
      })
    })
    renderDialog()
    await userEvent.type(screen.getByRole('searchbox'), 'needle')
    await screen.findAllByRole('option')
    expect(searchProjectSessionsMock).toHaveBeenCalledWith('needle', null)
    const results = screen.getByRole('listbox')
    Object.defineProperties(results, { scrollHeight: { value: 200 }, clientHeight: { value: 100 }, scrollTop: { value: 100, writable: true } })

    results.dispatchEvent(new Event('scroll', { bubbles: true }))

    await waitFor(() => expect(searchProjectSessionsMock).toHaveBeenCalledWith('needle', 'cursor-2'))
    expect(screen.getAllByRole('option')).toHaveLength(2)
    expect(screen.getByText('Loading…')).toBeTruthy()
    resolveMore?.({
      ...response,
      results: [{ ...response.results[0], session: { ...response.results[0].session, id: 's2' } }],
      hasMore: false,
      nextCursor: null,
    })
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull())
    expect(screen.getAllByRole('option')).toHaveLength(4)
    expect(screen.queryByRole('button', { name: 'Load more results' })).toBeNull()
  })

  it('replaces repeated sessions in their first position and keeps keyboard selection safe when results shrink', async () => {
    const other = {
      ...response.results[0],
      session: { ...response.results[0].session, id: 's2', title: 'Other session' },
      matches: [{ field: 'title' as const, snippet: 'Other needle', ranges: [] }],
      truncatedMatches: false,
    }
    const replacement = {
      ...response.results[0],
      project: { id: 'p-new', name: 'New project' },
      session: { ...response.results[0].session, projectId: 'p-new', title: 'Updated session' },
      matches: [{ field: 'title' as const, snippet: 'Updated needle', ranges: [] }],
      truncatedMatches: false,
    }
    searchProjectSessionsMock.mockImplementation((_query: string, cursor: string | null) =>
      Promise.resolve({
        ...response,
        results: cursor === null ? [response.results[0], other] : cursor === 'cursor-2' ? [replacement] : [],
        hasMore: cursor !== 'opaque-next',
        nextCursor: cursor === null ? 'cursor-2' : cursor === 'cursor-2' ? 'opaque-next' : null,
      }),
    )
    const onSelect = vi.fn()
    renderDialog(onSelect)
    const input = screen.getByRole('searchbox')
    await userEvent.type(input, 'needle')
    await screen.findAllByRole('option')
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(input.getAttribute('aria-activedescendant')).toBe('s2:metadata')

    await userEvent.click(screen.getByRole('button', { name: 'Load more results' }))

    await waitFor(() => expect(screen.getAllByRole('option').map((option) => option.id)).toEqual(['s1:metadata', 's2:metadata']))
    expect(screen.getAllByRole('region').map((group) => group.getAttribute('aria-label'))).toEqual(['Updated session', 'Other session'])
    expect(screen.queryByText('More matches in this session. Refine your search.')).toBeNull()
    expect(input.getAttribute('aria-activedescendant')).toBe('s2:metadata')
    await userEvent.click(input)
    await userEvent.keyboard('{Enter}')
    expect(onSelect).toHaveBeenLastCalledWith({ kind: 'metadata', result: other, id: 's2:metadata' })
    await userEvent.keyboard('{ArrowUp}{Enter}')
    expect(onSelect).toHaveBeenLastCalledWith({ kind: 'metadata', result: replacement, id: 's1:metadata' })
    const firstOption = screen.getByRole('option', { name: 'Updated needleTitle' })
    await userEvent.click(firstOption)
    expect(onSelect).toHaveBeenLastCalledWith({ kind: 'metadata', result: replacement })
    firstOption.focus()
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(onSelect).toHaveBeenLastCalledWith({ kind: 'metadata', result: other, id: 's2:metadata' })

    await userEvent.click(screen.getByRole('button', { name: 'Load more results' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more results' })).toBeNull())
    expect(searchProjectSessionsMock).toHaveBeenCalledWith('needle', 'cursor-2')
    expect(searchProjectSessionsMock).toHaveBeenCalledWith('needle', 'opaque-next')
  })

  it('only hides message timestamps, not metadata tags, in the mobile CSS rule', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8')
    const mobileRule = css.slice(css.indexOf('@media (max-width: 560px)'))
    expect(mobileRule).toMatch(/\n {2}time\.session-search-timestamp\s*\{\s*display: none;/)
    expect(mobileRule).not.toMatch(/\n {2}\.session-search-timestamp\s*\{\s*display: none;/)
  })

  it('starts a new cursor chain when the query changes', async () => {
    renderDialog()
    const input = screen.getByRole('searchbox')
    await userEvent.type(input, 'needle')
    await screen.findAllByRole('option')

    await userEvent.clear(input)
    await userEvent.type(input, 'other')

    await waitFor(() => expect(searchProjectSessionsMock).toHaveBeenCalledWith('other', null))
  })

  it('scrolls the keyboard-active result into view', async () => {
    renderDialog()
    const input = screen.getByRole('searchbox')
    await userEvent.type(input, 'needle')
    const options = await screen.findAllByRole('option')
    await waitFor(() => expect(options[0]?.getAttribute('aria-selected')).toBe('true'))
    vi.mocked(Element.prototype.scrollIntoView).mockClear()

    await userEvent.type(input, '{ArrowDown}')

    await waitFor(() => expect(options[1]?.getAttribute('aria-selected')).toBe('true'))
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.instances).toContain(options[1])
  })
})
