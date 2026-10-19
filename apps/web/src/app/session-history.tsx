import type { ProjectSessionsResponse, ProjectSummary, SessionPin, SessionSummary } from '@cotta/shared'
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { type FormEvent, type UIEvent as ReactUIEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { fetchProjectSessions, fetchProjects, PaginationCursorStaleError, queryProjectSessions } from '../api'
import { formatAge } from '../format-age'
import { sessionQueryKeys } from './session-query-refresh'

function statusTone(session: SessionSummary): string {
  if (session.lastTurnOutcome === 'success') return 'success'
  if (session.lastTurnOutcome === 'error') return 'danger'
  // Only explicit external ownership blocks Cotta; unowned history remains Cotta-ready.
  return `${session.occupiedBy === 'external' ? 'external' : 'cotta'}-${session.occupiedStatus}`
}

function statusLabel(session: SessionSummary): string {
  if (session.lastTurnOutcome === 'success') return 'Cotta completed'
  if (session.lastTurnOutcome === 'error') return 'Cotta failed'
  const source = session.occupiedBy === 'external' ? 'External' : 'Cotta'
  if (session.occupiedStatus === 'busy') return `${source} busy`
  if (session.occupiedStatus === 'waiting') return `${source} waiting`
  if (session.occupiedStatus === 'background') return `${source} background`
  return `${source} idle`
}

function statusIcon(_session: SessionSummary) {
  return <span className="status-dot" aria-hidden="true" />
}

function projectSessionsRegionId(projectId: string): string {
  return `project-sessions-${encodeURIComponent(projectId)}`
}

const LOAD_MORE_SCROLL_THRESHOLD_PX = 24

export function WorktreeIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M11.83 6.2a3.5 3.5 0 0 1 0 6.93v2.2h-1v-2.2a3.5 3.5 0 0 1 0-6.93V.67h1V6.2Zm-.5.97a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z" />
      <path
        fill="currentColor"
        d="M6.33 2c.54 0 1.12.67 1.34 1h2v1h-2c-.5 0-.88-.38-1.13-.7l-.2-.3H1.66v3H6l.67-.67c.2-.18.36-.26.66-.33h2.34v.3c-.44.17-.85.4-1.22.7H7.33l-.66.67-.17.2-.33.13h-4.5v6h6.4l.17.16c.4.36.86.64 1.36.84H1.33l-.66-.67V2.67L1.33 2h5ZM15.33 12.07v1.26l-.66.67h-1.6a4.68 4.68 0 0 0 2.26-1.93ZM14.67 3l.66.67v3.59A4.7 4.7 0 0 0 13 5.31V5h1.33V4H13V3h1.67Z"
      />
    </svg>
  )
}

export function WorktreeBadge({ name }: { name: string }) {
  return (
    <span className="project-card-worktree" title={name}>
      <WorktreeIcon />
      <span>{name}</span>
    </span>
  )
}

export function ProjectFolderIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 640 640" className="project-card-folder-icon" focusable="false" aria-hidden="true" data-icon="FolderOutlined">
      <path
        d={
          open
            ? 'M129.5 464 179.5 304h379.4l-50 160H129.5zM320.2 512H509c21 0 39.6-13.6 45.8-33.7l50-160c9.7-30.9-13.3-62.3-45.9-62.3H179.6c-21 0-39.6 13.6-45.8 33.7L112.2 358.4V160c0-8.8 7.2-16 16-16h138.7c3.5 0 6.8 1.1 9.6 3.2l38.4 28.8c13.8 10.4 30.7 16 48 16h117.3c8.8 0 16 7.2 16 16h48c0-35.3-28.7-64-64-64H362.9c-6.9 0-13.7-2.2-19.2-6.4l-38.4-28.8C294.2 100.5 280.8 96 266.9 96H128.2c-35.3 0-64 28.7-64 64v288c0 35.3 28.7 64 64 64h192z'
            : 'M512 464H128c-8.8 0-16-7.2-16-16V288h416v160c0 8.8-7.2 16-16 16Zm16-208H112v-96c0-8.8 7.2-16 16-16h138.7c3.5 0 6.8 1.1 9.6 3.2l38.4 28.8c13.8 10.4 30.7 16 48 16H512c8.8 0 16 7.2 16 16v48ZM128 512h384c35.3 0 64-28.7 64-64V208c0-35.3-28.7-64-64-64H362.7c-6.9 0-13.7-2.2-19.2-6.4l-38.4-28.8C294 100.5 280.5 96 266.7 96H128c-35.3 0-64 28.7-64 64v288c0 35.3 28.7 64 64 64Z'
        }
        fill="currentColor"
      />
    </svg>
  )
}

function ProjectCard({
  project,
  selected,
  expanded,
  sessionsRegionId,
  onToggleExpanded,
  onSelectProject,
}: {
  project: ProjectSummary
  selected: boolean
  expanded: boolean
  sessionsRegionId: string
  onToggleExpanded: () => void
  onSelectProject: () => void
}) {
  return (
    <button
      className={`project-card ${selected ? 'selected' : ''}`}
      type="button"
      onClick={() => {
        if (!selected && !expanded) onSelectProject()
        onToggleExpanded()
      }}
      aria-current={selected ? 'true' : undefined}
      aria-expanded={expanded}
      aria-controls={sessionsRegionId}
      aria-label={`${expanded ? 'Collapse' : 'Expand'} ${project.name}${project.worktreeName ? ` worktree ${project.worktreeName}` : ''} sessions`}
    >
      <div className="project-card-main">
        <span className="project-card-icon" aria-hidden="true">
          <ProjectFolderIcon open={selected} />
        </span>
        <span className="project-card-name">{project.name}</span>
      </div>
      <span className="project-card-end">
        {project.worktreeName ? <WorktreeBadge name={project.worktreeName} /> : null}
        <span className="project-card-chevron" aria-hidden="true">
          <svg viewBox="0 0 12 12" className="project-card-chevron-icon" focusable="false" aria-hidden="true">
            <path d="M4 2.5 8 6 4 9.5" />
          </svg>
        </span>
      </span>
    </button>
  )
}

export function StatusBadge({ session }: { session: SessionSummary }) {
  const tone = statusTone(session)
  const label = statusLabel(session)
  return (
    <span className={`status-badge status-${tone}`} data-tooltip={label} title={label} role="img" aria-label={label}>
      {statusIcon(session)}
    </span>
  )
}

export function ProjectListSkeleton() {
  return (
    <div className="project-tree project-list-skeleton" role="status" aria-label="Loading projects">
      {[0, 1, 2, 3].map((item) => (
        <div className="project-card project-card-skeleton" key={item}>
          <span className="project-card-main">
            <span className="project-card-skeleton-icon" />
            <span className="project-card-skeleton-name" />
          </span>
          <span className="project-card-skeleton-end" />
        </div>
      ))}
    </div>
  )
}

function SessionListSkeleton() {
  return (
    <ol className="session-list rail-session-list session-list-skeleton" aria-label="Loading sessions">
      {[0, 1, 2].map((item) => (
        <li className="session-row-skeleton" key={item}>
          <span className="session-row-skeleton-title" />
          <span className="session-row-skeleton-age" />
        </li>
      ))}
    </ol>
  )
}

type SessionActionCallbacks = {
  onDeleteSession?: (projectId: string, sessionId: string, confirmationSessionId: string) => Promise<void>
  onRenameSession?: (projectId: string, sessionId: string, title: string) => Promise<void>
  onPinSession?: (sessionId: string, pinned: boolean) => Promise<void>
  onForkSession?: (projectId: string, sessionId: string) => Promise<unknown>
  onRestartSession?: (sessionId: string) => Promise<void>
}

export function SessionActions({
  projectId,
  session,
  pinned,
  selected,
  buttonClassName,
  onDeleteSession,
  onRenameSession,
  onPinSession,
  onForkSession,
  onRestartSession,
}: {
  projectId: string
  session: SessionSummary
  pinned: boolean
  selected?: boolean
  buttonClassName: string
} & SessionActionCallbacks) {
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null)
  const [deleteDialog, setDeleteDialog] = useState<{ value: string; error: string | null; deleting: boolean } | null>(null)
  const [renameDialog, setRenameDialog] = useState<{ value: string; error: string | null; saving: boolean } | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const deleteDialogRef = useRef<HTMLDialogElement | null>(null)
  const renameDialogRef = useRef<HTMLDialogElement | null>(null)

  useEffect(() => {
    if (!menuPosition) return
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    function closeMenu(event: globalThis.PointerEvent) {
      const target = event.target as Node | null
      if (target && (triggerRef.current?.contains(target) || menuRef.current?.contains(target))) return
      setMenuPosition(null)
    }
    function closeOtherMenu(event: Event) {
      if ((event as CustomEvent).detail !== triggerRef.current) setMenuPosition(null)
    }
    document.addEventListener('pointerdown', closeMenu)
    document.addEventListener('session-actions-open', closeOtherMenu)
    return () => {
      document.removeEventListener('pointerdown', closeMenu)
      document.removeEventListener('session-actions-open', closeOtherMenu)
    }
  }, [menuPosition])

  useEffect(() => {
    const dialog = deleteDialogRef.current
    if (deleteDialog && dialog && !dialog.open) dialog.showModal()
  }, [deleteDialog])

  useEffect(() => {
    const dialog = renameDialogRef.current
    if (renameDialog && dialog && !dialog.open) dialog.showModal()
  }, [renameDialog])

  async function submitDelete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!deleteDialog || !onDeleteSession) return
    const confirmationSessionId = deleteDialog.value.trim()
    if (confirmationSessionId !== session.id) {
      setDeleteDialog({ ...deleteDialog, error: 'Session ID does not match.' })
      return
    }
    setDeleteDialog({ ...deleteDialog, value: confirmationSessionId, error: null, deleting: true })
    try {
      await onDeleteSession(projectId, session.id, confirmationSessionId)
      setDeleteDialog(null)
    } catch (error) {
      setDeleteDialog((current) => (current ? { ...current, deleting: false, error: error instanceof Error ? error.message : String(error) } : current))
    }
  }

  async function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!renameDialog || !onRenameSession) return
    const title = renameDialog.value.trim()
    if (!title) {
      setRenameDialog({ ...renameDialog, error: 'Title is required.' })
      return
    }
    setRenameDialog({ ...renameDialog, value: title, error: null, saving: true })
    try {
      await onRenameSession(projectId, session.id, title)
      setRenameDialog(null)
    } catch (error) {
      setRenameDialog((current) => (current ? { ...current, saving: false, error: error instanceof Error ? error.message : String(error) } : current))
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        className={buttonClassName}
        type="button"
        aria-haspopup="menu"
        aria-expanded={Boolean(menuPosition) || undefined}
        aria-label={`More actions for ${session.title}`}
        onClick={(event) => {
          event.stopPropagation()
          const rect = event.currentTarget.getBoundingClientRect()
          if (menuPosition) setMenuPosition(null)
          else {
            document.dispatchEvent(new CustomEvent('session-actions-open', { detail: event.currentTarget }))
            setMenuPosition({ x: Math.max(8, rect.right - 128), y: rect.bottom + 4 })
          }
        }}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="5" cy="10" r="1.4" />
          <circle cx="10" cy="10" r="1.4" />
          <circle cx="15" cy="10" r="1.4" />
        </svg>
      </button>
      {menuPosition ? (
        <div
          ref={menuRef}
          className="session-row-menu"
          role="menu"
          style={{ left: menuPosition.x, top: menuPosition.y }}
          onKeyDown={(event) => {
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
            const index = items.indexOf(document.activeElement as HTMLButtonElement)
            if (event.key === 'Escape') {
              setMenuPosition(null)
              triggerRef.current?.focus()
              return
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
          }}
        >
          {onRenameSession ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuPosition(null)
                setRenameDialog({ value: session.title, error: null, saving: false })
              }}
            >
              Rename
            </button>
          ) : null}
          {onPinSession ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuPosition(null)
                void onPinSession(session.id, !pinned).catch(() => {})
              }}
            >
              {pinned ? 'Unpin' : 'Pin'}
            </button>
          ) : null}
          {onForkSession ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuPosition(null)
                void onForkSession(projectId, session.id).catch(() => {})
              }}
            >
              Fork
            </button>
          ) : null}
          {selected && session.hasRuntime && onRestartSession ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuPosition(null)
                void onRestartSession(session.id).catch(() => {})
              }}
            >
              Restart
            </button>
          ) : null}
          {onDeleteSession ? (
            <button
              className="session-row-menu-danger"
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuPosition(null)
                setDeleteDialog({ value: '', error: null, deleting: false })
              }}
            >
              Delete
            </button>
          ) : null}
        </div>
      ) : null}
      {deleteDialog ? (
        // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-close; keyboard closes via Escape (onCancel) and the Cancel button
        <dialog
          ref={deleteDialogRef}
          className="rename-session-dialog delete-session-dialog"
          aria-label="Delete session"
          onCancel={(event) => {
            event.preventDefault()
            setDeleteDialog(null)
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) setDeleteDialog(null)
          }}
        >
          <form className="rename-session-form delete-session-form" onSubmit={submitDelete}>
            <h2>Delete session</h2>
            <p className="delete-session-warning">This permanently deletes the session transcript and subagent transcripts. Type the full session ID to confirm.</p>
            <p className="rename-session-target">{session.title}</p>
            <code className="delete-session-id">{session.id}</code>
            <label className="rename-session-field delete-session-field">
              <span>Session ID</span>
              <input
                value={deleteDialog.value}
                onChange={(event) => setDeleteDialog((current) => (current ? { ...current, value: event.target.value, error: null } : current))}
                disabled={deleteDialog.deleting}
                autoFocus
              />
            </label>
            {deleteDialog.error ? <div className="panel error rename-session-error">{deleteDialog.error}</div> : null}
            <div className="rename-session-actions delete-session-actions">
              <button type="button" onClick={() => setDeleteDialog(null)} disabled={deleteDialog.deleting}>
                Cancel
              </button>
              <button type="submit" disabled={deleteDialog.deleting || deleteDialog.value.trim() !== session.id}>
                {deleteDialog.deleting ? 'Deleting…' : 'Delete Session'}
              </button>
            </div>
          </form>
        </dialog>
      ) : null}
      {renameDialog ? (
        // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-close; keyboard closes via Escape (onCancel) and the Cancel button
        <dialog
          ref={renameDialogRef}
          className="rename-session-dialog"
          aria-label="Rename session"
          onCancel={(event) => {
            event.preventDefault()
            setRenameDialog(null)
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) setRenameDialog(null)
          }}
        >
          <form className="rename-session-form" onSubmit={submitRename}>
            <h2>Rename session</h2>
            <p className="muted">{session.title}</p>
            <label className="rename-session-field">
              <span>Title</span>
              <input
                value={renameDialog.value}
                onChange={(event) => setRenameDialog((current) => (current ? { ...current, value: event.target.value, error: null } : current))}
                disabled={renameDialog.saving}
                autoFocus
              />
            </label>
            {renameDialog.error ? <div className="panel error rename-session-error">{renameDialog.error}</div> : null}
            <div className="rename-session-actions">
              <button type="button" onClick={() => setRenameDialog(null)} disabled={renameDialog.saving}>
                Cancel
              </button>
              <button type="submit" disabled={renameDialog.saving || !renameDialog.value.trim()}>
                {renameDialog.saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </dialog>
      ) : null}
    </>
  )
}

function SessionRow({
  projectId,
  session,
  selected,
  highlighted,
  pinned,
  onSelect,
  ...actions
}: {
  projectId: string
  session: SessionSummary
  selected: boolean
  highlighted?: boolean
  pinned: boolean
  onSelect: () => void
} & SessionActionCallbacks) {
  const tag = session.kind && session.kind !== 'interactive' ? session.kind : session.hasRunningShell ? 'SHELL' : null
  return (
    <li className="session-row-wrap">
      <button
        className={`session-row ${selected ? 'selected' : ''} ${highlighted ? 'highlighted' : ''}`}
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        data-session-id={session.id}
        data-highlighted-session={highlighted ? 'true' : undefined}
      >
        <div className="session-content">
          <div className="session-main">
            <StatusBadge session={session} />
            <strong>{session.title}</strong>
            {tag ? <span className={`session-kind-tag session-kind-${tag.toLowerCase()}`}>{tag}</span> : null}
          </div>
        </div>
        <span className="session-age">{formatAge(session.lastActivityAt)}</span>
      </button>
      <SessionActions projectId={projectId} session={session} pinned={pinned} selected={selected} buttonClassName="session-row-menu-button" {...actions} />
    </li>
  )
}

function isNearScrollEnd(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= LOAD_MORE_SCROLL_THRESHOLD_PX
}

const RAIL_SESSION_PAGE_SIZE = 10

function ProjectSessionList({
  project,
  selectedSessionId,
  highlightedSessionId,
  selectedSessionSummary,
  visibleSessionStates,
  onSelectSession,
  pinnedSessionKeys,
  onSessionCursorStale,
  onHighlightedSessionSeen,
  ...actions
}: {
  project: ProjectSummary
  selectedSessionId: string | null
  highlightedSessionId?: string | null
  selectedSessionSummary?: SessionSummary | null
  visibleSessionStates: Record<string, { loading: boolean; error: boolean }>
  onSelectSession: (projectId: string, sessionId: string) => void
  pinnedSessionKeys: Set<string>
  onSessionCursorStale: (projectId: string) => void
  onHighlightedSessionSeen?: () => void
} & SessionActionCallbacks) {
  const [displayLimit, setDisplayLimit] = useState(RAIL_SESSION_PAGE_SIZE)
  const sessionsRef = useRef<HTMLDivElement | null>(null)
  const loadMoreScrollTopRef = useRef<number | null>(null)
  const seenHighlightedSessionIdRef = useRef<string | null>(null)
  const query = useQuery({
    queryKey: sessionQueryKeys.projectSessionsRailWindow(project.id, displayLimit),
    queryFn: () => fetchProjectSessions(project.id, null, displayLimit),
    placeholderData: keepPreviousData,
    retry: false,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  })
  const rows = query.data?.sessions ?? []
  const pagedRows = rows.slice(0, displayLimit)
  const visibleRows = selectedSessionSummary && !pagedRows.some((session) => session.id === selectedSessionSummary.id) ? [...pagedRows, selectedSessionSummary] : pagedRows

  // biome-ignore lint/correctness/useExhaustiveDependencies: project.id is an intentional reset trigger — reset pagination when the project changes
  useEffect(() => setDisplayLimit(RAIL_SESSION_PAGE_SIZE), [project.id])

  useEffect(() => {
    if (query.error instanceof PaginationCursorStaleError) onSessionCursorStale(project.id)
  }, [onSessionCursorStale, project.id, query.error])

  const loading = query.isLoading || (!query.data && visibleSessionStates[project.id]?.loading)
  const error = query.isError || (!query.data && visibleSessionStates[project.id]?.error)
  const fetching = query.isFetching
  const hasMore = rows.length > displayLimit || query.data?.hasMore
  const highlighted = visibleRows.some((session) => session.id === highlightedSessionId)

  // biome-ignore lint/correctness/useExhaustiveDependencies: visibleRows.length is an intentional trigger — restore scrollTop after "load more" grows the list
  useLayoutEffect(() => {
    const scrollTop = loadMoreScrollTopRef.current
    if (scrollTop === null) return
    if (sessionsRef.current) sessionsRef.current.scrollTop = scrollTop
    if (!fetching) loadMoreScrollTopRef.current = null
  }, [fetching, visibleRows.length])

  useLayoutEffect(() => {
    if (!highlightedSessionId) {
      seenHighlightedSessionIdRef.current = null
      return
    }
    if (!highlighted || seenHighlightedSessionIdRef.current === highlightedSessionId) return
    seenHighlightedSessionIdRef.current = highlightedSessionId
    sessionsRef.current?.querySelector<HTMLElement>('[data-highlighted-session="true"]')?.scrollIntoView({ block: 'nearest' })
    onHighlightedSessionSeen?.()
  }, [highlighted, highlightedSessionId, onHighlightedSessionSeen])

  return (
    // biome-ignore lint/a11y/useSemanticElements: scrollable session list container; <fieldset> would add UA border, padding and min-width
    <div className="project-sessions" id={projectSessionsRegionId(project.id)} role="group" aria-label={`${project.name} sessions`} ref={sessionsRef}>
      {loading ? <SessionListSkeleton /> : null}
      {error ? <div className="rail-empty error-text">Failed to load sessions</div> : null}
      {!loading && !error && rows.length === 0 ? <div className="rail-empty">No sessions</div> : null}
      {visibleRows.length > 0 ? (
        <ol className="session-list rail-session-list">
          {visibleRows.map((session) => (
            <SessionRow
              key={session.id}
              projectId={project.id}
              session={session}
              selected={session.id === selectedSessionId}
              highlighted={session.id === highlightedSessionId}
              pinned={pinnedSessionKeys.has(session.id)}
              onSelect={() => onSelectSession(project.id, session.id)}
              {...actions}
            />
          ))}
        </ol>
      ) : null}
      {hasMore ? (
        <button
          className="load-more-sessions session-load-more"
          type="button"
          onClick={() => {
            loadMoreScrollTopRef.current = sessionsRef.current?.scrollTop ?? null
            setDisplayLimit((limit) => limit + RAIL_SESSION_PAGE_SIZE)
          }}
          disabled={fetching}
          aria-label={fetching ? `Loading more sessions for ${project.name}` : `Show more sessions for ${project.name}`}
          aria-controls={projectSessionsRegionId(project.id)}
        >
          {fetching ? 'Loading…' : 'Show more ↓'}
        </button>
      ) : null}
    </div>
  )
}

function ProjectSessionBranch({
  project,
  selectedProjectId,
  selectedSessionId,
  highlightedSessionId,
  selectedSessionSummary,
  expanded,
  visibleSessionStates,
  onToggleExpanded,
  onSelectProject,
  onSelectSession,
  pinnedSessionKeys,
  onSessionCursorStale,
  onHighlightedSessionSeen,
  ...actions
}: {
  project: ProjectSummary
  selectedProjectId: string | null
  selectedSessionId: string | null
  highlightedSessionId?: string | null
  selectedSessionSummary?: SessionSummary | null
  expanded: boolean
  visibleSessionStates: Record<string, { loading: boolean; error: boolean }>
  onToggleExpanded: () => void
  onSelectProject: () => void
  onSelectSession: (projectId: string, sessionId: string) => void
  pinnedSessionKeys: Set<string>
  onSessionCursorStale: (projectId: string) => void
  onHighlightedSessionSeen?: () => void
} & SessionActionCallbacks) {
  const selected = project.id === selectedProjectId
  const sessionsRegionId = projectSessionsRegionId(project.id)

  return (
    <div className="project-tree-item">
      <ProjectCard project={project} selected={selected} expanded={expanded} sessionsRegionId={sessionsRegionId} onToggleExpanded={onToggleExpanded} onSelectProject={onSelectProject} />
      {expanded ? (
        <ProjectSessionList
          project={project}
          selectedSessionId={selectedSessionId}
          highlightedSessionId={highlightedSessionId}
          selectedSessionSummary={selectedSessionSummary}
          visibleSessionStates={visibleSessionStates}
          onSelectSession={onSelectSession}
          pinnedSessionKeys={pinnedSessionKeys}
          onSessionCursorStale={onSessionCursorStale}
          onHighlightedSessionSeen={onHighlightedSessionSeen}
          {...actions}
        />
      ) : null}
    </div>
  )
}

function RefreshListsButton({ refreshing, reconnecting, onRefresh }: { refreshing?: boolean; reconnecting?: boolean; onRefresh?: () => void }) {
  return (
    <div className={`project-rail-header-actions${reconnecting ? ' reconnecting' : ''}`}>
      {reconnecting ? (
        <span className="project-rail-live-status" role="status">
          Live updates reconnecting…
        </span>
      ) : null}
      <button
        className="project-rail-header-action"
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        aria-label="Refresh pinned, project, and session lists"
        title="Refresh pinned, project, and session lists"
      >
        {refreshing ? (
          <span className="turn-spinner session-age-spinner" aria-hidden="true" />
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true" data-icon="RefreshOutlined">
            <path d="M9.93 4.273a8 8 0 0 1 8.683 3.224h-3.11a1 1 0 0 0 0 2h5.496a1 1 0 0 0 1.001-1V3a1 1 0 1 0-2 0v3a10 10 0 1 0 .66 11 1 1 0 0 0-1.732-1A8 8 0 1 1 9.93 4.273Z" fill="currentColor" />
          </svg>
        )}
      </button>
    </div>
  )
}

export function ProjectSessionRail({
  projects,
  pins = [],
  selectedProjectId,
  selectedSessionId,
  selectedProjectContext,
  selectedSessionSummary,
  highlightedSession,
  projectsHasMore,
  projectsLoadingMore,
  refreshingProjects,
  listUpdatesReconnecting,
  onLoadMoreProjects,
  onRefreshProjects,
  visibleSessionStates,
  onVisibleProjectIdsChange,
  onSelectProject,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onPinSession,
  onForkSession,
  onRestartSession,
  onSessionCursorStale,
  onHighlightedSessionSeen,
}: {
  projects: ProjectSummary[]
  pins?: SessionPin[]
  selectedProjectId: string | null
  selectedSessionId: string | null
  selectedProjectContext?: ProjectSummary | null
  selectedSessionSummary?: SessionSummary | null
  highlightedSession?: { projectId: string; sessionId: string } | null
  projectsHasMore?: boolean
  projectsLoadingMore?: boolean
  refreshingProjects?: boolean
  listUpdatesReconnecting?: boolean
  onLoadMoreProjects?: () => void
  onRefreshProjects?: () => void
  visibleSessionStates: Record<string, { loading: boolean; error: boolean }>
  onVisibleProjectIdsChange?: (projectIds: string[]) => void
  onSelectProject: (projectId: string) => void
  onSelectSession: (projectId: string, sessionId: string) => void
  onDeleteSession?: (projectId: string, sessionId: string, confirmationSessionId: string) => Promise<void>
  onRenameSession?: (projectId: string, sessionId: string, title: string) => Promise<void>
  onPinSession?: (sessionId: string, pinned: boolean) => Promise<void>
  onForkSession?: (projectId: string, sessionId: string) => Promise<unknown>
  onRestartSession?: (sessionId: string) => Promise<void>
  onSessionCursorStale: (projectId: string) => void
  onHighlightedSessionSeen?: () => void
}) {
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set())
  const [expandedPinnedProjectIds, setExpandedPinnedProjectIds] = useState<Set<string>>(() => new Set())
  const [selectionSource, setSelectionSource] = useState<'pinned' | 'projects'>('projects')
  const pendingSelectionRef = useRef<string | null>(null)
  const pinnedGroups = useMemo(() => {
    const groups = new Map<string, { project: ProjectSummary; pins: SessionPin[] }>()
    for (const pin of pins) {
      const group = groups.get(pin.project.id) ?? { project: pin.project, pins: [] }
      group.pins.push(pin)
      groups.set(pin.project.id, group)
    }
    return [...groups.values()].sort((left, right) => right.pins[0]!.pinnedAtMs - left.pins[0]!.pinnedAtMs)
  }, [pins])
  const pinnedSessionKeys = useMemo(() => new Set(pins.map((pin) => pin.session.id)), [pins])
  const projectRows = useMemo(
    () => (selectedProjectContext && !projects.some((project) => project.id === selectedProjectContext.id) ? [...projects, selectedProjectContext] : projects),
    [projects, selectedProjectContext],
  )

  function expandProject(projectId: string) {
    setExpandedProjectIds((current) => {
      if (current.has(projectId)) return current
      const next = new Set(current)
      next.add(projectId)
      return next
    })
  }

  function togglePinnedProject(projectId: string) {
    setExpandedPinnedProjectIds((current) => {
      const next = new Set(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }

  function toggleProject(projectId: string) {
    setExpandedProjectIds((current) => {
      const next = new Set(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: expandProject is redefined every render; adding it would re-run this selection effect each render. It only calls setExpandedProjectIds with an updater (stable identity), so the latest closure is irrelevant — run only when the selection changes.
  useEffect(() => {
    const selectionKey = selectedSessionId ?? `${selectedProjectId ?? ''}\0`
    if (pendingSelectionRef.current === selectionKey) {
      pendingSelectionRef.current = null
      return
    }
    pendingSelectionRef.current = null
    setSelectionSource('projects')
    if (!selectedProjectId) return
    expandProject(selectedProjectId)
    setExpandedPinnedProjectIds((current) => {
      if (!current.has(selectedProjectId)) return current
      const next = new Set(current)
      next.delete(selectedProjectId)
      return next
    })
  }, [selectedProjectId, selectedSessionId])

  // biome-ignore lint/correctness/useExhaustiveDependencies: expandProject is redefined every render; adding it would re-run this effect each render. It only calls setExpandedProjectIds with an updater (stable identity) — run only when the highlighted session changes.
  useEffect(() => {
    if (highlightedSession) expandProject(highlightedSession.projectId)
  }, [highlightedSession])

  useEffect(() => {
    const projectIds = new Set(projectRows.map((project) => project.id))
    setExpandedProjectIds((current) => {
      const next = new Set([...current].filter((projectId) => projectIds.has(projectId)))
      return next.size === current.size ? current : next
    })
  }, [projectRows])

  const visibleProjectIds = useMemo(() => {
    const projectIds = new Set(projectRows.map((project) => project.id))
    return [...new Set([...(selectedProjectId ? [selectedProjectId] : []), ...expandedProjectIds])].filter((projectId) => projectIds.has(projectId)).sort()
  }, [expandedProjectIds, projectRows, selectedProjectId])

  useEffect(() => {
    onVisibleProjectIdsChange?.(visibleProjectIds)
  }, [onVisibleProjectIdsChange, visibleProjectIds])

  function focusSection(source: 'pinned' | 'projects', projectId: string) {
    setSelectionSource(source)
    if (source === 'pinned') {
      setExpandedProjectIds((current) => {
        if (!current.has(projectId)) return current
        const next = new Set(current)
        next.delete(projectId)
        return next
      })
    } else {
      setExpandedPinnedProjectIds((current) => {
        if (!current.has(projectId)) return current
        const next = new Set(current)
        next.delete(projectId)
        return next
      })
    }
  }

  function selectSession(source: 'pinned' | 'projects', projectId: string, sessionId: string) {
    focusSection(source, projectId)
    pendingSelectionRef.current = sessionId
    if (source === 'pinned') setExpandedPinnedProjectIds((current) => new Set(current).add(projectId))
    else expandProject(projectId)
    onSelectSession(projectId, sessionId)
  }

  function handleProjectRailScroll(event: ReactUIEvent<HTMLElement>) {
    if (!projectsHasMore || projectsLoadingMore || !isNearScrollEnd(event.currentTarget)) return
    onLoadMoreProjects?.()
  }

  return (
    <aside className="project-rail" id="project-session-rail" aria-label="Projects and sessions" onScroll={handleProjectRailScroll}>
      {pinnedGroups.length > 0 ? (
        <section className="sidebar-section app-sidebar-pinned" aria-labelledby="pinned-sidebar-section-heading">
          <header className="app-sidebar-projects-header">
            <h2 className="app-sidebar-group-label" id="pinned-sidebar-section-heading">
              PINNED
            </h2>
            <RefreshListsButton refreshing={refreshingProjects} reconnecting={listUpdatesReconnecting} onRefresh={onRefreshProjects} />
          </header>
          <div className="project-tree">
            {pinnedGroups.map(({ project, pins: projectPins }) => {
              const expanded = expandedPinnedProjectIds.has(project.id)
              const regionId = `pinned-${projectSessionsRegionId(project.id)}`
              return (
                <div className="project-card-wrap project-tree-item" key={project.id}>
                  <ProjectCard
                    project={project}
                    selected={selectionSource === 'pinned' && selectedProjectId === project.id}
                    expanded={expanded}
                    sessionsRegionId={regionId}
                    onToggleExpanded={() => {
                      focusSection('pinned', project.id)
                      togglePinnedProject(project.id)
                    }}
                    onSelectProject={() => {
                      pendingSelectionRef.current = `${project.id}\0`
                      onSelectProject(project.id)
                    }}
                  />
                  {expanded ? (
                    <div className="project-sessions" id={regionId}>
                      <ul className="session-list rail-session-list">
                        {projectPins.map((pin) => (
                          <SessionRow
                            key={pin.session.id}
                            projectId={project.id}
                            session={pin.session}
                            selected={selectionSource === 'pinned' && selectedSessionId === pin.session.id}
                            pinned
                            onSelect={() => selectSession('pinned', project.id, pin.session.id)}
                            onDeleteSession={onDeleteSession}
                            onRenameSession={onRenameSession}
                            onPinSession={onPinSession}
                            onForkSession={onForkSession}
                            onRestartSession={onRestartSession}
                          />
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </section>
      ) : null}
      <section className="sidebar-section" aria-labelledby="projects-sidebar-section-heading">
        <header className="app-sidebar-projects-header">
          <h2 className="app-sidebar-group-label" id="projects-sidebar-section-heading">
            PROJECTS
          </h2>
          <RefreshListsButton refreshing={refreshingProjects} reconnecting={listUpdatesReconnecting} onRefresh={onRefreshProjects} />
        </header>
        <div className="project-tree">
          {projectRows.map((project) => (
            <ProjectSessionBranch
              key={project.id}
              project={project}
              selectedProjectId={selectionSource === 'projects' ? selectedProjectId : null}
              selectedSessionId={selectionSource === 'projects' ? selectedSessionId : null}
              highlightedSessionId={highlightedSession?.projectId === project.id ? highlightedSession.sessionId : null}
              selectedSessionSummary={selectedProjectId === project.id ? selectedSessionSummary : null}
              expanded={expandedProjectIds.has(project.id)}
              visibleSessionStates={visibleSessionStates}
              onToggleExpanded={() => {
                focusSection('projects', project.id)
                toggleProject(project.id)
              }}
              onSelectProject={() => {
                pendingSelectionRef.current = `${project.id}\0`
                onSelectProject(project.id)
              }}
              onSelectSession={(projectId, sessionId) => selectSession('projects', projectId, sessionId)}
              pinnedSessionKeys={pinnedSessionKeys}
              onDeleteSession={onDeleteSession}
              onRenameSession={onRenameSession}
              onPinSession={onPinSession}
              onForkSession={onForkSession}
              onRestartSession={onRestartSession}
              onSessionCursorStale={onSessionCursorStale}
              onHighlightedSessionSeen={onHighlightedSessionSeen}
            />
          ))}
          {projectsHasMore ? (
            <button className="load-more-sessions" type="button" onClick={onLoadMoreProjects} disabled={projectsLoadingMore}>
              {projectsLoadingMore ? 'Loading…' : 'Load more projects'}
            </button>
          ) : null}
        </div>
      </section>
    </aside>
  )
}

export function useProjectSessionSelection({ sessionLimit = 10, selectInitialProject = true, enabled = true }: { sessionLimit?: number; selectInitialProject?: boolean; enabled?: boolean } = {}) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [shouldSelectInitialProject, setShouldSelectInitialProject] = useState(selectInitialProject)
  const projectsQuery = useInfiniteQuery({
    queryKey: sessionQueryKeys.projects,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchProjects(pageParam, 20),
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
    retry: false,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    enabled,
  })
  const selectedProjectSessionsQuery = useQuery({
    queryKey: sessionQueryKeys.projectSessionsDetail(selectedProjectId, sessionLimit, selectedSessionId),
    queryFn: async (): Promise<ProjectSessionsResponse & { selectedSessionDetail?: SessionSummary | null }> => {
      const response = await queryProjectSessions([{ projectId: selectedProjectId!, limit: sessionLimit, ...(selectedSessionId ? { selectedSessionId } : {}) }])
      const window = response.sessionsByProject[selectedProjectId!]
      return {
        project: window?.project ?? projectList.find((project) => project.id === selectedProjectId) ?? { id: selectedProjectId!, name: selectedProjectId! },
        sessions: window?.sessions ?? [],
        defaultSessionId: window?.sessions[0]?.id ?? null,
        hasMore: window?.hasMore ?? false,
        nextCursor: window?.nextCursor ?? null,
        selectedSessionDetail: window?.selectedSessionDetail,
      }
    },
    enabled: enabled && Boolean(selectedProjectId),
    retry: false,
    refetchInterval: false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  })
  const projectList = useMemo(() => projectsQuery.data?.pages.flatMap((page) => page.projects) ?? [], [projectsQuery.data])

  useEffect(() => {
    if (shouldSelectInitialProject && !selectedProjectId && projectList.length > 0) setSelectedProjectId(projectList[0]!.id)
  }, [projectList, selectedProjectId, shouldSelectInitialProject])

  const clearSelection = useCallback(() => {
    setShouldSelectInitialProject(false)
    setSelectedProjectId(null)
    setSelectedSessionId(null)
  }, [])
  const selectProject = useCallback((projectId: string) => {
    setShouldSelectInitialProject(false)
    setSelectedProjectId(projectId)
    setSelectedSessionId(null)
  }, [])
  const selectSession = useCallback((projectId: string, sessionId: string) => {
    setShouldSelectInitialProject(false)
    setSelectedProjectId(projectId)
    setSelectedSessionId(sessionId)
  }, [])

  return {
    selectedProjectId,
    selectedSessionId,
    setSelectedSessionId,
    setSelectedProjectId,
    clearSelection,
    projectsQuery,
    selectedProjectSessionsQuery,
    projectList,
    selectProject,
    selectSession,
  }
}
