import { describe, expect, it } from 'vitest'
import { appsLayout, PANEL_RESIZE_HANDLE_SIZE, TOOL_PANEL_MIN_WIDTH, terminalHeightMax, terminalWidthMax, WORKSPACE_GROUP_MIN_WIDTH } from './apps-layout'
import { WORKSPACE_EXPLORER_REQUIRED_WIDTH } from './workspace-explorer-layout'

describe('appsLayout', () => {
  it('shrinks Terminal to preserve a side Explorer', () => {
    expect(appsLayout({ shellWidth: 1416, requestedSidebarWidth: 216, explorerOpen: true, toolOpen: true, requestedToolWidth: 420 })).toEqual({
      sidebarWidth: 216,
      appsWidth: 1188,
      toolLayout: 'side',
      toolWidth: 292,
    })
  })

  it('collapses Sidebar before moving Terminal below', () => {
    expect(appsLayout({ shellWidth: 776, requestedSidebarWidth: 216, explorerOpen: true, toolOpen: true, requestedToolWidth: 420 })).toEqual({
      sidebarWidth: 46,
      appsWidth: 718,
      toolLayout: 'bottom',
      toolWidth: TOOL_PANEL_MIN_WIDTH,
    })
  })

  it('does not reserve Explorer width when it is closed', () => {
    expect(appsLayout({ shellWidth: 1416, requestedSidebarWidth: 216, explorerOpen: false, toolOpen: true, requestedToolWidth: 420 })).toEqual({
      sidebarWidth: 216,
      appsWidth: 1188,
      toolLayout: 'side',
      toolWidth: 420,
    })
  })

  it('uses bottom placement whenever side minimums do not fit', () => {
    expect(
      appsLayout({
        shellWidth: WORKSPACE_GROUP_MIN_WIDTH + PANEL_RESIZE_HANDLE_SIZE + TOOL_PANEL_MIN_WIDTH - 1,
        requestedSidebarWidth: 46,
        explorerOpen: false,
        toolOpen: true,
        requestedToolWidth: 420,
      }),
    ).toMatchObject({
      toolLayout: 'bottom',
      toolWidth: TOOL_PANEL_MIN_WIDTH,
    })
    expect(WORKSPACE_EXPLORER_REQUIRED_WIDTH).toBe(885)
  })

  it('does not reserve workspace width for a route view', () => {
    expect(appsLayout({ shellWidth: 300, requestedSidebarWidth: 216, explorerOpen: false, toolOpen: false, requestedToolWidth: 420, minimumAppsWidth: 0 })).toMatchObject({
      sidebarWidth: 216,
      appsWidth: 72,
    })
  })

  it('shares terminal resize limits with the layout', () => {
    expect(terminalWidthMax(718, false)).toBe(387)
    expect(terminalHeightMax(0)).toBeNull()
    expect(terminalHeightMax(500)).toBe(251)
  })
})
