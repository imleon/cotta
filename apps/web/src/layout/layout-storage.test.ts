import { describe, expect, it } from 'vitest'
import { createArea, type SessionTab, splitPane } from './layout-model'
import { readWorkbenchLayout, WORKBENCH_LAYOUT_STORAGE_KEY, writeWorkbenchLayout } from './layout-storage'

function ids() {
  let next = 0
  return () => `n${++next}`
}

const session = (sessionId: string, id = `tab-${sessionId}`): SessionTab => ({ kind: 'session', id, machineId: 'm1', projectId: 'p1', sessionId })

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values }
}

function layouts() {
  const newId = ids()
  const single = createArea('main', session('s1'), newId)
  const main = splitPane(single, single.focusedPaneId, 'right', session('s2'), newId)
  if (!main) throw new Error('split failed')
  const tools = createArea('tools', { kind: 'files', id: 'files' }, newId)
  return { main, tools }
}

describe('workbench layout storage', () => {
  it('round-trips the main area, the tools area and whether tools are open', () => {
    const storage = memoryStorage()
    const { main, tools } = layouts()
    writeWorkbenchLayout({ main, tools, toolsOpen: true }, storage)
    expect(readWorkbenchLayout(storage)).toEqual({ main, tools, toolsOpen: true })
  })

  it('restores nothing from missing or unreadable storage', () => {
    const empty = { main: null, tools: null, toolsOpen: null }
    expect(readWorkbenchLayout(memoryStorage())).toEqual(empty)
    expect(readWorkbenchLayout(memoryStorage({ [WORKBENCH_LAYOUT_STORAGE_KEY]: '{not json' }))).toEqual(empty)
    expect(readWorkbenchLayout(null)).toEqual(empty)
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    expect(readWorkbenchLayout(throwing)).toEqual(empty)
    expect(() => writeWorkbenchLayout({ ...layouts(), toolsOpen: false }, throwing)).not.toThrow()
  })

  it('falls back per part: an invalid main area does not discard a valid tools area', () => {
    const { tools } = layouts()
    const storage = memoryStorage({ [WORKBENCH_LAYOUT_STORAGE_KEY]: JSON.stringify({ main: { kind: 'main', root: 'bad' }, tools, toolsOpen: 'yes' }) })
    expect(readWorkbenchLayout(storage)).toEqual({ main: null, tools, toolsOpen: null })
  })

  it('does not restore a main area that shows one session in two panes', () => {
    const newId = ids()
    const single = createArea('main', session('s1'), newId)
    const duplicated = splitPane(single, single.focusedPaneId, 'right', session('s1', 'other-tab'), newId)
    const storage = memoryStorage({ [WORKBENCH_LAYOUT_STORAGE_KEY]: JSON.stringify({ main: duplicated, tools: null, toolsOpen: false }) })
    expect(readWorkbenchLayout(storage).main).toBeNull()
  })
})
