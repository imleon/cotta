import { useState } from 'react'
import { AreaView } from '../layout/area-view'
import { type Area, activateTab, closeTab, focusPane, type LayoutTab, type PaneNode, setSplitSizes } from '../layout/layout-model'
import { ExplorerPanel, type ProjectFileTabs } from './project-files'
import { TerminalPanel } from './terminal-panel'

/** The focused session's project; view tools (Files, Changes) follow it. */
export type ToolsProjectContext = { projectId: string | null; projectName?: string; currentCwd: string | null }

const TAB_LABEL: Record<LayoutTab['kind'], string> = { session: 'Session', files: 'Files', changes: 'Changes', terminal: 'Terminal' }

/**
 * The tools area: tool tabs in panes of the shared layout engine. View tools follow the main area's focused project;
 * instance tools keep the target they were opened with. Every tab stays mounted while the area exists (inactive ones
 * are hidden and pause their subscriptions), so switching tabs or collapsing the area never drops a terminal session.
 */
export function ToolsArea({
  area,
  onAreaChange,
  visible,
  project,
  onTerminalConnectedChange,
}: {
  area: Area
  /** `null` when the last tab was closed. */
  onAreaChange: (area: Area | null) => void
  visible: boolean
  project: ToolsProjectContext
  onTerminalConnectedChange: (connected: boolean) => void
}) {
  // Open-file tabs per project, shared by the Files and Changes views.
  const [openFiles, setOpenFiles] = useState<ProjectFileTabs>({})

  function renderTab(pane: PaneNode, tab: LayoutTab, active: boolean) {
    const shown = visible && active
    switch (tab.kind) {
      case 'files':
      case 'changes':
        return (
          <ExplorerPanel
            projectId={project.projectId}
            projectName={project.projectName}
            currentCwd={project.currentCwd}
            openFiles={openFiles}
            onOpenFilesChange={setOpenFiles}
            previewWidth={null}
            onPreviewLayoutChange={() => {}}
            onFilesLayoutChange={() => {}}
            section={tab.kind}
            active={shown}
          />
        )
      case 'terminal':
        return <TerminalPanel className="terminal-panel" open={shown} onClose={() => onAreaChange(closeTab(area, pane.id, tab.id))} onConnectedChange={onTerminalConnectedChange} />
      default:
        return null
    }
  }

  return (
    <AreaView
      area={area}
      minPaneSize={160}
      onSplitSizesChange={(splitId, sizes) => onAreaChange(setSplitSizes(area, splitId, sizes))}
      renderPane={(pane, { focused }) => (
        <section className="tools-pane" data-focused={focused ? 'true' : 'false'} onPointerDownCapture={() => onAreaChange(focusPane(area, pane.id))}>
          <div className="tools-tabbar" role="tablist" aria-label="Tools">
            {pane.tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                className="tools-tab"
                aria-selected={tab.id === pane.activeTabId}
                aria-controls={`tools-tab-${tab.id}`}
                onClick={() => onAreaChange(activateTab(area, pane.id, tab.id))}
              >
                {TAB_LABEL[tab.kind]}
              </button>
            ))}
          </div>
          {pane.tabs.map((tab) => (
            <div key={tab.id} id={`tools-tab-${tab.id}`} role="tabpanel" className="tools-tab-body" hidden={tab.id !== pane.activeTabId}>
              {renderTab(pane, tab, tab.id === pane.activeTabId)}
            </div>
          ))}
        </section>
      )}
    />
  )
}
