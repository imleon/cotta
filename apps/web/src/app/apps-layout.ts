import { APP_LAYOUT_GAP, APP_SIDEBAR_MIN_WIDTH } from './app-layout'
import { WORKSPACE_EXPLORER_REQUIRED_WIDTH } from './workspace-explorer-layout'

export const TOOL_PANEL_MIN_WIDTH = 240
export const TOOL_PANEL_MIN_HEIGHT = 160
export const WORKSPACE_GROUP_MIN_WIDTH = 320
export const WORKSPACE_GROUP_MIN_HEIGHT = 240
const WORKSPACE_GROUP_BORDER_WIDTH = 2
export const PANEL_RESIZE_HANDLE_SIZE = 9

export type ToolLayout = 'side' | 'bottom'

type AppsLayoutInput = {
  shellWidth: number
  requestedSidebarWidth: number
  explorerOpen: boolean
  toolOpen: boolean
  requestedToolWidth: number
  minimumAppsWidth?: number
}

function workspaceWidth(explorerOpen: boolean): number {
  return (explorerOpen ? WORKSPACE_EXPLORER_REQUIRED_WIDTH : WORKSPACE_GROUP_MIN_WIDTH) + WORKSPACE_GROUP_BORDER_WIDTH
}

export function terminalWidthMax(appsWidth: number, explorerOpen: boolean): number {
  return Math.max(TOOL_PANEL_MIN_WIDTH, appsWidth - workspaceWidth(explorerOpen) - PANEL_RESIZE_HANDLE_SIZE)
}

export function terminalHeightMax(shellHeight: number): number | null {
  return shellHeight > 0 ? Math.max(TOOL_PANEL_MIN_HEIGHT, shellHeight - WORKSPACE_GROUP_MIN_HEIGHT - PANEL_RESIZE_HANDLE_SIZE) : null
}

export function appsLayout(input: AppsLayoutInput): { sidebarWidth: number; appsWidth: number; toolLayout: ToolLayout; toolWidth: number } {
  const requiredWorkspaceWidth = workspaceWidth(input.explorerOpen)
  const sideWidth = requiredWorkspaceWidth + PANEL_RESIZE_HANDLE_SIZE + TOOL_PANEL_MIN_WIDTH
  const requestedSidebarWidth = Math.max(APP_SIDEBAR_MIN_WIDTH, input.requestedSidebarWidth)
  const requiredAppsWidth = input.toolOpen ? sideWidth : (input.minimumAppsWidth ?? WORKSPACE_GROUP_MIN_WIDTH)
  const sidebarWidth = input.shellWidth - requestedSidebarWidth - APP_LAYOUT_GAP < requiredAppsWidth ? APP_SIDEBAR_MIN_WIDTH : requestedSidebarWidth
  const appsWidth = Math.max(0, input.shellWidth - sidebarWidth - APP_LAYOUT_GAP)
  if (!input.toolOpen) return { sidebarWidth, appsWidth, toolLayout: 'side', toolWidth: 0 }
  if (appsWidth >= sideWidth) return { sidebarWidth, appsWidth, toolLayout: 'side', toolWidth: Math.min(input.requestedToolWidth, terminalWidthMax(appsWidth, input.explorerOpen)) }
  return { sidebarWidth, appsWidth, toolLayout: 'bottom', toolWidth: TOOL_PANEL_MIN_WIDTH }
}
