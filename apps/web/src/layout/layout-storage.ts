import { type Area, panes, parseArea } from './layout-model'

/**
 * The workbench layout is remembered per browser tab (sessionStorage), so a reload brings the panes back while two
 * tabs keep independent layouts. Only the layout is stored; the URL still names just the focused pane's session.
 */
export const WORKBENCH_LAYOUT_STORAGE_KEY = 'cotta.workbench-layout'

export type StoredWorkbenchLayout = { main: Area | null; tools: Area | null; toolsOpen: boolean | null }

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function sessionStorageOrNull(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

/** A main area that shows one session in two panes breaks the one-pane-per-session rule; it is not restored. */
function sessionsUnique(area: Area): boolean {
  const ids = panes(area.root).flatMap((pane) => pane.tabs.flatMap((tab) => (tab.kind === 'session' && tab.sessionId ? [`${tab.machineId}\0${tab.sessionId}`] : [])))
  return new Set(ids).size === ids.length
}

/** Each part is restored on its own: a part that is missing or does not validate is null, and the caller uses its default. */
export function readWorkbenchLayout(storage: StorageLike | null = sessionStorageOrNull()): StoredWorkbenchLayout {
  const empty: StoredWorkbenchLayout = { main: null, tools: null, toolsOpen: null }
  let raw: string | null = null
  try {
    raw = storage?.getItem(WORKBENCH_LAYOUT_STORAGE_KEY) ?? null
  } catch {
    return empty
  }
  if (!raw) return empty
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return empty
  }
  if (!value || typeof value !== 'object') return empty
  const record = value as Record<string, unknown>
  const main = parseArea(record.main, 'main')
  return {
    main: main && sessionsUnique(main) ? main : null,
    tools: parseArea(record.tools, 'tools'),
    toolsOpen: typeof record.toolsOpen === 'boolean' ? record.toolsOpen : null,
  }
}

export function writeWorkbenchLayout(layout: { main: Area; tools: Area; toolsOpen: boolean }, storage: StorageLike | null = sessionStorageOrNull()): void {
  try {
    storage?.setItem(WORKBENCH_LAYOUT_STORAGE_KEY, JSON.stringify(layout))
  } catch {}
}
