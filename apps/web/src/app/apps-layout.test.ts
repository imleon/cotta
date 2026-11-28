import { describe, expect, it } from 'vitest'
import { APP_SIDEBAR_MIN_WIDTH } from './app-layout'
import { appsLayout, MAIN_AREA_MIN_WIDTH, PANEL_RESIZE_HANDLE_SIZE, TOOLS_AREA_MIN_WIDTH } from './apps-layout'

describe('appsLayout', () => {
  it('keeps the requested Sidebar when the main and tools areas fit', () => {
    expect(appsLayout({ shellWidth: 1416, requestedSidebarWidth: 216, toolsOpen: true })).toEqual({ sidebarWidth: 216, appsWidth: 1188 })
  })

  it('collapses the Sidebar first when the open tools area would not fit beside the main area', () => {
    const tight = 216 + 12 + MAIN_AREA_MIN_WIDTH + PANEL_RESIZE_HANDLE_SIZE + TOOLS_AREA_MIN_WIDTH - 1
    expect(appsLayout({ shellWidth: tight, requestedSidebarWidth: 216, toolsOpen: true }).sidebarWidth).toBe(APP_SIDEBAR_MIN_WIDTH)
    expect(appsLayout({ shellWidth: tight, requestedSidebarWidth: 216, toolsOpen: false }).sidebarWidth).toBe(216)
  })

  it('does not reserve workspace width for a route view', () => {
    expect(appsLayout({ shellWidth: 300, requestedSidebarWidth: 216, toolsOpen: false, minimumAppsWidth: 0 })).toMatchObject({ sidebarWidth: 216, appsWidth: 72 })
  })
})
