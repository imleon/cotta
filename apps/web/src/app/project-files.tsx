import { type ProjectFileEntry, type ProjectFileResponse, type ProjectGitWorktree, projectFilesVersionEventSchema } from '@cotta/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type CSSProperties, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Zoom from 'react-medium-image-zoom'
import { fetchProjectFile, fetchProjectFileDiff, fetchProjectFileImage, fetchProjectFiles, fetchProjectFilesGit, ProjectFileHttpError } from '../api'
import { fileLanguage, MarkdownContent, TimelineCodeActions, TimelineCodeContent, TimelineDiffContent, timelineDiffCopyValue } from '../timeline/content'
import { PROJECT_FILE_PREVIEW_MIN_WIDTH, PROJECT_FILES_PANE_MIN_WIDTH, projectFilePreviewWidthMax, resizeProjectFilePreview } from './project-files-layout'
import { ProjectFolderIcon, WorktreeIcon } from './session-history'

export type ProjectFileLanguage = 'javascript' | 'json' | 'css' | 'markdown' | 'image' | 'text'

export function projectFileLanguage(path: string): ProjectFileLanguage {
  const extension = path.split('.').pop()?.toLowerCase()
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(extension ?? '')) return 'javascript'
  if (extension === 'json') return 'json'
  if (extension === 'css') return 'css'
  if (extension === 'md' || extension === 'mdx') return 'markdown'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(extension ?? '')) return 'image'
  return 'text'
}

function gitStatusLabel(status: ProjectFileEntry['gitStatus']): string {
  if (!status || status === 'ignored') return ''
  return status === 'untracked' ? 'U' : status[0].toUpperCase()
}

function GitStatusMark({ status }: { status: ProjectFileEntry['gitStatus'] }) {
  return status ? (
    <span className="project-file-git-status" role="img" aria-label={status}>
      {gitStatusLabel(status)}
    </span>
  ) : (
    <span className="project-file-git-status" />
  )
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" className="project-file-entry-icon" focusable="false" aria-hidden="true">
      <path d="M5 2.75h8.5L19 8.25v13H5V2.75Zm9.25 1.8V7h2.45l-2.45-2.45ZM6.5 4.25v15.5h11V8.75h-4.75v-4.5H6.5Z" fill="currentColor" />
    </svg>
  )
}

function ExplorerIcon() {
  return (
    <svg viewBox="0 0 17 17" className="project-file-entry-icon" focusable="false" aria-hidden="true">
      <path
        d="M10.997 0H4.5v2.01h1V1h5v4h4v8h-4.017v1H15.5V4.182L10.997 0ZM11.5 1.832 13.835 4H11.5V1.832ZM0 3v14h11V7.182L6.497 3H0Zm7 1.832L9.335 7H7V4.832ZM1 16V4h5v4h4v8H1Z"
        fill="currentColor"
      />
    </svg>
  )
}

function DirectoryNode({
  projectId,
  entry,
  expandedPaths,
  onToggle,
  onSelectFile,
}: {
  projectId: string
  entry: ProjectFileEntry
  expandedPaths: ReadonlySet<string>
  onToggle: (path: string) => void
  onSelectFile: (entry: ProjectFileEntry) => void
}) {
  const expanded = expandedPaths.has(entry.path)
  const children = useQuery({ queryKey: ['project-files', projectId, entry.path], queryFn: () => fetchProjectFiles(projectId, entry.path), enabled: expanded, retry: false })
  return (
    <li>
      <button type="button" className="project-file-row" data-git-status={entry.gitStatus} aria-expanded={expanded} onClick={() => onToggle(entry.path)}>
        <span className="project-card-chevron" aria-hidden="true">
          <svg viewBox="0 0 12 12" className="project-card-chevron-icon" focusable="false" aria-hidden="true">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
        </span>
        <span aria-hidden="true">
          <ProjectFolderIcon open={expanded} />
        </span>
        <span>{entry.name}</span>
        <GitStatusMark status={entry.gitStatus} />
      </button>
      {expanded ? (
        <ul className="project-file-tree-list">
          {children.isLoading ? <li className="project-file-state">Loading…</li> : null}
          {children.isError ? (
            <li className="project-file-state">
              <button type="button" onClick={() => void children.refetch()}>
                Retry
              </button>
            </li>
          ) : null}
          {children.data?.entries.map((child) =>
            child.type === 'directory' ? (
              <DirectoryNode key={child.path} projectId={projectId} entry={child} expandedPaths={expandedPaths} onToggle={onToggle} onSelectFile={onSelectFile} />
            ) : (
              <FileNode key={child.path} entry={child} onSelectFile={onSelectFile} />
            ),
          )}
          {children.data?.entries.length === 0 ? <li className="project-file-state">Empty</li> : null}
          {children.data?.truncated ? <li className="project-file-state">Only the first 1,000 entries are shown.</li> : null}
        </ul>
      ) : null}
    </li>
  )
}

function FileNode({ entry, onSelectFile }: { entry: ProjectFileEntry; onSelectFile: (entry: ProjectFileEntry) => void }) {
  return (
    <li>
      <button type="button" className="project-file-row" data-git-status={entry.gitStatus} onClick={() => onSelectFile(entry)}>
        <span aria-hidden="true" />
        <span aria-hidden="true">
          <FileIcon />
        </span>
        <span>{entry.name}</span>
        <GitStatusMark status={entry.gitStatus} />
      </button>
    </li>
  )
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9.93 4.273a8 8 0 0 1 8.683 3.224h-3.11a1 1 0 0 0 0 2h5.496a1 1 0 0 0 1.001-1V3a1 1 0 1 0-2 0v3a10 10 0 1 0 .66 11 1 1 0 0 0-1.732-1A8 8 0 1 1 9.93 4.273Z" fill="currentColor" />
    </svg>
  )
}

function BranchIcon() {
  return (
    <svg viewBox="0 0 256 256" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="10"
        strokeLinejoin="round"
        d="M220,67.99756a32,32,0,1,0-36,31.74109v4.2594a20.02271,20.02271,0,0,1-19.999,20l-72.002.00146A27.9167,27.9167,0,0,0,72,132.42236V99.73865a32,32,0,1,0-8,0v56.52026a32,32,0,1,0,8,0v-4.2594a20.02271,20.02271,0,0,1,19.999-20l72.002-.00146a28.03219,28.03219,0,0,0,27.999-28v-4.2594A32.041,32.041,0,0,0,220,67.99756Zm-176,0a24,24,0,1,1,24,24A24.02718,24.02718,0,0,1,44,67.99756ZM92,188a24,24,0,1,1-24-24A24.02718,24.02718,0,0,1,92,188Zm96-96.00244a24,24,0,1,1,24-24A24.02718,24.02718,0,0,1,188,91.99756Z"
      />
    </svg>
  )
}

function ProjectFileContextBar({ branch, worktree }: { branch: string | null; worktree: ProjectGitWorktree | null }) {
  const worktreeName = worktree ? (worktree.name ?? worktree.path.split('/').filter(Boolean).at(-1) ?? worktree.path) : null
  return branch || worktreeName ? (
    // biome-ignore lint/a11y/useSemanticElements: flex chip bar, not a form control group; <fieldset> would add UA border, padding and min-width
    <div className="project-file-context-bar" role="group" aria-label="Files context">
      {branch ? (
        <span className="project-file-context-chip" title={`Branch: ${branch}`} role="img" aria-label={`Branch: ${branch}`}>
          <BranchIcon />
          <span>{branch}</span>
        </span>
      ) : null}
      {worktreeName ? (
        <span className="project-file-context-chip" title={`Worktree: ${worktreeName}`} role="img" aria-label={`Worktree: ${worktreeName}`}>
          <WorktreeIcon />
          <span>{worktreeName}</span>
        </span>
      ) : null}
    </div>
  ) : null
}

function ProjectRootLabel({ cwd, projectName }: { cwd: string | null; projectName?: string }) {
  if (!cwd) return <span>{projectName ?? 'Project'}</span>
  const normalized = cwd.replace(/\/+$/, '') || '/'
  const slash = normalized.lastIndexOf('/')
  const basename = slash < 0 ? normalized : normalized.slice(slash + 1) || '/'
  const parent = basename === '/' ? '' : normalized.slice(0, slash + 1)
  return (
    <span className="project-file-root-path" title={cwd}>
      {parent ? <span>{parent}</span> : null}
      <span>{basename}</span>
    </span>
  )
}

function ProjectFileTree({
  projectId,
  projectName,
  currentCwd,
  expandedPaths,
  rootExpanded,
  onRootExpandedChange,
  onRefreshDirectory,
  onToggle,
  onSelectFile,
}: {
  projectId: string
  projectName?: string
  currentCwd: string | null
  expandedPaths: ReadonlySet<string>
  rootExpanded: boolean
  onRootExpandedChange: (expanded: boolean) => void
  onRefreshDirectory: () => Promise<void>
  onToggle: (path: string) => void
  onSelectFile: (entry: ProjectFileEntry) => void
}) {
  const [directoryHeight, setDirectoryHeight] = useState(360)
  const [refreshingDirectory, setRefreshingDirectory] = useState(false)
  const sectionsRef = useRef<HTMLDivElement>(null)
  const root = useQuery({ queryKey: ['project-files', projectId, ''], queryFn: () => fetchProjectFiles(projectId), retry: false })
  const git = useQuery({
    queryKey: ['project-files-git', projectId],
    queryFn: () => fetchProjectFilesGit(projectId),
    retry: false,
    refetchInterval: 3_000,
    refetchIntervalInBackground: false,
  })
  const resizeDirectorySections = (event: ReactPointerEvent<HTMLDivElement>) => {
    const host = sectionsRef.current
    if (!host) return
    const handle = event.currentTarget
    const pointerId = event.pointerId
    handle.setPointerCapture(pointerId)
    const move = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return
      const rect = host.getBoundingClientRect()
      setDirectoryHeight(Math.min(Math.max(96, pointerEvent.clientY - rect.top), Math.max(96, rect.height - 96)))
    }
    const finish = (finishEvent: PointerEvent) => {
      if (finishEvent.pointerId !== pointerId) return
      try {
        handle.releasePointerCapture(pointerId)
      } catch {
        // pointer cancellation can release capture before this handler runs.
      }
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }
  const refreshDirectory = async () => {
    setRefreshingDirectory(true)
    try {
      await onRefreshDirectory()
    } finally {
      setRefreshingDirectory(false)
    }
  }
  if (root.isLoading) return <div className="project-file-state">Loading files…</div>
  if (root.isError)
    return (
      <div className="project-file-state">
        {root.error instanceof ProjectFileHttpError && root.error.status === 404 ? 'Project directory is no longer available. ' : ''}
        <button type="button" onClick={() => void root.refetch()}>
          Retry loading files
        </button>
      </div>
    )
  return (
    <div ref={sectionsRef} className="project-file-sections" style={{ '--project-file-directory-height': `${directoryHeight}px` } as CSSProperties}>
      <section className="project-file-directory">
        <div className="project-file-section-header">
          <div className="project-file-section-heading">
            <strong className="project-file-section-title">Directory</strong>
            <ProjectFileContextBar branch={null} worktree={git.data?.available ? git.data.worktree : null} />
          </div>
          <button
            type="button"
            className="project-file-section-refresh"
            onClick={() => void refreshDirectory()}
            disabled={refreshingDirectory}
            aria-busy={refreshingDirectory}
            aria-label="Refresh directory"
            title="Refresh directory"
          >
            {refreshingDirectory ? <span className="turn-spinner" aria-hidden="true" /> : <RefreshIcon />}
          </button>
        </div>
        <ul className="project-file-tree-list project-file-tree-root">
          <li>
            <button type="button" className="project-file-row" aria-expanded={rootExpanded} onClick={() => onRootExpandedChange(!rootExpanded)}>
              <span className="project-card-chevron" aria-hidden="true">
                <svg viewBox="0 0 12 12" className="project-card-chevron-icon" focusable="false" aria-hidden="true">
                  <path d="M4 2.5 8 6 4 9.5" />
                </svg>
              </span>
              <span aria-hidden="true">
                <ProjectFolderIcon open={rootExpanded} />
              </span>
              <ProjectRootLabel cwd={currentCwd} projectName={projectName} />
              <span aria-hidden="true" />
            </button>
            {rootExpanded ? (
              <ul className="project-file-tree-list">
                {root.data?.entries.map((entry) =>
                  entry.type === 'directory' ? (
                    <DirectoryNode key={entry.path} projectId={projectId} entry={entry} expandedPaths={expandedPaths} onToggle={onToggle} onSelectFile={onSelectFile} />
                  ) : (
                    <FileNode key={entry.path} entry={entry} onSelectFile={onSelectFile} />
                  ),
                )}
                {root.data?.entries.length === 0 ? <li className="project-file-state">No files</li> : null}
                {root.data?.truncated ? <li className="project-file-state">Only the first 1,000 entries are shown.</li> : null}
                {root.data?.gitStatusTruncated ? <li className="project-file-status">Git status may be incomplete.</li> : null}
              </ul>
            ) : null}
          </li>
        </ul>
      </section>
      {/* biome-ignore lint/a11y/useSemanticElements: pointer-driven resize handle; <hr> cannot carry the drag affordance */}
      <div className="project-file-section-resizer" role="separator" aria-label="Resize Directory and Changes" onPointerDown={resizeDirectorySections} />
      {git.data ? (
        <section className="project-file-changes">
          <div className="project-file-section-header">
            <div className="project-file-section-heading">
              <strong className="project-file-section-title">Changes</strong>
              <ProjectFileContextBar branch={git.data.available ? git.data.branch : null} worktree={null} />
            </div>
            <button
              type="button"
              className="project-file-section-refresh"
              onClick={() => void git.refetch()}
              disabled={git.isFetching}
              aria-busy={git.isFetching}
              aria-label="Refresh changes"
              title="Refresh changes"
            >
              {git.isFetching ? <span className="turn-spinner" aria-hidden="true" /> : <RefreshIcon />}
            </button>
          </div>
          {git.data.available ? (
            <>
              {git.data.truncated ? <div className="project-file-status">Git status was truncated; changes may be incomplete.</div> : null}
              {git.data.changes.length ? (
                <ul className="project-file-tree-list project-file-tree-root">
                  {git.data.changes.map((change) => (
                    <li key={change.path}>
                      <button
                        type="button"
                        className="project-file-row"
                        data-git-status={change.status}
                        onClick={() => onSelectFile({ name: change.path.split('/').at(-1) ?? change.path, path: change.path, type: 'file', gitStatus: change.status })}
                      >
                        <span aria-hidden="true" />
                        <span aria-hidden="true">
                          <FileIcon />
                        </span>
                        <span>{change.path.split('/').at(-1)}</span>
                        <span className="project-file-git-status">{change.status[0].toUpperCase()}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="project-file-state">No working tree changes.</div>
              )}
            </>
          ) : (
            <div className="project-file-state">Git changes unavailable for this Project.</div>
          )}
        </section>
      ) : null}
    </div>
  )
}

type PreviewMode = 'Markdown' | 'Json' | 'Source' | 'Diff' | 'Image' | 'Binary'

export function binaryFileError(error: unknown): boolean {
  return error instanceof ProjectFileHttpError && (error.code === 'file_not_text' || error.code === 'unsupported_file_type')
}

export function missingFileError(error: unknown): boolean {
  return error instanceof ProjectFileHttpError && error.code === 'file_not_found'
}

export function jsonPreviewContent(content: string): string | null {
  try {
    return JSON.stringify(JSON.parse(content), null, 2)
  } catch {
    return null
  }
}

function defaultFileMode(path: string, binary: boolean, jsonPreview: boolean, gitStatus?: ProjectFileEntry['gitStatus']): PreviewMode {
  if (gitStatus === 'deleted') return 'Diff'
  if (gitStatus === 'conflicted') return 'Source'
  const modes = fileModes(path, binary, jsonPreview, gitStatus)
  return modes[0] ?? 'Source'
}

export function fileModes(path: string, binary: boolean, jsonPreview = false, gitStatus?: ProjectFileEntry['gitStatus']): PreviewMode[] {
  if (gitStatus === 'deleted') return []
  if (gitStatus === 'conflicted') return ['Source']
  const language = projectFileLanguage(path)
  const modes: PreviewMode[] = binary
    ? ['Binary']
    : language === 'markdown'
      ? ['Markdown', 'Diff', 'Source']
      : language === 'json' && jsonPreview
        ? ['Json', 'Diff', 'Source']
        : language === 'image'
          ? ['Image']
          : ['Diff', 'Source']
  return gitStatus === 'untracked' ? modes.filter((mode) => mode !== 'Diff') : modes
}

export function visibleExpandedPaths(expandedPaths: ReadonlySet<string>, rootExpanded: boolean): string[] {
  return rootExpanded ? [...expandedPaths].sort().slice(0, 16) : []
}

function PreviewModeIcon({ mode }: { mode: PreviewMode }) {
  const paths: Record<PreviewMode, React.ReactNode> = {
    Markdown: (
      <>
        <rect x="1" y="1" width="22" height="22" rx="3" />
        <path d="M5 17v-10l4 6 4-6v10M17 8v8m-2-2 2 2 2-2" />
      </>
    ),
    Json: <path d="M9 3C6 3 7 8 4 8v8c3 0 2 5 5 5m6-18c3 0 2 5 5 5v8c-3 0-2 5-5 5" />,
    Diff: (
      <>
        <polyline points="304 160 240 96 304 32" />
        <polyline points="207 352 271 416 207 480" />
        <circle cx="112" cy="96" r="48" />
        <circle cx="400" cy="416" r="48" />
        <path d="M256 96h84a60 60 0 0 1 60 60v212M255 416h-84a60 60 0 0 1-60-60V144" />
      </>
    ),
    Source: (
      <>
        <path d="m8 6-5 6 5 6m8-12 5 6-5 6" />
        <path d="m13 3-2 18" />
      </>
    ),
    Image: <path d="M4 4h16v16H4V4Zm2 12.5 3.8-3.8 3.2 3.2 3.7-3.7 2.1 2.1M8.5 8.5h.01" />,
    Binary: (
      <>
        <path d="M5 2h9l5 5v15H5V2Zm9 1v5h4" strokeWidth="1.1" />
        <text x="7" y="17.5" fill="currentColor" stroke="none" fontSize="9">
          01
        </text>
      </>
    ),
  }
  return (
    <svg viewBox={mode === 'Diff' ? '0 0 512 512' : '0 0 24 24'} aria-hidden="true" data-mode={mode}>
      {paths[mode]}
    </svg>
  )
}

function formatImageSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function FilePreview({
  projectId,
  entry,
  mode,
  file,
  fileLoading,
  fileError,
  onAvailable,
  onRetry,
}: {
  projectId: string
  entry: ProjectFileEntry
  mode: PreviewMode
  file: ProjectFileResponse | undefined
  fileLoading: boolean
  fileError: Error | null
  onAvailable?: () => void
  onRetry: () => void
}) {
  const { path } = entry
  const language = projectFileLanguage(path)
  const image = useQuery({ queryKey: ['project-file-image', projectId, path], queryFn: () => fetchProjectFileImage(projectId, path), enabled: language === 'image', retry: false })
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [imageDimensions, setImageDimensions] = useState<string | null>(null)
  const [sourceWrapped, setSourceWrapped] = useState(false)
  const [diffWrapped, setDiffWrapped] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: path is an intentional reset trigger — clear wrap state when the previewed file changes
  useEffect(() => {
    setSourceWrapped(false)
    setDiffWrapped(false)
  }, [path])
  useEffect(() => {
    setImageDimensions(null)
    if (!image.data) return
    const url = URL.createObjectURL(image.data)
    setImageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [image.data])
  const missing = missingFileError(fileError) || missingFileError(image.error)
  useEffect(() => {
    if (image.isSuccess && !image.isFetching) onAvailable?.()
  }, [image.isFetching, image.isSuccess, onAvailable])
  const diff = useQuery({ queryKey: ['project-file-diff', projectId, path], queryFn: () => fetchProjectFileDiff(projectId, path), enabled: mode === 'Diff' || missing, retry: false })
  const formatted = file && language === 'json' ? jsonPreviewContent(file.content) : null
  return (
    <section className="project-file-preview">
      {language === 'image' && image.isLoading ? <div className="project-file-state">Loading image…</div> : null}
      {language === 'image' && image.isError && !missing ? (
        <div className="project-file-state">
          {image.error instanceof Error ? image.error.message : 'Image preview failed.'}{' '}
          <button type="button" onClick={() => void image.refetch()}>
            Retry
          </button>
        </div>
      ) : null}
      {language === 'image' && !missing && !image.isError && imageUrl && image.data ? (
        <section className="project-file-image-card">
          <div className="project-file-image-box">
            {path.toLowerCase().endsWith('.svg') ? (
              <iframe className="project-file-image" src={imageUrl} sandbox="" title={path} />
            ) : (
              <Zoom zoomImg={{ src: imageUrl, alt: path }}>
                <img className="project-file-image" src={imageUrl} alt={path} onLoad={(event) => setImageDimensions(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)} />
              </Zoom>
            )}
          </div>
          <footer className="project-file-image-meta">
            <span>{image.data.type || 'Unknown type'}</span>
            <span>{formatImageSize(image.data.size)}</span>
            {imageDimensions ? <span>{imageDimensions}</span> : null}
          </footer>
        </section>
      ) : null}
      {!missing && mode === 'Binary' ? (
        <div className="project-file-binary">
          <div className="project-file-binary-card">
            <PreviewModeIcon mode="Binary" />
            <strong>Binary file cannot be previewed.</strong>
            <div className="project-file-binary-meta">
              <span>{entry.name}</span>
              <span>{entry.path.split('.').at(-1)?.toUpperCase() ?? 'BINARY'}</span>
              {entry.size === undefined ? null : <span>{formatImageSize(entry.size)}</span>}
            </div>
          </div>
        </div>
      ) : null}
      {fileLoading ? <div className="project-file-state">Loading file…</div> : null}
      {missing ? <div className="project-file-state">{diff.isLoading ? 'Loading file…' : diff.data?.kind === 'deleted' ? 'Deleted file' : 'File is no longer available.'}</div> : null}
      {fileError && !missing ? (
        <div className="project-file-state">
          {fileError.message}{' '}
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : null}
      {!missing && !fileError && file && mode === 'Markdown' ? (
        <article className="project-file-markdown">
          <MarkdownContent value={file.content} />
        </article>
      ) : null}
      {!missing && !fileError && file && mode === 'Json' && formatted ? (
        <div className="project-file-source">
          <TimelineCodeActions language="json" wrapped={sourceWrapped} copyValue={formatted} onToggleWrap={() => setSourceWrapped((wrapped) => !wrapped)} />
          <TimelineCodeContent value={formatted} language="json" lineNumbers wrapped={sourceWrapped} onWrappedChange={setSourceWrapped} actions={false} />
        </div>
      ) : null}
      {!missing && !fileError && file && mode === 'Source' ? (
        <div className="project-file-source">
          <TimelineCodeActions language={fileLanguage(path)} wrapped={sourceWrapped} copyValue={file.content} onToggleWrap={() => setSourceWrapped((wrapped) => !wrapped)} />
          <TimelineCodeContent value={file.content} language={fileLanguage(path)} lineNumbers wrapped={sourceWrapped} onWrappedChange={setSourceWrapped} actions={false} />
        </div>
      ) : null}
      {mode === 'Diff' && diff.isLoading ? <div className="project-file-state">Loading diff…</div> : null}
      {mode === 'Diff' && diff.data?.kind === 'text' ? (
        <div className="project-file-diff">
          <TimelineCodeActions language={fileLanguage(path)} wrapped={diffWrapped} copyValue={timelineDiffCopyValue(diff.data.hunks)} onToggleWrap={() => setDiffWrapped((wrapped) => !wrapped)} />
          <TimelineDiffContent hunks={diff.data.hunks} filePath={path} wrapped={diffWrapped} onWrappedChange={setDiffWrapped} actions={false} />
        </div>
      ) : null}
      {mode === 'Diff' && diff.data && diff.data.kind !== 'text' ? (
        <div className="project-file-state">
          {diff.data.kind === 'deleted' ? 'Deleted file' : diff.data.kind === 'conflicted' ? 'File has merge conflicts. View Source to inspect it.' : 'Untracked file'}
        </div>
      ) : null}
      {mode === 'Diff' && diff.data?.kind === 'text' && diff.data.truncated ? <div className="project-file-status">Diff output was truncated.</div> : null}
    </section>
  )
}

export type ProjectFileTabs = Record<string, { tabs: ProjectFileEntry[]; selectedPath: string | null }>

export function ExplorerPanel({
  projectId,
  projectName,
  currentCwd,
  openFiles,
  onOpenFilesChange,
  previewWidth: controlledPreviewWidth,
  onPreviewLayoutChange,
  onFilesLayoutChange,
  onClose,
}: {
  projectId: string | null
  projectName?: string
  currentCwd: string | null
  openFiles: ProjectFileTabs
  onOpenFilesChange: (openFiles: ProjectFileTabs) => void
  previewWidth: number | null
  onPreviewLayoutChange: (layout: { paneWidth: number; previewWidth: number }) => void
  onFilesLayoutChange: (layout: { paneWidth: number; previewWidth: number } | null) => void
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const paneRef = useRef<HTMLElement>(null)
  const tabsRef = useRef<HTMLElement>(null)
  const breadcrumbRef = useRef<HTMLElement>(null)
  const [previewWidth, setPreviewWidth] = useState<number | null>(null)
  const [narrow, setNarrow] = useState(false)
  const [mode, setMode] = useState<PreviewMode>('Source')
  const [rootExpanded, setRootExpanded] = useState(true)
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(new Set())
  const state = projectId ? (openFiles[projectId] ?? { tabs: [], selectedPath: null }) : { tabs: [], selectedPath: null }
  const selectedEntry = state.tabs.find((entry) => entry.path === state.selectedPath)
  const selectedLanguage = state.selectedPath ? projectFileLanguage(state.selectedPath) : null
  const selectedFile = useQuery({
    queryKey: ['project-file', projectId, state.selectedPath],
    queryFn: () => fetchProjectFile(projectId!, state.selectedPath!),
    enabled: Boolean(projectId && state.selectedPath && selectedLanguage !== 'image'),
    retry: false,
  })
  const selectedBinary = binaryFileError(selectedFile.error)
  const update = (value: { tabs: ProjectFileEntry[]; selectedPath: string | null }) => {
    if (projectId) onOpenFilesChange({ ...openFiles, [projectId]: value })
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: update is redefined every render; adding it would re-run the consuming effect each render. Deps already capture this project's tabs/selectedPath/gitStatus, which is all update writes back for this projectId.
  const clearDeletedStatus = useCallback(() => {
    if (!projectId || !state.selectedPath || selectedEntry?.gitStatus !== 'deleted') return
    update({ tabs: state.tabs.map((entry) => (entry.path === state.selectedPath ? { ...entry, gitStatus: undefined } : entry)), selectedPath: state.selectedPath })
  }, [projectId, selectedEntry?.gitStatus, state.selectedPath, state.tabs])
  useEffect(() => {
    if (selectedBinary || (selectedFile.isSuccess && !selectedFile.isFetching)) clearDeletedStatus()
  }, [clearDeletedStatus, selectedBinary, selectedFile.isFetching, selectedFile.isSuccess])
  const refreshDirectory = () => (projectId ? queryClient.refetchQueries({ queryKey: ['project-files', projectId], type: 'active' }) : Promise.resolve())
  const selectFile = (entry: ProjectFileEntry) => {
    if (projectId) {
      for (const key of ['project-file', 'project-file-diff', 'project-file-image']) queryClient.removeQueries({ queryKey: [key, projectId, entry.path] })
    }
    update({
      tabs: state.tabs.some((tab) => tab.path === entry.path) ? state.tabs.map((tab) => (tab.path === entry.path ? { ...tab, ...entry, gitStatus: entry.gitStatus } : tab)) : [...state.tabs, entry],
      selectedPath: entry.path,
    })
  }
  const toggleExpandedPath = (path: string) =>
    setExpandedPaths((current) => {
      if (current.has(path)) return new Set([...current].filter((item) => item !== path && !item.startsWith(`${path}/`)))
      return new Set(current).add(path)
    })
  const expandedPathsKey = useMemo(() => visibleExpandedPaths(expandedPaths, rootExpanded).join('\0'), [expandedPaths, rootExpanded])
  const beginPreviewResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0 || !paneRef.current) return
    event.preventDefault()
    const pane = paneRef.current
    const bounds = pane.getBoundingClientRect()
    const handle = event.currentTarget
    const pointerId = event.pointerId
    const startX = event.clientX
    const startPreviewWidth = resolvedPreviewWidth ?? pane.querySelector('.project-file-workbench')?.getBoundingClientRect().width ?? projectFilePreviewWidthMax(bounds.width)
    handle.setPointerCapture(pointerId)
    const updateWidth = (clientX: number) => {
      const layout = resizeProjectFilePreview({ paneWidth: bounds.width, requestedPreviewWidth: startPreviewWidth + clientX - startX })
      setPreviewWidth(layout.previewWidth)
      onPreviewLayoutChange(layout)
    }
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId === pointerId) updateWidth(moveEvent.clientX)
    }
    const finish = (finishEvent: PointerEvent) => {
      if (finishEvent.pointerId !== pointerId) return
      updateWidth(finishEvent.clientX)
      handle.releasePointerCapture(pointerId)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: projectId is an intentional reset trigger — collapse the tree when switching projects
  useEffect(() => {
    setRootExpanded(true)
    setExpandedPaths(new Set())
  }, [projectId])
  const selectedJsonPreview = selectedLanguage === 'json' && selectedFile.data ? jsonPreviewContent(selectedFile.data.content) !== null : false
  useEffect(() => {
    if (state.selectedPath) setMode(defaultFileMode(state.selectedPath, selectedBinary, selectedJsonPreview, selectedEntry?.gitStatus))
  }, [selectedBinary, selectedEntry?.gitStatus, selectedJsonPreview, state.selectedPath])
  // biome-ignore lint/correctness/useExhaustiveDependencies: state.selectedPath is an intentional trigger — scroll the current tab into view and the breadcrumb to its end when the selection changes
  useEffect(() => {
    tabsRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    if (breadcrumbRef.current) breadcrumbRef.current.scrollLeft = breadcrumbRef.current.scrollWidth
  }, [state.selectedPath])
  useEffect(() => {
    if (!projectId) return
    const params = new URLSearchParams()
    for (const path of expandedPathsKey.split('\0')) if (path) params.append('path', path)
    if (state.selectedPath) params.set('file', state.selectedPath)
    const suffix = params.size ? `?${params}` : ''
    const source = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/files/events${suffix}`)
    source.onmessage = (event) => {
      let contentOnly = false
      try {
        contentOnly = projectFilesVersionEventSchema.safeParse(JSON.parse(event.data)).data?.contentOnly === true
      } catch {}
      if (contentOnly && state.selectedPath) {
        for (const key of ['project-file', 'project-file-diff', 'project-file-image']) void queryClient.invalidateQueries({ queryKey: [key, projectId, state.selectedPath] })
        return
      }
      void queryClient.invalidateQueries({ queryKey: ['project-files', projectId] })
      void queryClient.invalidateQueries({ queryKey: ['project-files-git', projectId] })
      void queryClient.invalidateQueries({ queryKey: ['project-file', projectId] })
      void queryClient.invalidateQueries({ queryKey: ['project-file-diff', projectId] })
      void queryClient.invalidateQueries({ queryKey: ['project-file-image', projectId] })
    }
    return () => source.close()
  }, [expandedPathsKey, projectId, queryClient, state.selectedPath])
  const hasPreview = Boolean(projectId)
  useEffect(() => {
    const pane = paneRef.current
    if (!pane) return
    const update = () => setNarrow(pane.getBoundingClientRect().width < PROJECT_FILES_PANE_MIN_WIDTH)
    update()
    if (!('ResizeObserver' in window)) return
    const observer = new ResizeObserver(update)
    observer.observe(pane)
    return () => observer.disconnect()
  }, [])
  const resolvedPreviewWidth = controlledPreviewWidth ?? previewWidth
  const previewWidthMax = paneRef.current ? projectFilePreviewWidthMax(paneRef.current.getBoundingClientRect().width) : undefined
  useEffect(() => {
    if (!hasPreview || !paneRef.current) return onFilesLayoutChange(null)
    const bounds = paneRef.current.getBoundingClientRect()
    const nextPreviewWidth = resolvedPreviewWidth ?? paneRef.current.querySelector('.project-file-workbench')?.getBoundingClientRect().width ?? projectFilePreviewWidthMax(bounds.width)
    onFilesLayoutChange({ paneWidth: bounds.width, previewWidth: nextPreviewWidth })
    return () => onFilesLayoutChange(null)
  }, [hasPreview, onFilesLayoutChange, resolvedPreviewWidth])
  return (
    <aside
      ref={paneRef}
      id="workspace-explorer-pane"
      className="workspace-explorer-pane"
      aria-label="Project explorer"
      data-has-preview={hasPreview}
      data-narrow={narrow}
      style={resolvedPreviewWidth === null ? undefined : ({ '--project-file-preview-width': `${resolvedPreviewWidth}px` } as CSSProperties)}
    >
      <header className="project-files-header workspace-panel-header">
        <div className="project-files-header-title">
          <ExplorerIcon />
          Explorer
        </div>
        <button type="button" className="workspace-pane-toggle" onClick={onClose} aria-label="Close explorer">
          ×
        </button>
      </header>
      {!projectId ? (
        <div className="project-file-state" role="tabpanel">
          Select a project to browse files.
        </div>
      ) : (
        <div className="project-files-content" role="tabpanel">
          {hasPreview ? (
            <div className="project-file-workbench">
              {state.selectedPath ? (
                <div className="project-file-tabbar">
                  <nav ref={tabsRef} className="project-file-tabs" aria-label="Open files">
                    {state.tabs.map((entry) => (
                      <span key={entry.path} className="project-file-tab" aria-current={entry.path === state.selectedPath}>
                        <button type="button" className="project-file-tab-select" onClick={() => selectFile(entry)} title={entry.path}>
                          {entry.name}
                        </button>
                        <button
                          type="button"
                          className="project-file-tab-close"
                          aria-label={`Close ${entry.name}`}
                          onClick={() => {
                            const tabs = state.tabs.filter((item) => item.path !== entry.path)
                            update({ tabs, selectedPath: state.selectedPath === entry.path ? (tabs.at(-1)?.path ?? null) : state.selectedPath })
                          }}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </nav>
                  <div className="project-file-actions">
                    {fileModes(state.selectedPath, selectedBinary, selectedJsonPreview, selectedEntry?.gitStatus).map((item) => (
                      <button
                        type="button"
                        key={item}
                        aria-label={item === 'Source' ? 'Source Code' : item === 'Json' ? 'JSON Preview' : item === 'Markdown' ? 'Markdown' : item === 'Diff' ? 'Git Diff' : item}
                        title={item === 'Source' ? 'Source Code' : item === 'Json' ? 'JSON Preview' : item === 'Markdown' ? 'Markdown' : item === 'Diff' ? 'Git Diff' : item}
                        aria-pressed={mode === item}
                        onClick={() => setMode(item)}
                      >
                        <PreviewModeIcon mode={item} />
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {state.selectedPath ? (
                <nav ref={breadcrumbRef} className="project-file-breadcrumb" aria-label="File path" title={state.selectedPath}>
                  <span>{projectName ?? 'Project'}</span>
                  {state.selectedPath.split('/').map((segment) => (
                    <span key={segment}>{segment}</span>
                  ))}
                </nav>
              ) : null}
              {state.selectedPath ? (
                <FilePreview
                  projectId={projectId}
                  entry={selectedEntry!}
                  mode={mode}
                  file={selectedFile.data}
                  fileLoading={selectedFile.isLoading}
                  fileError={selectedBinary ? null : selectedFile.error instanceof Error ? selectedFile.error : null}
                  onAvailable={clearDeletedStatus}
                  onRetry={() => void selectedFile.refetch()}
                />
              ) : (
                <div className="project-file-state">Choose a file to preview.</div>
              )}
            </div>
          ) : null}
          {hasPreview ? (
            // biome-ignore lint/a11y/useSemanticElements: pointer-driven resize handle; <hr> cannot carry the drag affordance
            <div
              className="project-file-pane-resizer"
              role="separator"
              aria-label="Resize file preview and file tree"
              aria-orientation="vertical"
              aria-valuemin={PROJECT_FILE_PREVIEW_MIN_WIDTH}
              aria-valuemax={previewWidthMax}
              aria-valuenow={resolvedPreviewWidth ?? undefined}
              onPointerDown={beginPreviewResize}
            />
          ) : null}
          <div className="project-file-tree">
            <ProjectFileTree
              projectId={projectId}
              projectName={projectName}
              currentCwd={currentCwd}
              expandedPaths={expandedPaths}
              rootExpanded={rootExpanded}
              onRootExpandedChange={setRootExpanded}
              onRefreshDirectory={refreshDirectory}
              onToggle={toggleExpandedPath}
              onSelectFile={selectFile}
            />
          </div>
        </div>
      )}
    </aside>
  )
}
