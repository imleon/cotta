// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShareManagementPanel } from './share-management-panel'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const renderPanel = (sharingEnabled: boolean) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ShareManagementPanel onOpenTurn={vi.fn()} sharingEnabled={sharingEnabled} />
    </QueryClientProvider>,
  )

describe('ShareManagementPanel', () => {
  it.each(['cotta', 'cli', 'sdk-ts', 'sdk-cli', 'other', '', undefined])('shows External in the existing source tag position only for non-cotta source %s', async (entrypoint) => {
    const share = {
      token: 'share-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      createdAtMs: Date.now(),
      projectName: 'Project',
      sessionTitle: 'Session title',
      promptPreview: 'Prompt preview',
      entrypoint,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ shares: [share], nextCursor: null }), { status: 200 }))),
    )
    const { container } = renderPanel(true)

    const title = await screen.findByText('Session title')
    const head = title.parentElement!
    expect(head.className).toBe('share-row-head')
    expect(head.parentElement?.className).toBe('share-row-text')
    expect(head.closest('button')?.className).toBe('share-row-link')
    expect(screen.queryByText('CLI')).toBeNull()
    if (entrypoint === 'cotta') {
      expect(screen.queryByText('External')).toBeNull()
      expect(container.querySelector('.share-row-source')).toBeNull()
    } else {
      const tag = screen.getByText('External')
      expect(tag.className).toBe('share-row-source')
      expect(tag.parentElement).toBe(head)
      expect(title.nextElementSibling).toBe(tag)
      expect(head.lastElementChild).toBe(tag)
      expect(container.querySelectorAll('.share-row-source')).toHaveLength(1)
    }
  })

  it('shows a suspended notice but still lists shares when sharing is off', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ shares: [], nextCursor: null }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    renderPanel(false)

    expect(screen.getByText(/Sharing is turned off/)).toBeTruthy()
    // The list is still fetched so the user can review and revoke suspended links.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/shares'))
  })

  it('lists shares without a notice when sharing is on', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ shares: [], nextCursor: null }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    renderPanel(true)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/shares'))
    expect(screen.queryByText(/Sharing is turned off/)).toBeNull()
  })
})
