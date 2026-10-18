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
