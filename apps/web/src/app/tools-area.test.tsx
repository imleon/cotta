// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Area, addTab, createArea, focusedPane } from '../layout/layout-model'
import { ToolsArea } from './tools-area'

vi.mock('./project-files', () => ({
  ExplorerPanel: (props: { section: string; active: boolean; projectId: string | null }) => (
    <output aria-label={`explorer ${props.section}`} data-active={String(props.active)} data-project={props.projectId ?? ''} />
  ),
}))
vi.mock('./terminal-panel', () => ({
  TerminalPanel: (props: { open: boolean; onClose: () => void }) => (
    <button type="button" aria-label="terminal" data-open={String(props.open)} onClick={props.onClose}>
      terminal
    </button>
  ),
}))

afterEach(cleanup)

function ids() {
  let next = 0
  return () => `n${++next}`
}

function toolsArea(): Area {
  const newId = ids()
  const files = createArea('tools', { kind: 'files', id: 'files' }, newId)
  const changes = addTab(files, files.focusedPaneId, { kind: 'changes', id: 'changes' }) ?? files
  return addTab(changes, changes.focusedPaneId, { kind: 'terminal', id: 'term', machineId: 'm1', cwd: null }) ?? changes
}

function renderTools(area: Area, visible = true) {
  const onAreaChange = vi.fn()
  const view = render(<ToolsArea area={area} onAreaChange={onAreaChange} visible={visible} project={{ projectId: 'p1', currentCwd: null }} onTerminalConnectedChange={vi.fn()} />)
  return { onAreaChange, view }
}

describe('ToolsArea', () => {
  it('keeps every tab mounted and marks only the active one as live', () => {
    renderTools(toolsArea())

    expect(screen.getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('button', { name: 'terminal', hidden: true }).getAttribute('data-open')).toBe('true')
    // Hidden tabs stay mounted (their state survives) but pause their subscriptions.
    expect(screen.getByLabelText('explorer files', { selector: 'output' }).getAttribute('data-active')).toBe('false')
    expect(screen.getByLabelText('explorer changes', { selector: 'output' }).getAttribute('data-project')).toBe('p1')
  })

  it('pauses every tab while the area is collapsed', () => {
    renderTools(toolsArea(), false)
    expect(screen.getByRole('button', { name: 'terminal', hidden: true }).getAttribute('data-open')).toBe('false')
  })

  it('activates a tab on click and closes the terminal tab from its own close control', () => {
    const area = toolsArea()
    const { onAreaChange } = renderTools(area)

    fireEvent.click(screen.getByRole('tab', { name: 'Changes' }))
    expect(focusedPane(onAreaChange.mock.calls.at(-1)?.[0] as Area).activeTabId).toBe('changes')

    fireEvent.click(screen.getByRole('button', { name: 'terminal', hidden: true }))
    const closed = onAreaChange.mock.calls.at(-1)?.[0] as Area
    expect(focusedPane(closed).tabs.map((tab) => tab.kind)).toEqual(['files', 'changes'])
  })
})
