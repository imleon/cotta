import { describe, expect, it } from 'vitest'
import {
  activateTab,
  addTab,
  closePane,
  closeTab,
  createArea,
  focusedPane,
  type LayoutTab,
  openSession,
  paneCount,
  panes,
  parseArea,
  replaceActiveTab,
  type SessionTab,
  setSplitSizes,
  splitPane,
} from './layout-model'

function ids() {
  let next = 0
  return () => `n${++next}`
}

const session = (sessionId: string | null, id = `tab-${sessionId}`): SessionTab => ({ kind: 'session', id, machineId: 'm1', projectId: 'p1', sessionId })
const terminal = (id: string): LayoutTab => ({ kind: 'terminal', id, machineId: 'm1', cwd: null })

function mainArea() {
  const newId = ids()
  return { newId, area: createArea('main', session('s1'), newId) }
}

describe('layout model', () => {
  it('keeps each area to its own tab kinds', () => {
    expect(() => createArea('main', terminal('t1'))).toThrow('cannot live in the main area')
    const { area, newId } = mainArea()
    expect(splitPane(area, area.focusedPaneId, 'right', terminal('t1'), newId)).toBeNull()
    expect(addTab(createArea('tools', { kind: 'files', id: 'f' }, newId), 'missing', session('s2'))).toBeNull()
  })

  it('splits beside a pane, joins a same-direction neighbour and focuses the new pane', () => {
    const { area, newId } = mainArea()
    const first = area.focusedPaneId
    const two = splitPane(area, first, 'right', session('s2'), newId)
    if (!two) throw new Error('split failed')
    expect(two.root).toMatchObject({ type: 'split', direction: 'row', sizes: [50, 50] })
    expect(focusedPane(two).tabs[0]).toMatchObject({ sessionId: 's2' })

    // Splitting the second pane to the right again stays one row: [s1 50, s2 25, s3 25].
    const three = splitPane(two, two.focusedPaneId, 'right', session('s3'), newId)
    expect(three?.root).toMatchObject({ type: 'split', direction: 'row', sizes: [50, 25, 25] })
    expect(panes(three?.root ?? area.root).map((p) => (p.tabs[0] as SessionTab).sessionId)).toEqual(['s1', 's2', 's3'])

    // A vertical split nests a column inside the row, the new pane above the target.
    const four = three && splitPane(three, first, 'top', session('s4'), newId)
    expect(four?.root).toMatchObject({ type: 'split', direction: 'row', children: [{ type: 'split', direction: 'column' }, { type: 'pane' }, { type: 'pane' }] })
    expect(panes(four?.root ?? area.root).map((p) => (p.tabs[0] as SessionTab).sessionId)).toEqual(['s4', 's1', 's2', 's3'])
  })

  it('stops at four panes in the main area', () => {
    const { area, newId } = mainArea()
    let current = area
    for (const id of ['s2', 's3', 's4']) current = splitPane(current, current.focusedPaneId, 'right', session(id), newId) ?? current
    expect(paneCount(current)).toBe(4)
    expect(splitPane(current, current.focusedPaneId, 'bottom', session('s5'), newId)).toBeNull()
    // Replacing in place is still allowed when full.
    expect(replaceActiveTab(current, current.focusedPaneId, session('s5'))).not.toBeNull()
  })

  it('opens a session already shown elsewhere by focusing that pane instead of duplicating it', () => {
    const { area, newId } = mainArea()
    const first = area.focusedPaneId
    const two = splitPane(area, first, 'right', session('s2'), newId)
    if (!two) throw new Error('split failed')

    const refocused = openSession(two, session('s1', 'another-tab-id'))
    expect(refocused.focusedPaneId).toBe(first)
    expect(paneCount(refocused)).toBe(2)

    const replaced = openSession(two, session('s3'))
    expect(panes(replaced.root).map((p) => (p.tabs[0] as SessionTab).sessionId)).toEqual(['s1', 's3'])
    expect(replaced.focusedPaneId).toBe(two.focusedPaneId)
  })

  it('closes a pane, gives its space to the neighbours and collapses single-child splits', () => {
    const { area, newId } = mainArea()
    const first = area.focusedPaneId
    const two = splitPane(area, first, 'right', session('s2'), newId)
    const three = two && splitPane(two, two.focusedPaneId, 'right', session('s3'), newId)
    if (!two || !three) throw new Error('split failed')

    const afterClose = closePane(three, two.focusedPaneId)
    expect(afterClose?.root.type).toBe('split')
    const sizes = afterClose?.root.type === 'split' ? afterClose.root.sizes : []
    expect(sizes[0]).toBeCloseTo(200 / 3)
    expect(sizes[1]).toBeCloseTo(100 / 3)
    const single = afterClose && closePane(afterClose, first)
    expect(single?.root).toMatchObject({ type: 'pane' })
    expect(single && closePane(single, single.focusedPaneId)).toBeNull()
    // Closing a pane that is not focused keeps the focus; closing the focused one moves it to a remaining pane.
    expect(afterClose?.focusedPaneId).toBe(three.focusedPaneId)
    expect(closePane(three, three.focusedPaneId)?.focusedPaneId).toBe(first)
  })

  it('manages tabs inside a tools pane and closes the pane with its last tab', () => {
    const newId = ids()
    const tools = createArea('tools', { kind: 'files', id: 'files' }, newId)
    const paneId = tools.focusedPaneId
    const withTerminals = addTab(addTab(tools, paneId, terminal('t1')) ?? tools, paneId, terminal('t2'))
    if (!withTerminals) throw new Error('add failed')
    expect(focusedPane(withTerminals).activeTabId).toBe('t2')

    const closedActive = closeTab(withTerminals, paneId, 't2')
    expect(closedActive && focusedPane(closedActive).activeTabId).toBe('t1')
    expect(activateTab(withTerminals, paneId, 'files').root).toMatchObject({ activeTabId: 'files' })
    const split = splitPane(withTerminals, paneId, 'bottom', terminal('t3'), newId)
    expect(split && closeTab(split, split.focusedPaneId, 't3')?.root).toMatchObject({ type: 'pane', id: paneId })
  })

  it('normalizes split sizes to percentages', () => {
    const { area, newId } = mainArea()
    const two = splitPane(area, area.focusedPaneId, 'right', session('s2'), newId)
    if (two?.root.type !== 'split') throw new Error('split failed')
    expect(setSplitSizes(two, two.root.id, [1, 3]).root).toMatchObject({ sizes: [25, 75] })
    expect(setSplitSizes(two, two.root.id, [1, 2, 3])).toBe(two)
  })
})

describe('parseArea', () => {
  it('round-trips a saved layout', () => {
    const { area, newId } = mainArea()
    const two = splitPane(area, area.focusedPaneId, 'bottom', session('s2'), newId)
    expect(parseArea(JSON.parse(JSON.stringify(two)), 'main')).toEqual(two)
  })

  it('rejects layouts this version cannot show instead of applying them partially', () => {
    const { area, newId } = mainArea()
    let full = area
    for (const id of ['s2', 's3', 's4']) full = splitPane(full, full.focusedPaneId, 'right', session(id), newId) ?? full
    const tooMany = JSON.parse(JSON.stringify(full)) as { root: { children: unknown[]; sizes: number[] } }
    tooMany.root.children.push({ type: 'pane', id: 'extra', tabs: [session('s5', 'extra-tab')], activeTabId: 'extra-tab' })
    tooMany.root.sizes.push(10)

    expect(parseArea(tooMany, 'main')).toBeNull()
    expect(parseArea({ ...area, focusedPaneId: 'missing' }, 'main')).toBeNull()
    expect(parseArea(area, 'tools')).toBeNull()
    expect(parseArea({ kind: 'main', root: { type: 'pane', id: 'p', tabs: [terminal('t')], activeTabId: 't' }, focusedPaneId: 'p' }, 'main')).toBeNull()
    expect(parseArea({ kind: 'main', root: { type: 'pane', id: 'p', tabs: [session('s1', 'p')], activeTabId: 'p' }, focusedPaneId: 'p' }, 'main')).toBeNull()
    expect(parseArea('not a layout', 'main')).toBeNull()
  })
})
