import { APP_LAYOUT_GAP, APP_SIDEBAR_MIN_WIDTH } from './app-layout'

/** Narrowest main area (one session pane) that still reads and types. */
export const MAIN_AREA_MIN_WIDTH = 320
/** Narrowest tools area. */
export const TOOLS_AREA_MIN_WIDTH = 280
export const PANEL_RESIZE_HANDLE_SIZE = 9

type AppsLayoutInput = {
  shellWidth: number
  requestedSidebarWidth: number
  toolsOpen: boolean
  minimumAppsWidth?: number
}

/**
 * Width arbitration for the shell. There is one line of give: the Sidebar collapses first when the main area (plus the
 * tools area when open) would not fit; inside the apps view the panel group enforces each area's minimum.
 */
export function appsLayout(input: AppsLayoutInput): { sidebarWidth: number; appsWidth: number } {
  const requestedSidebarWidth = Math.max(APP_SIDEBAR_MIN_WIDTH, input.requestedSidebarWidth)
  const requiredAppsWidth = input.minimumAppsWidth ?? (input.toolsOpen ? MAIN_AREA_MIN_WIDTH + PANEL_RESIZE_HANDLE_SIZE + TOOLS_AREA_MIN_WIDTH : MAIN_AREA_MIN_WIDTH)
  const sidebarWidth = input.shellWidth - requestedSidebarWidth - APP_LAYOUT_GAP < requiredAppsWidth ? APP_SIDEBAR_MIN_WIDTH : requestedSidebarWidth
  return { sidebarWidth, appsWidth: Math.max(0, input.shellWidth - sidebarWidth - APP_LAYOUT_GAP) }
}
