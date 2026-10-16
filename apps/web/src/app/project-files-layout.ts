export const PROJECT_FILE_PREVIEW_MIN_WIDTH = 380
export const PROJECT_FILE_TREE_MIN_WIDTH = 180
export const PROJECT_FILE_RESIZE_HANDLE_WIDTH = 5
export const PROJECT_FILES_PANE_MIN_WIDTH = PROJECT_FILE_PREVIEW_MIN_WIDTH + PROJECT_FILE_RESIZE_HANDLE_WIDTH + PROJECT_FILE_TREE_MIN_WIDTH

export function projectFilePreviewWidthMax(paneWidth: number): number {
  return Math.max(0, paneWidth - PROJECT_FILE_TREE_MIN_WIDTH - PROJECT_FILE_RESIZE_HANDLE_WIDTH)
}

export function clampProjectFilePreviewWidth(width: number, paneWidth: number): number {
  const maxWidth = projectFilePreviewWidthMax(paneWidth)
  return Math.min(maxWidth, Math.max(Math.min(PROJECT_FILE_PREVIEW_MIN_WIDTH, maxWidth), width))
}

export function resizeProjectFilePreview(input: { paneWidth: number; requestedPreviewWidth: number }): { paneWidth: number; previewWidth: number } {
  const minimumWidth = Math.min(PROJECT_FILE_PREVIEW_MIN_WIDTH, projectFilePreviewWidthMax(input.paneWidth))
  if (input.requestedPreviewWidth >= minimumWidth) return { paneWidth: input.paneWidth, previewWidth: clampProjectFilePreviewWidth(input.requestedPreviewWidth, input.paneWidth) }
  return { paneWidth: input.paneWidth + minimumWidth - input.requestedPreviewWidth, previewWidth: minimumWidth }
}

export function resizeProjectFilesPane(input: { paneWidth: number; previewWidth: number; requestedPaneWidth: number }): { paneWidth: number; previewWidth: number } {
  const rightWidth = input.paneWidth - PROJECT_FILE_RESIZE_HANDLE_WIDTH - input.previewWidth
  if (input.requestedPaneWidth >= input.paneWidth) {
    const delta = input.requestedPaneWidth - input.paneWidth
    return { paneWidth: input.requestedPaneWidth, previewWidth: input.previewWidth + delta }
  }
  const shrink = input.paneWidth - input.requestedPaneWidth
  const previewShrink = Math.min(shrink, Math.max(0, input.previewWidth - PROJECT_FILE_PREVIEW_MIN_WIDTH))
  const rightShrink = Math.min(shrink - previewShrink, Math.max(0, rightWidth - PROJECT_FILE_TREE_MIN_WIDTH))
  return { paneWidth: input.paneWidth - previewShrink - rightShrink, previewWidth: input.previewWidth - previewShrink }
}
