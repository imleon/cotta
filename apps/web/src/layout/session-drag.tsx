import { createContext, type DragEvent, type ReactNode, useContext, useState } from 'react'
import type { SplitSide } from './layout-model'

/** Drag payload type for a rail session dragged onto the main area. */
export const SESSION_DRAG_TYPE = 'application/x-cotta-session'

export type DraggedSession = { projectId: string; sessionId: string }

export function writeDraggedSession(event: DragEvent, session: DraggedSession): void {
  event.dataTransfer.setData(SESSION_DRAG_TYPE, JSON.stringify(session))
  event.dataTransfer.effectAllowed = 'copy'
}

function readDraggedSession(event: DragEvent): DraggedSession | null {
  try {
    const value = JSON.parse(event.dataTransfer.getData(SESSION_DRAG_TYPE)) as Partial<DraggedSession>
    return typeof value.projectId === 'string' && typeof value.sessionId === 'string' ? { projectId: value.projectId, sessionId: value.sessionId } : null
  } catch {
    return null
  }
}

function carriesSession(event: DragEvent): boolean {
  return [...event.dataTransfer.types].includes(SESSION_DRAG_TYPE)
}

/** Where a drop lands in a pane: one of the four edges opens a new pane there; the center replaces the pane's session. */
export type DropZone = SplitSide | 'center'

/** Edge bands take this fraction of the pane's width or height; the rest is the center. */
const EDGE_FRACTION = 0.25

export function dropZoneAt(rect: { left: number; top: number; width: number; height: number }, x: number, y: number, allowSides: boolean): DropZone {
  if (!allowSides || rect.width <= 0 || rect.height <= 0) return 'center'
  const fx = (x - rect.left) / rect.width
  const fy = (y - rect.top) / rect.height
  const distances: Array<[SplitSide, number]> = [
    ['left', fx],
    ['right', 1 - fx],
    ['top', fy],
    ['bottom', 1 - fy],
  ]
  const [side, distance] = distances.reduce((nearest, candidate) => (candidate[1] < nearest[1] ? candidate : nearest))
  return distance < EDGE_FRACTION ? side : 'center'
}

/**
 * Wraps a main-area pane so a rail session can be dropped on it. While a session is dragged over the pane it shows
 * the zone the drop would use; nothing changes until the drop. With `allowSides` false (the area is full) only the
 * center — replacing the pane's session — is offered.
 */
export function PaneDropTarget({ allowSides, onDropSession, children }: { allowSides: boolean; onDropSession: (zone: DropZone, session: DraggedSession) => void; children: ReactNode }) {
  const [zone, setZone] = useState<DropZone | null>(null)
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop target; the same action is available from the rail's "Open to the right" button
    <div
      className="pane-drop-target"
      onDragOver={(event) => {
        if (!carriesSession(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        const next = dropZoneAt(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY, allowSides)
        if (next !== zone) setZone(next)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setZone(null)
      }}
      onDrop={(event) => {
        const session = carriesSession(event) ? readDraggedSession(event) : null
        const target = dropZoneAt(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY, allowSides)
        setZone(null)
        if (!session) return
        event.preventDefault()
        onDropSession(target, session)
      }}
    >
      {children}
      {zone ? <div className="pane-drop-zone" data-zone={zone} aria-hidden="true" /> : null}
    </div>
  )
}

/**
 * What the rail needs from the main area: which sessions are open in panes, whether several panes are open (then
 * expanding a project in the rail only expands it, instead of also replacing the focused pane), and how to open a
 * session beside the focus.
 */
export type RailPanes = { openSessionIds: ReadonlySet<string>; split: boolean; canOpenInSplit: boolean; openInSplit: (session: DraggedSession) => void }

const RailPanesContext = createContext<RailPanes | null>(null)

export function RailPanesProvider({ value, children }: { value: RailPanes; children: ReactNode }) {
  return <RailPanesContext.Provider value={value}>{children}</RailPanesContext.Provider>
}

export function useRailPanes(): RailPanes | null {
  return useContext(RailPanesContext)
}
