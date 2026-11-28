// @vitest-environment jsdom

import type { SessionRuntimeResponse, SessionSummary } from '@cotta/shared'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type CottaApi, SessionRuntimeHttpError } from '../api'
import { MachineScopeProvider } from '../client/machine-scope'
import { SessionPane } from './session-pane'

vi.mock('./workspace-panel', () => ({
  WorkspacePanel: (props: { sessionRuntime: SessionRuntimeResponse | null; projectDirectoryUnavailable: boolean; timelineInstanceNonce: number }) => (
    <output data-runtime={props.sessionRuntime?.sessionId ?? ''} data-unavailable={String(props.projectDirectoryUnavailable)} data-nonce={String(props.timelineInstanceNonce)}>
      pane
    </output>
  ),
}))

afterEach(cleanup)

function runtime(sessionId: string): SessionRuntimeResponse {
  return { ok: true, projectId: 'p1', sessionId, settings: { permissionMode: 'default', model: null, effort: null }, initializationResult: null, contextUsage: null }
}

function summary(id: string, occupiedBy: SessionSummary['occupiedBy'] = null): SessionSummary {
  return { id, projectId: 'p1', title: id, occupiedBy, occupiedStatus: 'idle' } as SessionSummary
}

function deferredApi() {
  const calls: Array<{ sessionId: string; resolve: (value: SessionRuntimeResponse) => void; reject: (error: unknown) => void }> = []
  const ensureSessionRuntime = vi.fn(
    (sessionId: string) =>
      new Promise<SessionRuntimeResponse>((resolve, reject) => {
        calls.push({ sessionId, resolve, reject })
      }),
  )
  return { api: { ensureSessionRuntime } as unknown as CottaApi, calls, ensureSessionRuntime }
}

type PaneProps = ComponentProps<typeof SessionPane>

function pane(api: CottaApi, overrides: Partial<PaneProps>) {
  const props = { projectId: 'p1', selectedSessionId: 's1', selectedSession: summary('s1'), restartNonce: 0, ...overrides } as PaneProps
  return (
    <MachineScopeProvider scope={{ machineId: 'm1', api }}>
      <SessionPane {...props} />
    </MachineScopeProvider>
  )
}

function shown() {
  const element = screen.getByText('pane')
  return { runtime: element.getAttribute('data-runtime'), unavailable: element.getAttribute('data-unavailable'), nonce: element.getAttribute('data-nonce') }
}

describe('SessionPane', () => {
  it('never shows a runtime that arrives after the pane moved to another session', async () => {
    const { api, calls } = deferredApi()
    const view = render(pane(api, {}))
    view.rerender(pane(api, { selectedSessionId: 's2', selectedSession: summary('s2') }))

    await act(async () => calls[0]?.resolve(runtime('s1')))
    expect(shown().runtime).toBe('')
    await act(async () => calls[1]?.resolve(runtime('s2')))
    expect(shown().runtime).toBe('s2')
  })

  it('ensures the runtime again and remounts the Timeline after a restart', async () => {
    const { api, calls, ensureSessionRuntime } = deferredApi()
    const view = render(pane(api, {}))
    await act(async () => calls[0]?.resolve(runtime('s1')))
    expect(shown()).toMatchObject({ runtime: 's1', nonce: '0' })

    view.rerender(pane(api, { restartNonce: 1 }))
    expect(shown()).toMatchObject({ runtime: '', nonce: '1' })
    expect(ensureSessionRuntime).toHaveBeenCalledTimes(2)
    await act(async () => calls[1]?.resolve(runtime('s1')))
    expect(shown().runtime).toBe('s1')
  })

  it('holds no runtime for a session the CLI owns', () => {
    const { api, ensureSessionRuntime } = deferredApi()
    render(pane(api, { selectedSession: summary('s1', 'external') }))
    expect(ensureSessionRuntime).not.toHaveBeenCalled()
    expect(shown().runtime).toBe('')
  })

  it('reports an unavailable project directory only for the session that hit it', async () => {
    const { api, calls } = deferredApi()
    const view = render(pane(api, {}))
    await act(async () => calls[0]?.reject(new SessionRuntimeHttpError(409, 'project_directory_unavailable')))
    expect(shown().unavailable).toBe('true')

    view.rerender(pane(api, { selectedSessionId: 's2', selectedSession: summary('s2') }))
    expect(shown().unavailable).toBe('false')
  })
})
