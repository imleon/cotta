import { describe, expect, it } from 'vitest'
import {
  clampWorkspaceExplorerWidth,
  WORKSPACE_EXPLORER_DEFAULT_WIDTH,
  WORKSPACE_EXPLORER_MIN_WIDTH,
  WORKSPACE_EXPLORER_REQUIRED_WIDTH,
  WORKSPACE_TIMELINE_MIN_WIDTH,
  workspaceExplorerLayout,
  workspaceExplorerWidthMax,
} from './workspace-explorer-layout'

describe('workspace explorer layout', () => {
  it('keeps the timeline minimum width available', () => {
    expect(workspaceExplorerWidthMax(900)).toBe(900 - WORKSPACE_TIMELINE_MIN_WIDTH)
    expect(workspaceExplorerWidthMax(WORKSPACE_TIMELINE_MIN_WIDTH)).toBe(0)
    expect(workspaceExplorerWidthMax(WORKSPACE_TIMELINE_MIN_WIDTH - 1)).toBe(0)
  })

  it('clamps explorer pane width to the available range', () => {
    expect(WORKSPACE_EXPLORER_DEFAULT_WIDTH).toBe(WORKSPACE_EXPLORER_MIN_WIDTH)
    expect(clampWorkspaceExplorerWidth(600, 1000)).toBe(600)
    expect(clampWorkspaceExplorerWidth(120, 1000)).toBe(WORKSPACE_EXPLORER_MIN_WIDTH)
    expect(clampWorkspaceExplorerWidth(1000, 1000)).toBe(1000 - WORKSPACE_TIMELINE_MIN_WIDTH)
  })

  it('uses an overlay below the side-pane minimum', () => {
    expect(workspaceExplorerLayout(WORKSPACE_EXPLORER_REQUIRED_WIDTH)).toBe('side')
    expect(workspaceExplorerLayout(WORKSPACE_EXPLORER_REQUIRED_WIDTH - 1)).toBe('overlay')
  })

  it('uses the available maximum when the workspace is narrower than the explorer minimum', () => {
    expect(clampWorkspaceExplorerWidth(120, WORKSPACE_TIMELINE_MIN_WIDTH + 120)).toBe(120)
  })
})
