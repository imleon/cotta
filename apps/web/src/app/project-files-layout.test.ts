import { describe, expect, it } from 'vitest'
import { clampProjectFilePreviewWidth, PROJECT_FILE_PREVIEW_MIN_WIDTH, PROJECT_FILES_PANE_MIN_WIDTH, resizeProjectFilePreview, resizeProjectFilesPane } from './project-files-layout'

describe('project file pane layout', () => {
  const paneWidth = PROJECT_FILES_PANE_MIN_WIDTH + 200

  it('keeps preview and file tree above their minimum widths', () => {
    expect(PROJECT_FILES_PANE_MIN_WIDTH).toBe(565)
    expect(clampProjectFilePreviewWidth(0, paneWidth)).toBe(PROJECT_FILE_PREVIEW_MIN_WIDTH)
    expect(clampProjectFilePreviewWidth(paneWidth, paneWidth)).toBe(PROJECT_FILE_PREVIEW_MIN_WIDTH + 200)
  })

  it('uses available width when the pane is narrower than both minima', () => {
    expect(clampProjectFilePreviewWidth(0, 200)).toBe(15)
  })

  it('expands the outer pane after preview reaches its minimum', () => {
    expect(resizeProjectFilePreview({ paneWidth: 700, requestedPreviewWidth: 500 })).toEqual({ paneWidth: 700, previewWidth: 500 })
    expect(resizeProjectFilePreview({ paneWidth: 700, requestedPreviewWidth: 380 })).toEqual({ paneWidth: 700, previewWidth: 380 })
    expect(resizeProjectFilePreview({ paneWidth: 700, requestedPreviewWidth: 320 })).toEqual({ paneWidth: 760, previewWidth: 380 })
  })

  it('allocates outer resizing to preview before the file tree column shrinks', () => {
    expect(resizeProjectFilesPane({ paneWidth: 700, previewWidth: 500, requestedPaneWidth: 800 })).toEqual({ paneWidth: 800, previewWidth: 600 })
    expect(resizeProjectFilesPane({ paneWidth: 700, previewWidth: 500, requestedPaneWidth: 600 })).toEqual({ paneWidth: 600, previewWidth: 400 })
    expect(resizeProjectFilesPane({ paneWidth: 700, previewWidth: 400, requestedPaneWidth: 500 })).toEqual({ paneWidth: 565, previewWidth: 380 })
  })
})
