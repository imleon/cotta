import { PROJECT_FILES_PANE_MIN_WIDTH } from './project-files-layout'

export const WORKSPACE_TIMELINE_MIN_WIDTH = 320
export const WORKSPACE_EXPLORER_DEFAULT_WIDTH = PROJECT_FILES_PANE_MIN_WIDTH
export const WORKSPACE_EXPLORER_MIN_WIDTH = PROJECT_FILES_PANE_MIN_WIDTH
export const WORKSPACE_EXPLORER_CLOSE_WIDTH = 240
export const WORKSPACE_EXPLORER_REQUIRED_WIDTH = WORKSPACE_TIMELINE_MIN_WIDTH + PROJECT_FILES_PANE_MIN_WIDTH

export function workspaceExplorerLayout(workspaceWidth: number): 'side' | 'overlay' {
  return workspaceWidth >= WORKSPACE_EXPLORER_REQUIRED_WIDTH ? 'side' : 'overlay'
}

export function workspaceExplorerWidthMax(workspaceWidth: number): number {
  return Math.max(0, workspaceWidth - WORKSPACE_TIMELINE_MIN_WIDTH)
}

export function clampWorkspaceExplorerWidth(width: number, workspaceWidth: number): number {
  const maxWidth = workspaceExplorerWidthMax(workspaceWidth)
  return Math.min(maxWidth, Math.max(Math.min(WORKSPACE_EXPLORER_MIN_WIDTH, maxWidth), width))
}
