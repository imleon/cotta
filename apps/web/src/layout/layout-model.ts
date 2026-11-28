import { z } from 'zod'

/**
 * Workbench layout model shared by Desktop and the new Web (see docs/next-generation/stage-3-decisions.md).
 *
 * The workbench has two areas built from the same pane tree: the main area holds only session Timelines; the tools
 * area holds Files, Changes, terminals and similar tools. A pane holds one or more typed tabs; a split arranges
 * panes in a row or a column. The model is pure data — rendering and persistence live elsewhere.
 */

export type AreaKind = 'main' | 'tools'

/** A session Timeline + Composer. `sessionId` is null for a new-session draft. */
export type SessionTab = { kind: 'session'; id: string; machineId: string; projectId: string | null; sessionId: string | null }
/** Views of the focused session's project: they follow the main area's focus. */
export type ProjectViewTab = { kind: 'files' | 'changes'; id: string }
/** An instance with a fixed target chosen at creation; never re-targeted by focus. `cwd` null is the machine's home. */
export type TerminalTab = { kind: 'terminal'; id: string; machineId: string; cwd: string | null }

export type LayoutTab = SessionTab | ProjectViewTab | TerminalTab
export type TabKind = LayoutTab['kind']

export const AREA_TAB_KINDS: Record<AreaKind, readonly TabKind[]> = { main: ['session'], tools: ['files', 'changes', 'terminal'] }
/** Beyond four panes a Timeline is too narrow to read or type into. */
export const AREA_MAX_PANES: Record<AreaKind, number> = { main: 4, tools: 4 }

export type PaneNode = { type: 'pane'; id: string; tabs: LayoutTab[]; activeTabId: string }
export type SplitNode = { type: 'split'; id: string; direction: 'row' | 'column'; children: LayoutNode[]; sizes: number[] }
export type LayoutNode = PaneNode | SplitNode
export type Area = { kind: AreaKind; root: LayoutNode; focusedPaneId: string }

/** Where a new pane goes relative to an existing one. */
export type SplitSide = 'left' | 'right' | 'top' | 'bottom'

export type IdFactory = () => string

let fallbackCounter = 0
export const defaultIdFactory: IdFactory = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `id-${++fallbackCounter}`)

function pane(tab: LayoutTab, newId: IdFactory): PaneNode {
  return { type: 'pane', id: newId(), tabs: [tab], activeTabId: tab.id }
}

function tabAllowed(kind: AreaKind, tab: LayoutTab): boolean {
  return AREA_TAB_KINDS[kind].includes(tab.kind)
}

export function createArea(kind: AreaKind, firstTab: LayoutTab, newId: IdFactory = defaultIdFactory): Area {
  if (!tabAllowed(kind, firstTab)) throw new Error(`A ${firstTab.kind} tab cannot live in the ${kind} area`)
  const root = pane(firstTab, newId)
  return { kind, root, focusedPaneId: root.id }
}

export function panes(node: LayoutNode): PaneNode[] {
  return node.type === 'pane' ? [node] : node.children.flatMap(panes)
}

export function paneCount(area: Area): number {
  return panes(area.root).length
}

export function findPane(area: Area, paneId: string): PaneNode | null {
  return panes(area.root).find((candidate) => candidate.id === paneId) ?? null
}

export function focusedPane(area: Area): PaneNode {
  return findPane(area, area.focusedPaneId) ?? (panes(area.root)[0] as PaneNode)
}

export function activeTab(node: PaneNode): LayoutTab {
  return node.tabs.find((tab) => tab.id === node.activeTabId) ?? (node.tabs[0] as LayoutTab)
}

/** The pane already showing `sessionId` on `machineId`, if any — a session appears in at most one pane. */
export function paneForSession(area: Area, machineId: string, sessionId: string): PaneNode | null {
  return panes(area.root).find((candidate) => candidate.tabs.some((tab) => tab.kind === 'session' && tab.machineId === machineId && tab.sessionId === sessionId)) ?? null
}

export function focusPane(area: Area, paneId: string): Area {
  return findPane(area, paneId) && area.focusedPaneId !== paneId ? { ...area, focusedPaneId: paneId } : area
}

function mapNode(node: LayoutNode, update: (node: LayoutNode) => LayoutNode | null): LayoutNode | null {
  const updated = update(node)
  if (updated !== node || node.type === 'pane') return updated
  const children = node.children.map((child) => mapNode(child, update))
  if (children.every((child, index) => child === node.children[index])) return node
  return normalizeSplit({ ...node, children: children.filter((child): child is LayoutNode => child !== null) }, node.children, children)
}

/** Drops removed children (giving their space to the neighbours) and collapses a split left with one child. */
function normalizeSplit(split: SplitNode, before: LayoutNode[], after: Array<LayoutNode | null>): LayoutNode | null {
  const sizes = before.map((_, index) => (after[index] ? (split.sizes[index] ?? 0) : 0))
  const keptSizes = sizes.filter((_, index) => after[index] !== null)
  if (split.children.length === 0) return null
  if (split.children.length === 1) return split.children[0] as LayoutNode
  return { ...split, sizes: rescale(keptSizes) }
}

function rescale(sizes: number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0)
  return total > 0 ? sizes.map((size) => (size / total) * 100) : sizes.map(() => 100 / sizes.length)
}

/**
 * Opens `tab` in a new pane beside `targetPaneId` and focuses it. A neighbour in the same direction joins the existing
 * split (the target gives up half its space); otherwise the target becomes a two-way split. Returns null when the
 * area is full, the tab kind does not belong in this area, or the target does not exist.
 */
export function splitPane(area: Area, targetPaneId: string, side: SplitSide, tab: LayoutTab, newId: IdFactory = defaultIdFactory): Area | null {
  if (!tabAllowed(area.kind, tab) || paneCount(area) >= AREA_MAX_PANES[area.kind] || !findPane(area, targetPaneId)) return null
  const created = pane(tab, newId)
  const direction = side === 'left' || side === 'right' ? 'row' : 'column'
  const before = side === 'left' || side === 'top'

  function insert(node: LayoutNode): LayoutNode {
    if (node.type === 'pane') {
      if (node.id !== targetPaneId) return node
      return { type: 'split', id: newId(), direction, children: before ? [created, node] : [node, created], sizes: [50, 50] }
    }
    const index = node.children.findIndex((child) => child.type === 'pane' && child.id === targetPaneId)
    if (index >= 0 && node.direction === direction) {
      const half = (node.sizes[index] ?? 0) / 2
      const children = [...node.children]
      const sizes = [...node.sizes]
      children.splice(before ? index : index + 1, 0, created)
      sizes.splice(index, 1, half, half)
      return { ...node, children, sizes }
    }
    return { ...node, children: node.children.map(insert) }
  }

  return { ...area, root: insert(area.root), focusedPaneId: created.id }
}

/** Replaces the active tab of a pane (the "center" drop, or a plain rail click on the focused pane) and focuses it. */
export function replaceActiveTab(area: Area, paneId: string, tab: LayoutTab): Area | null {
  if (!tabAllowed(area.kind, tab) || !findPane(area, paneId)) return null
  const root = mapNode(area.root, (node) => {
    if (node.type !== 'pane' || node.id !== paneId) return node
    return { ...node, tabs: node.tabs.map((existing) => (existing.id === node.activeTabId ? tab : existing)), activeTabId: tab.id }
  })
  return root ? { ...area, root, focusedPaneId: paneId } : null
}

/**
 * Shows a session in the main area following the one-pane-per-session rule: a session already open elsewhere gets
 * focus instead of a second copy; otherwise it replaces the focused pane's session.
 */
export function openSession(area: Area, tab: SessionTab): Area {
  if (tab.sessionId) {
    const existing = paneForSession(area, tab.machineId, tab.sessionId)
    if (existing) return focusPane(area, existing.id)
  }
  return replaceActiveTab(area, area.focusedPaneId, tab) ?? area
}

/** Closes a pane; its neighbours take its space. The last pane cannot be closed (null). */
export function closePane(area: Area, paneId: string): Area | null {
  if (paneCount(area) <= 1 || !findPane(area, paneId)) return null
  const root = mapNode(area.root, (node) => (node.type === 'pane' && node.id === paneId ? null : node))
  if (!root) return null
  const remaining = panes(root)
  const focusedPaneId = area.focusedPaneId === paneId ? (remaining[0] as PaneNode).id : area.focusedPaneId
  return { ...area, root, focusedPaneId }
}

export function setSplitSizes(area: Area, splitId: string, sizes: number[]): Area {
  const root = mapNode(area.root, (node) => {
    if (node.type !== 'split' || node.id !== splitId || sizes.length !== node.children.length) return node
    return { ...node, sizes: rescale(sizes) }
  })
  return root && root !== area.root ? { ...area, root } : area
}

export function addTab(area: Area, paneId: string, tab: LayoutTab): Area | null {
  if (!tabAllowed(area.kind, tab) || !findPane(area, paneId)) return null
  const root = mapNode(area.root, (node) => (node.type === 'pane' && node.id === paneId ? { ...node, tabs: [...node.tabs, tab], activeTabId: tab.id } : node))
  return root ? { ...area, root } : null
}

export function activateTab(area: Area, paneId: string, tabId: string): Area {
  const root = mapNode(area.root, (node) => (node.type === 'pane' && node.id === paneId && node.tabs.some((tab) => tab.id === tabId) ? { ...node, activeTabId: tabId } : node))
  return root && root !== area.root ? { ...area, root } : area
}

/** Closes a tab; closing a pane's last tab closes the pane (null when that is the area's last pane). */
export function closeTab(area: Area, paneId: string, tabId: string): Area | null {
  const target = findPane(area, paneId)
  if (!target?.tabs.some((tab) => tab.id === tabId)) return area
  if (target.tabs.length === 1) return closePane(area, paneId)
  const root = mapNode(area.root, (node) => {
    if (node.type !== 'pane' || node.id !== paneId) return node
    const index = node.tabs.findIndex((tab) => tab.id === tabId)
    const tabs = node.tabs.filter((tab) => tab.id !== tabId)
    const activeTabId = node.activeTabId === tabId ? (tabs[Math.min(index, tabs.length - 1)] as LayoutTab).id : node.activeTabId
    return { ...node, tabs, activeTabId }
  })
  return root ? { ...area, root } : null
}

// ---- Persistence (P4: layouts are saved locally and restored on reload) ----

const tabSchema: z.ZodType<LayoutTab> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), id: z.string().min(1), machineId: z.string().min(1), projectId: z.string().nullable(), sessionId: z.string().nullable() }),
  z.strictObject({ kind: z.enum(['files', 'changes']), id: z.string().min(1) }),
  z.strictObject({ kind: z.literal('terminal'), id: z.string().min(1), machineId: z.string().min(1), cwd: z.string().nullable() }),
])

const nodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    z.strictObject({ type: z.literal('pane'), id: z.string().min(1), tabs: z.array(tabSchema).min(1), activeTabId: z.string().min(1) }),
    z.strictObject({ type: z.literal('split'), id: z.string().min(1), direction: z.enum(['row', 'column']), children: z.array(nodeSchema).min(2), sizes: z.array(z.number().nonnegative()) }),
  ]),
)

const areaSchema = z.strictObject({ kind: z.enum(['main', 'tools']), root: nodeSchema, focusedPaneId: z.string().min(1) })

function nodeIds(node: LayoutNode): string[] {
  return node.type === 'pane' ? [node.id, ...node.tabs.map((tab) => tab.id)] : [node.id, ...node.children.flatMap(nodeIds)]
}

function nodeValid(kind: AreaKind, node: LayoutNode): boolean {
  if (node.type === 'pane') return node.tabs.every((tab) => tabAllowed(kind, tab)) && node.tabs.some((tab) => tab.id === node.activeTabId)
  return node.sizes.length === node.children.length && node.children.every((child) => nodeValid(kind, child))
}

/**
 * Restores a saved area, or null when the saved value is not a layout this version can show (malformed, a tab kind
 * not allowed in the area, too many panes, duplicate ids, or a focus on a missing pane). The caller then starts from
 * its explicit default layout; a saved layout is never partially applied.
 */
export function parseArea(value: unknown, expectedKind: AreaKind): Area | null {
  const parsed = areaSchema.safeParse(value)
  if (!parsed.success || parsed.data.kind !== expectedKind) return null
  const area = parsed.data as Area
  const ids = nodeIds(area.root)
  const valid = nodeValid(area.kind, area.root) && paneCount(area) <= AREA_MAX_PANES[area.kind] && new Set(ids).size === ids.length && findPane(area, area.focusedPaneId) !== null
  return valid ? area : null
}
