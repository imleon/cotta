// @vitest-environment jsdom

import type { ShareListResponse } from '@cotta/shared'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShareManagementPanel } from '../app/share-management-panel'
import { createMachineScope, MachineScopeProvider, SAME_ORIGIN_MACHINE_ID, useMachineScope } from './machine-scope'
import type { CottaTransport } from './transport'

afterEach(cleanup)

/** Both machines hold a share for the same project path and session id; only the title tells them apart. */
function shares(title: string): ShareListResponse {
  return {
    shares: [{ token: `token-${title}`, projectId: 'L3NyYy9hcHA', sessionId: '10000000-0000-4000-8000-000000000001', turnId: 'turn-1', createdAtMs: 0, sessionTitle: title }],
    nextCursor: null,
  }
}

/** A transport for one machine whose responses the test releases explicitly. */
function machineTransport() {
  const calls: string[] = []
  const pending: Array<{ path: string; resolve: (response: Response) => void }> = []
  const transport: CottaTransport = {
    fetch: (path) => {
      calls.push(path)
      return new Promise<Response>((resolve) => pending.push({ path, resolve }))
    },
    eventSource: () => {
      throw new Error('no event streams in this test')
    },
    webSocket: () => {
      throw new Error('no sockets in this test')
    },
    resolveUrl: (path) => path,
  }
  const respond = (response: Response) => {
    const next = pending.shift()
    if (!next) throw new Error('no request waiting')
    next.resolve(response)
  }
  return { transport, calls, respond, waiting: () => pending.length }
}

function twoMachines() {
  const a = machineTransport()
  const b = machineTransport()
  const scopeA = createMachineScope('m_a', a.transport)
  const scopeB = createMachineScope('m_b', b.transport)
  scopeA.queryClient.setDefaultOptions({ queries: { retry: false } })
  scopeB.queryClient.setDefaultOptions({ queries: { retry: false } })
  render(
    <>
      <section aria-label="machine A">
        <MachineScopeProvider scope={scopeA}>
          <ShareManagementPanel onOpenTurn={vi.fn()} sharingEnabled />
        </MachineScopeProvider>
      </section>
      <section aria-label="machine B">
        <MachineScopeProvider scope={scopeB}>
          <ShareManagementPanel onOpenTurn={vi.fn()} sharingEnabled />
        </MachineScopeProvider>
      </section>
    </>,
  )
  return { a, b, paneA: () => within(screen.getByRole('region', { name: 'machine A' })), paneB: () => within(screen.getByRole('region', { name: 'machine B' })) }
}

describe('machine scopes', () => {
  it('keep identical project paths, session ids and query keys apart', async () => {
    const { a, b, paneA, paneB } = twoMachines()
    await waitFor(() => expect(a.waiting() + b.waiting()).toBe(2))

    a.respond(Response.json(shares('From A')))
    b.respond(Response.json(shares('From B')))

    expect(await paneA().findByText('From A')).toBeTruthy()
    expect(await paneB().findByText('From B')).toBeTruthy()
    expect(paneA().queryByText('From B')).toBeNull()
    expect(paneB().queryByText('From A')).toBeNull()
    expect(a.calls).toEqual(['/api/shares'])
    expect(b.calls).toEqual(['/api/shares'])
  })

  it('lands a slow response only in the machine that was asked', async () => {
    const { a, b, paneA, paneB } = twoMachines()
    await waitFor(() => expect(a.waiting() + b.waiting()).toBe(2))

    // B answers first; A's slow answer arrives afterwards and must not overwrite B.
    b.respond(Response.json(shares('From B')))
    expect(await paneB().findByText('From B')).toBeTruthy()
    a.respond(Response.json(shares('Slow A')))

    expect(await paneA().findByText('Slow A')).toBeTruthy()
    expect(paneB().getByText('From B')).toBeTruthy()
    expect(paneB().queryByText('Slow A')).toBeNull()
  })

  it('confines a revoked machine to its own pane', async () => {
    const { a, b, paneA, paneB } = twoMachines()
    await waitFor(() => expect(a.waiting() + b.waiting()).toBe(2))

    a.respond(Response.json({ error: 'unauthorized' }, { status: 401 }))
    b.respond(Response.json(shares('From B')))

    expect(await paneB().findByText('From B')).toBeTruthy()
    expect(paneA().queryByText('From B')).toBeNull()
    expect(paneA().queryByText('No active shares.')).toBeNull()
  })

  it('defaults to the page’s own daemon outside any provider', () => {
    function Probe() {
      return <span>{useMachineScope().machineId}</span>
    }
    render(<Probe />)
    expect(screen.getByText(SAME_ORIGIN_MACHINE_ID)).toBeTruthy()
  })
})
