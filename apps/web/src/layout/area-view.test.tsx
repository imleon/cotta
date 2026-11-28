// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AreaView } from './area-view'
import { createArea, type SessionTab, splitPane } from './layout-model'

beforeAll(() => {
  // jsdom has no layout engine; the panel library only needs these to exist.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(cleanup)

const session = (sessionId: string): SessionTab => ({ kind: 'session', id: `tab-${sessionId}`, machineId: 'm1', projectId: 'p1', sessionId })

function ids() {
  let next = 0
  return () => `n${++next}`
}

describe('AreaView', () => {
  it('keeps the existing pane mounted when the area splits', () => {
    const newId = ids()
    const mounts: string[] = []
    function Probe({ id }: { id: string }) {
      useEffect(() => {
        mounts.push(id)
      }, [id])
      return <section aria-label={id}>pane</section>
    }
    const single = createArea('main', session('s1'), newId)
    const split = splitPane(single, single.focusedPaneId, 'right', session('s2'), newId)
    if (!split) throw new Error('split failed')
    const render_ = (area: typeof single) => <AreaView area={area} onSplitSizesChange={vi.fn()} renderPane={(pane) => <Probe id={pane.id} />} />

    const view = render(render_(single))
    view.rerender(render_(split))

    expect(mounts).toEqual([single.focusedPaneId, split.focusedPaneId])
  })

  it('renders every pane of a split once, marking only the focused one', () => {
    const newId = ids()
    const base = createArea('main', session('s1'), newId)
    const split = splitPane(base, base.focusedPaneId, 'right', session('s2'), newId)
    if (!split) throw new Error('split failed')

    render(
      <AreaView
        area={split}
        onSplitSizesChange={vi.fn()}
        renderPane={(pane, { focused }) => (
          <section aria-label={(pane.tabs[0] as SessionTab).sessionId ?? ''} data-focused={focused ? 'true' : 'false'}>
            pane
          </section>
        )}
      />,
    )

    expect(screen.getByLabelText('s1').getAttribute('data-focused')).toBe('false')
    expect(screen.getByLabelText('s2').getAttribute('data-focused')).toBe('true')
    expect(screen.getAllByRole('separator')).toHaveLength(1)
  })
})
