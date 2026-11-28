import type { ReactNode } from 'react'
import { Group, type Layout, Panel, Separator } from 'react-resizable-panels'
import type { Area, LayoutNode, PaneNode } from './layout-model'

export type AreaViewProps = {
  area: Area
  /**
   * Renders one pane. The renderer owns the pane's own element (and its focus handling), so a single-pane area adds
   * no wrapper around it.
   */
  renderPane: (pane: PaneNode, state: { focused: boolean }) => ReactNode
  onSplitSizesChange: (splitId: string, sizes: number[]) => void
  /** Minimum pane size along a split, in pixels. */
  minPaneSize?: number
  className?: string
}

/**
 * Renders an area's pane tree. Splits become resizable panel groups; panes are delegated to `renderPane`. Shared by
 * Desktop and Web, so it touches nothing outside the tree it is given (no URL, no document title).
 */
export function AreaView({ area, renderPane, onSplitSizesChange, minPaneSize = 280, className }: AreaViewProps) {
  function node(current: LayoutNode): ReactNode {
    if (current.type === 'pane') return renderPane(current, { focused: current.id === area.focusedPaneId })
    const onLayoutChanged = (layout: Layout, meta: { isUserInteraction: boolean; requestedLayout?: Layout }) => {
      if (!meta.isUserInteraction) return
      const source = meta.requestedLayout ?? layout
      onSplitSizesChange(
        current.id,
        current.children.map((child) => source[child.id] ?? 0),
      )
    }
    return (
      <Group
        key={current.id}
        id={current.id}
        orientation={current.direction === 'row' ? 'horizontal' : 'vertical'}
        onLayoutChanged={onLayoutChanged}
        className="layout-split"
        data-direction={current.direction}
      >
        {current.children.flatMap((child, index) => [
          ...(index > 0 ? [<Separator key={`${child.id}:separator`} className="layout-separator" />] : []),
          <Panel key={child.id} id={child.id} defaultSize={String(current.sizes[index] ?? 100 / current.children.length)} minSize={minPaneSize} className="layout-panel">
            {node(child)}
          </Panel>,
        ])}
      </Group>
    )
  }

  return className && area.root.type === 'split' ? <div className={className}>{node(area.root)}</div> : node(area.root)
}
