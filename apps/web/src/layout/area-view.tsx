import type { ReactNode } from 'react'
import { Group, type Layout, Panel, Separator } from 'react-resizable-panels'
import type { Area, LayoutNode, PaneNode, SplitNode } from './layout-model'

export type AreaViewProps = {
  area: Area
  /**
   * Renders one pane. The renderer owns the pane's own element and its focus handling.
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
  function panel(child: LayoutNode, size: number) {
    return (
      <Panel key={child.id} id={child.id} defaultSize={String(size)} minSize={minPaneSize} className="layout-panel">
        {node(child)}
      </Panel>
    )
  }

  function group(current: SplitNode | PaneNode, key: string) {
    const children: LayoutNode[] = current.type === 'pane' ? [current] : current.children
    const sizes = current.type === 'pane' ? [100] : current.sizes
    const onLayoutChanged = (layout: Layout, meta: { isUserInteraction: boolean; requestedLayout?: Layout }) => {
      if (!meta.isUserInteraction || current.type !== 'split') return
      const source = meta.requestedLayout ?? layout
      onSplitSizesChange(
        current.id,
        current.children.map((child) => source[child.id] ?? 0),
      )
    }
    return (
      <Group
        key={key}
        id={`${area.kind}:${key}`}
        orientation={current.type === 'split' && current.direction === 'column' ? 'vertical' : 'horizontal'}
        onLayoutChanged={onLayoutChanged}
        className={className ? `layout-split ${className}` : 'layout-split'}
        data-direction={current.type === 'split' ? current.direction : 'row'}
      >
        {children.flatMap((child, index) => [...(index > 0 ? [<Separator key={`${child.id}:separator`} className="layout-separator" />] : []), panel(child, sizes[index] ?? 100 / children.length)])}
      </Group>
    )
  }

  function node(current: LayoutNode): ReactNode {
    return current.type === 'pane' ? renderPane(current, { focused: current.id === area.focusedPaneId }) : group(current, current.id)
  }

  // The root is always one group with a stable key, so a pane keeps its React identity (Timeline, drafts, scroll,
  // terminal connection) when the area goes from one pane to several side by side.
  return group(area.root, 'root')
}
