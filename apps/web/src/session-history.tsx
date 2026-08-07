import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type UIEvent as ReactUIEvent } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { ProjectSessionsResponse, ProjectSummary, SessionSummary } from '@cotta/shared'
import { fetchProjectSessions, fetchProjects, PaginationCursorStaleError, queryProjectSessions } from './api'
import { sessionQueryKeys } from './session-query-refresh'

function formatAge(value?: number): string {
  if (!value) return '—'
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - value) / 1000))
  if (elapsedSeconds < 60) return 'NOW'
  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes < 60) return `${elapsedMinutes}M`
  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours}H`
  const elapsedDays = Math.floor(elapsedHours / 24)
  if (elapsedDays < 30) return `${elapsedDays}D`
  const elapsedMonths = Math.floor(elapsedDays / 30)
  if (elapsedMonths < 12) return `${elapsedMonths}MO`
  return `${Math.floor(elapsedMonths / 12)}Y`
}

function statusTone(session: SessionSummary): string {
  if (session.status === 'busy') return 'running'
  if (session.status === 'waiting') return 'warning'
  return 'neutral'
}

function statusLabel(session: SessionSummary): string {
  if (session.status === 'busy') return 'Busy'
  if (session.status === 'waiting') return 'Waiting'
  return 'Idle'
}

function statusIcon(_session: SessionSummary) {
  return <span className="status-dot" aria-hidden="true" />
}

function isBackgroundKind(kind: string | null): boolean {
  return kind === 'bg' || kind === 'daemon' || kind === 'daemon-worker'
}

function sessionKindTag(session: SessionSummary): string | null {
  if (isBackgroundKind(session.kind)) return 'BG'
  if (session.hasRunningShell) return 'SHELL'
  if (session.entrypoint === 'cli' && (session.status === 'busy' || session.status === 'waiting')) return 'CLI'
  return null
}

function projectSessionsRegionId(projectId: string): string {
  return `project-sessions-${encodeURIComponent(projectId)}`
}

const SIDEBAR_LIST_MOTION_MS = 140
const LOAD_MORE_SCROLL_THRESHOLD_PX = 24

type SidebarMotionState = 'present' | 'entering' | 'exiting'

type SidebarMotionItem<T> = {
  key: string
  item: T
  motionState: SidebarMotionState
}

function prefersReducedSidebarMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function motionStateClass(motionState?: SidebarMotionState): string {
  return motionState && motionState !== 'present' ? ` sidebar-motion-${motionState}` : ''
}

function toPresentMotionItems<T>(items: T[], getKey: (item: T) => string): SidebarMotionItem<T>[] {
  return items.map((item) => ({ key: getKey(item), item, motionState: 'present' }))
}

function mergeMotionItems<T>(current: SidebarMotionItem<T>[], items: T[], getKey: (item: T) => string): SidebarMotionItem<T>[] {
  const nextItems = items.map((item) => ({ key: getKey(item), item }))
  const nextByKey = new Map(nextItems.map((item) => [item.key, item]))
  const currentByKey = new Map(current.map((item) => [item.key, item]))
  const emittedKeys = new Set<string>()
  const merged: SidebarMotionItem<T>[] = []
  let nextIndex = 0

  for (const currentItem of current) {
    if (emittedKeys.has(currentItem.key)) continue
    const nextItem = nextByKey.get(currentItem.key)
    if (!nextItem) {
      merged.push({ ...currentItem, motionState: 'exiting' })
      continue
    }

    while (nextIndex < nextItems.length && nextItems[nextIndex]!.key !== currentItem.key) {
      const pendingItem = nextItems[nextIndex]!
      merged.push({
        key: pendingItem.key,
        item: pendingItem.item,
        motionState: currentByKey.has(pendingItem.key) ? 'present' : 'entering',
      })
      emittedKeys.add(pendingItem.key)
      nextIndex += 1
    }

    merged.push({ key: nextItem.key, item: nextItem.item, motionState: 'present' })
    emittedKeys.add(nextItem.key)
    nextIndex += 1
  }

  while (nextIndex < nextItems.length) {
    const nextItem = nextItems[nextIndex]!
    if (!emittedKeys.has(nextItem.key)) {
      merged.push({
        key: nextItem.key,
        item: nextItem.item,
        motionState: currentByKey.has(nextItem.key) ? 'present' : 'entering',
      })
    }
    nextIndex += 1
  }

  return merged
}

function sameMotionItems<T>(left: SidebarMotionItem<T>[], right: SidebarMotionItem<T>[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const nextItem = right[index]
    return nextItem?.key === item.key && nextItem.item === item.item && nextItem.motionState === item.motionState
  })
}

function useSidebarListMotion<T>(items: T[], getKey: (item: T) => string) {
  const [renderedItems, setRenderedItems] = useState<SidebarMotionItem<T>[]>(() => toPresentMotionItems(items, getKey))
  const exitTimersRef = useRef(new Map<string, number>())
  const enterTimersRef = useRef(new Map<string, number>())

  useEffect(() => {
    if (prefersReducedSidebarMotion()) {
      setRenderedItems((current) => {
        const next = toPresentMotionItems(items, getKey)
        return sameMotionItems(current, next) ? current : next
      })
      return
    }

    setRenderedItems((current) => {
      const merged = mergeMotionItems(current, items, getKey)
      return sameMotionItems(current, merged) ? current : merged
    })
  }, [getKey, items])

  useEffect(() => {
    if (prefersReducedSidebarMotion()) return

    const renderedKeys = new Set(renderedItems.map((item) => item.key))

    for (const item of renderedItems) {
      if (item.motionState === 'entering' && !enterTimersRef.current.has(item.key)) {
        enterTimersRef.current.set(item.key, window.setTimeout(() => {
          enterTimersRef.current.delete(item.key)
          setRenderedItems((current) => current.map((currentItem) => currentItem.key === item.key && currentItem.motionState === 'entering'
            ? { ...currentItem, motionState: 'present' }
            : currentItem))
        }, SIDEBAR_LIST_MOTION_MS))
      }

      if (item.motionState === 'exiting' && !exitTimersRef.current.has(item.key)) {
        exitTimersRef.current.set(item.key, window.setTimeout(() => {
          exitTimersRef.current.delete(item.key)
          setRenderedItems((current) => current.filter((currentItem) => currentItem.key !== item.key || currentItem.motionState !== 'exiting'))
        }, SIDEBAR_LIST_MOTION_MS))
      }
    }

    for (const [key, timer] of enterTimersRef.current) {
      if (!renderedKeys.has(key) || renderedItems.find((item) => item.key === key)?.motionState !== 'entering') {
        window.clearTimeout(timer)
        enterTimersRef.current.delete(key)
      }
    }

    for (const [key, timer] of exitTimersRef.current) {
      if (!renderedKeys.has(key) || renderedItems.find((item) => item.key === key)?.motionState !== 'exiting') {
        window.clearTimeout(timer)
        exitTimersRef.current.delete(key)
      }
    }
  }, [renderedItems])

  useEffect(() => () => {
    for (const timer of exitTimersRef.current.values()) window.clearTimeout(timer)
    for (const timer of enterTimersRef.current.values()) window.clearTimeout(timer)
  }, [])

  return renderedItems
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
      aria-label={`${expanded ? 'Collapse' : 'Expand'} ${project.name} sessions`}
    >
      <div className="project-card-main">
        <span className="project-card-icon" aria-hidden="true">
          <svg viewBox="0 0 48 48" className="project-card-folder-icon" focusable="false">
            <path d="M41.6783 13.6436H24.77c-1.9628-.1072-5.9311-4.2372-8.1881-4.2372H6.6806A2.1762 2.1762 0 0 0 4.5 11.5763v7.3063h39V15.4652A1.8217 1.8217 0 0 0 41.6783 13.6436Z" />
            <path d="M43.5 18.8826H4.5V37.0165a2.1762 2.1762 0 0 0 2.1735 2.1789H41.3194A2.1762 2.1762 0 0 0 43.5 37.0237V18.8826Z" />
          </svg>
        </span>
        <span className="project-card-name">{project.name}</span>
      </div>
      <span className="project-card-chevron" aria-hidden="true">
        <svg viewBox="0 0 12 12" className="project-card-chevron-icon" focusable="false">
          <path d="M4 2.5 8 6 4 9.5" />
        </svg>
      </span>
    </button>
  )
}

function StatusBadge({ session }: { session: SessionSummary }) {
  const tone = statusTone(session)
  const label = statusLabel(session)
  return <span className={`status-badge status-${tone}`} data-tooltip={label} title={label} aria-label={label}>{statusIcon(session)}</span>
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

function SessionRow({
  session,
  selected,
  pending,
  highlighted,
  menuOpen,
  onSelect,
  onOpenMenu,
  motionState,
}: {
  session: SessionSummary
  selected: boolean
  pending?: boolean
  highlighted?: boolean
  menuOpen?: boolean
  onSelect: () => void
  onOpenMenu: (button: HTMLButtonElement) => void
  motionState?: SidebarMotionState
}) {
  const tag = sessionKindTag(session)
  return (
    <li className={`sidebar-motion-item session-row-wrap${motionStateClass(motionState)}`}>
      <button className={`session-row ${selected ? 'selected' : ''} ${highlighted ? 'highlighted' : ''} ${menuOpen ? 'menu-open' : ''}`} type="button" onClick={onSelect} aria-current={selected ? 'true' : undefined}>
        <div className="session-content">
          <div className="session-main">
            <StatusBadge session={session} />
            <strong>{session.title}</strong>
            {tag ? <span className={`session-kind-tag session-kind-${tag.toLowerCase()}`}>{tag}</span> : null}
          </div>
        </div>
        <span className="session-age">{pending ? <span className="turn-spinner session-age-spinner" aria-hidden="true" /> : formatAge(session.lastActivityAt)}</span>
      </button>
      <button
        className="session-row-menu-button"
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen || undefined}
        aria-label={`More actions for ${session.title}`}
        onClick={(event) => { event.stopPropagation(); onOpenMenu(event.currentTarget) }}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="5" cy="10" r="1.4" /><circle cx="10" cy="10" r="1.4" /><circle cx="15" cy="10" r="1.4" /></svg>
      </button>
    </li>
  )
}

function isNearScrollEnd(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= LOAD_MORE_SCROLL_THRESHOLD_PX
}

type ProjectVisualGroup = { id: string; name: string; path?: string }

type ProjectSessionRailGroup = {
  group: ProjectVisualGroup
  projects: ProjectSummary[]
}

function projectVisualGroup(project: ProjectSummary): ProjectVisualGroup {
  return project.projectGroup ?? project
}

function ProjectSessionBranch({
  project,
  selectedProjectId,
  selectedSessionId,
  pendingProjectId,
  pendingSessionId,
  highlightedProjectId,
  highlightedSessionId,
  expanded,
  visibleSessionState,
  onToggleExpanded,
  onSelectProject,
  onSelectSession,
  onOpenSessionMenu,
  openMenuSessionId,
  onCursorStale,
  onHighlightedSessionSeen,
  motionState,
}: {
  project: ProjectSummary
  selectedProjectId: string | null
  selectedSessionId: string | null
  pendingProjectId?: string | null
  pendingSessionId?: string | null
  highlightedProjectId?: string | null
  highlightedSessionId?: string | null
  expanded: boolean
  visibleSessionState?: { loading: boolean; error: boolean }
  onToggleExpanded: () => void
  onSelectProject: () => void
  onSelectSession: (projectId: string, sessionId: string) => void
  onOpenSessionMenu: (projectId: string, session: SessionSummary, button: HTMLButtonElement) => void
  openMenuSessionId: string | null
  onCursorStale: (projectId: string) => void
  onHighlightedSessionSeen?: () => void
  motionState?: SidebarMotionState
}) {
  const sessionsQuery = useInfiniteQuery({
    queryKey: sessionQueryKeys.projectSessionsRail(project.id),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchProjectSessions(project.id, pageParam, 10),
    getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.nextCursor : undefined,
    retry: false,
    enabled: false,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  })
  const sessions = sessionsQuery.data?.pages.flatMap((page) => page.sessions) ?? []
  const renderedSessions = useSidebarListMotion(sessions, (session) => session.id)
  const selected = project.id === selectedProjectId
  const highlighted = project.id === highlightedProjectId && sessions.some((session) => session.id === highlightedSessionId)
  const sessionsRegionId = projectSessionsRegionId(project.id)
  const sessionsRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!highlighted) return
    if (sessionsRef.current) sessionsRef.current.scrollTop = 0
    onHighlightedSessionSeen?.()
  }, [highlighted, onHighlightedSessionSeen])

  return (
    <div className={`project-tree-item sidebar-motion-item${motionStateClass(motionState)}`}>
      <ProjectCard
        project={project}
        selected={selected}
        expanded={expanded}
        sessionsRegionId={sessionsRegionId}
        onToggleExpanded={onToggleExpanded}
        onSelectProject={onSelectProject}
      />
      {expanded ? (
        <div className="project-sessions" id={sessionsRegionId} role="group" aria-label={`${project.name} sessions`} ref={sessionsRef}>
          {sessionsQuery.isLoading || (!sessionsQuery.data && visibleSessionState?.loading) ? <SessionListSkeleton /> : null}
          {sessionsQuery.isError || (!sessionsQuery.data && visibleSessionState?.error) ? <div className="rail-empty error-text">Failed to load sessions</div> : null}
          {!sessionsQuery.isLoading && !visibleSessionState?.loading && !sessionsQuery.isError && !visibleSessionState?.error && sessions.length === 0 && renderedSessions.length === 0 ? <div className="rail-empty">No sessions</div> : null}
          {renderedSessions.length > 0 ? (
            <ol className="session-list rail-session-list">
              {renderedSessions.map(({ key, item: session, motionState }) => (
                <SessionRow
                  key={key}
                  motionState={motionState}
                  session={session}
                  selected={project.id === selectedProjectId && session.id === selectedSessionId}
                  pending={project.id === pendingProjectId && session.id === pendingSessionId}
                  highlighted={project.id === highlightedProjectId && session.id === highlightedSessionId}
                  menuOpen={openMenuSessionId === session.id}
                  onSelect={() => onSelectSession(project.id, session.id)}
                  onOpenMenu={(button) => onOpenSessionMenu(project.id, session, button)}
                />
              ))}
            </ol>
          ) : null}
          {sessionsQuery.hasNextPage ? (
            <button
              className="load-more-sessions session-load-more"
              type="button"
              onClick={() => {
                void sessionsQuery.fetchNextPage({ throwOnError: true }).catch((error) => {
                  if (error instanceof PaginationCursorStaleError) onCursorStale(project.id)
                })
              }}
              disabled={sessionsQuery.isFetchingNextPage}
              aria-label={sessionsQuery.isFetchingNextPage ? `Loading more sessions for ${project.name}` : `Show more sessions for ${project.name}`}
              aria-controls={sessionsRegionId}
            >
              {sessionsQuery.isFetchingNextPage ? 'Loading…' : 'Show more ↓'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function ProjectSessionRail({
  projects,
  selectedProjectId,
  selectedSessionId,
  pendingProjectId,
  pendingSessionId,
  highlightedProjectId,
  highlightedSessionId,
  projectsHasMore,
  projectsLoadingMore,
  onLoadMoreProjects,
  visibleSessionStates,
  onVisibleProjectIdsChange,
  onSelectProject,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onForkSession,
  onSessionCursorStale,
  onHighlightedSessionSeen,
}: {
  projects: ProjectSummary[]
  selectedProjectId: string | null
  selectedSessionId: string | null
  pendingProjectId?: string | null
  pendingSessionId?: string | null
  highlightedProjectId?: string | null
  highlightedSessionId?: string | null
  projectsHasMore?: boolean
  projectsLoadingMore?: boolean
  onLoadMoreProjects?: () => void
  visibleSessionStates: Record<string, { loading: boolean; error: boolean }>
  onVisibleProjectIdsChange?: (projectIds: string[]) => void
  onSelectProject: (projectId: string) => void
  onSelectSession: (projectId: string, sessionId: string) => void
  onDeleteSession?: (projectId: string, sessionId: string, confirmationSessionId: string) => Promise<void>
  onRenameSession?: (projectId: string, sessionId: string, title: string) => Promise<void>
  onForkSession?: (projectId: string, sessionId: string) => Promise<unknown>
  onSessionCursorStale: (projectId: string) => void
  onHighlightedSessionSeen?: () => void
}) {
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set())
  const [openMenu, setOpenMenu] = useState<{ projectId: string; session: SessionSummary; x: number; y: number } | null>(null)
  const [deleteDialog, setDeleteDialog] = useState<{ projectId: string; sessionId: string; title: string; value: string; error: string | null; deleting: boolean } | null>(null)
  const [renameDialog, setRenameDialog] = useState<{ projectId: string; sessionId: string; title: string; value: string; error: string | null; saving: boolean } | null>(null)
  const deleteDialogRef = useRef<HTMLDialogElement | null>(null)
  const renameDialogRef = useRef<HTMLDialogElement | null>(null)
  const projectGroups = useMemo<ProjectSessionRailGroup[]>(() => {
    const groups = new Map<string, ProjectSessionRailGroup>()
    for (const project of projects) {
      const group = projectVisualGroup(project)
      const current = groups.get(group.id)
      if (current) current.projects.push(project)
      else groups.set(group.id, { group, projects: [project] })
    }
    return [...groups.values()]
  }, [projects])
  const renderedProjectGroups = useSidebarListMotion(projectGroups, (group) => group.group.id)

  function expandProject(projectId: string) {
    setExpandedProjectIds((current) => {
      if (current.has(projectId)) return current
      const next = new Set(current)
      next.add(projectId)
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

  useEffect(() => {
    if (selectedProjectId) expandProject(selectedProjectId)
  }, [selectedProjectId])

  useEffect(() => {
    const projectIds = new Set(projects.map((project) => project.id))
    setExpandedProjectIds((current) => {
      const next = new Set([...current].filter((projectId) => projectIds.has(projectId)))
      return next.size === current.size ? current : next
    })
  }, [projects])

  const visibleProjectIds = useMemo(
    () => [...new Set([selectedProjectId, ...expandedProjectIds].filter((projectId): projectId is string => Boolean(projectId) && projects.some((project) => project.id === projectId)))].sort(),
    [expandedProjectIds, projects, selectedProjectId],
  )

  useEffect(() => {
    onVisibleProjectIdsChange?.(visibleProjectIds)
  }, [onVisibleProjectIdsChange, visibleProjectIds])

  useEffect(() => {
    if (!openMenu) return
    function closeMenu(event: globalThis.PointerEvent) {
      const target = event.target as Element | null
      if (target?.closest('.session-row-menu, .session-row-menu-button')) return
      setOpenMenu(null)
    }
    document.addEventListener('pointerdown', closeMenu)
    return () => document.removeEventListener('pointerdown', closeMenu)
  }, [openMenu])

  useEffect(() => {
    const dialog = deleteDialogRef.current
    if (!deleteDialog || !dialog) return
    if (!dialog.open) dialog.showModal()
    function closeDeleteDialog(event: KeyboardEvent) {
      if (event.key === 'Escape') setDeleteDialog(null)
    }
    document.addEventListener('keydown', closeDeleteDialog)
    return () => document.removeEventListener('keydown', closeDeleteDialog)
  }, [deleteDialog])

  useEffect(() => {
    const dialog = renameDialogRef.current
    if (!renameDialog || !dialog) return
    if (!dialog.open) dialog.showModal()
    function closeRenameDialog(event: KeyboardEvent) {
      if (event.key === 'Escape') setRenameDialog(null)
    }
    document.addEventListener('keydown', closeRenameDialog)
    return () => document.removeEventListener('keydown', closeRenameDialog)
  }, [renameDialog])

  function selectSession(projectId: string, sessionId: string) {
    setOpenMenu(null)
    expandProject(projectId)
    onSelectSession(projectId, sessionId)
  }

  function openSessionMenu(projectId: string, session: SessionSummary, button: HTMLButtonElement) {
    const rect = button.getBoundingClientRect()
    setOpenMenu((current) => current?.projectId === projectId && current.session.id === session.id ? null : { projectId, session, x: rect.right, y: rect.bottom + 4 })
  }

  function openDeleteDialog(projectId: string, session: SessionSummary) {
    setOpenMenu(null)
    setDeleteDialog({ projectId, sessionId: session.id, title: session.title, value: '', error: null, deleting: false })
  }

  function openRenameDialog(projectId: string, session: SessionSummary) {
    setOpenMenu(null)
    setRenameDialog({ projectId, sessionId: session.id, title: session.title, value: session.title, error: null, saving: false })
  }

  function forkSessionFromMenu(projectId: string, session: SessionSummary) {
    setOpenMenu(null)
    void onForkSession?.(projectId, session.id)
  }

  async function submitDelete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!deleteDialog || !onDeleteSession) return
    const confirmationSessionId = deleteDialog.value.trim()
    if (confirmationSessionId !== deleteDialog.sessionId) { setDeleteDialog({ ...deleteDialog, error: 'Session ID does not match.' }); return }
    setDeleteDialog({ ...deleteDialog, value: confirmationSessionId, error: null, deleting: true })
    try {
      await onDeleteSession(deleteDialog.projectId, deleteDialog.sessionId, confirmationSessionId)
      setDeleteDialog(null)
    } catch (error) {
      setDeleteDialog((current) => current ? { ...current, deleting: false, error: error instanceof Error ? error.message : String(error) } : current)
    }
  }

  async function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!renameDialog || !onRenameSession) return
    const title = renameDialog.value.trim()
    if (!title) { setRenameDialog({ ...renameDialog, error: 'Title is required.' }); return }
    setRenameDialog({ ...renameDialog, value: title, error: null, saving: true })
    try {
      await onRenameSession(renameDialog.projectId, renameDialog.sessionId, title)
      setRenameDialog(null)
    } catch (error) {
      setRenameDialog((current) => current ? { ...current, saving: false, error: error instanceof Error ? error.message : String(error) } : current)
    }
  }

  function handleProjectRailScroll(event: ReactUIEvent<HTMLElement>) {
    if (!projectsHasMore || projectsLoadingMore || !isNearScrollEnd(event.currentTarget)) return
    onLoadMoreProjects?.()
  }

  return (
    <>
      <aside className="project-rail" id="project-session-rail" aria-label="Projects and sessions" onScroll={handleProjectRailScroll}>
        <section className="sidebar-section" aria-labelledby="projects-sidebar-section-heading">
        <div className="project-tree">
          {renderedProjectGroups.map(({ key, item: projectGroup, motionState }) => (
            <div className={`project-tree-group sidebar-motion-item${motionStateClass(motionState)}`} key={key}>
              {projectGroup.projects.some((project) => project.projectGroup) ? <div className="project-group-label">{projectGroup.group.name}</div> : null}
              <div className="project-group-items">
                {projectGroup.projects.map((project) => (
                  <ProjectSessionBranch
                    key={project.id}
                    project={project}
                    selectedProjectId={selectedProjectId}
                    selectedSessionId={selectedSessionId}
                    pendingProjectId={pendingProjectId}
                    pendingSessionId={pendingSessionId}
                    highlightedProjectId={highlightedProjectId}
                    highlightedSessionId={highlightedSessionId}
                    expanded={expandedProjectIds.has(project.id)}
                    visibleSessionState={visibleSessionStates[project.id]}
                    onToggleExpanded={() => toggleProject(project.id)}
                    onSelectProject={() => onSelectProject(project.id)}
                    onSelectSession={selectSession}
                    onOpenSessionMenu={openSessionMenu}
                    openMenuSessionId={openMenu?.projectId === project.id ? openMenu.session.id : null}
                    onCursorStale={onSessionCursorStale}
                    onHighlightedSessionSeen={onHighlightedSessionSeen}
                  />
                ))}
              </div>
            </div>
          ))}
          {projectsHasMore ? (
            <button className="load-more-sessions" type="button" onClick={onLoadMoreProjects} disabled={projectsLoadingMore}>
              {projectsLoadingMore ? 'Loading…' : 'Load more projects'}
            </button>
          ) : null}
        </div>
        </section>
      </aside>
      {openMenu ? (
        <div className="session-row-menu" role="menu" style={{ left: openMenu.x, top: openMenu.y }}>
          <button type="button" role="menuitem" onClick={() => openRenameDialog(openMenu.projectId, openMenu.session)}>Rename</button>
          {onForkSession ? <button type="button" role="menuitem" onClick={() => forkSessionFromMenu(openMenu.projectId, openMenu.session)}>Fork Session</button> : null}
          <button className="session-row-menu-danger" type="button" role="menuitem" onClick={() => openDeleteDialog(openMenu.projectId, openMenu.session)}>Delete Session</button>
        </div>
      ) : null}
      {deleteDialog ? (
        <dialog ref={deleteDialogRef} className="rename-session-dialog delete-session-dialog" aria-labelledby="delete-session-title" onCancel={(event) => { event.preventDefault(); setDeleteDialog(null) }} onClick={(event) => { if (event.target === event.currentTarget) setDeleteDialog(null) }}>
          <form className="rename-session-form delete-session-form" onSubmit={submitDelete}>
            <h2 id="delete-session-title">Delete session</h2>
            <p className="delete-session-warning">This permanently deletes the session transcript and subagent transcripts. Type the full session ID to confirm.</p>
            <p className="rename-session-target">{deleteDialog.title}</p>
            <code className="delete-session-id">{deleteDialog.sessionId}</code>
            <label className="rename-session-field delete-session-field">
              <span>Session ID</span>
              <input
                value={deleteDialog.value}
                onChange={(event) => setDeleteDialog((current) => current ? { ...current, value: event.target.value, error: null } : current)}
                disabled={deleteDialog.deleting}
                autoFocus
              />
            </label>
            {deleteDialog.error ? <div className="panel error rename-session-error">{deleteDialog.error}</div> : null}
            <div className="rename-session-actions delete-session-actions">
              <button type="button" onClick={() => setDeleteDialog(null)} disabled={deleteDialog.deleting}>Cancel</button>
              <button type="submit" disabled={deleteDialog.deleting || deleteDialog.value.trim() !== deleteDialog.sessionId}>{deleteDialog.deleting ? 'Deleting…' : 'Delete Session'}</button>
            </div>
          </form>
        </dialog>
      ) : null}
      {renameDialog ? (
        <dialog ref={renameDialogRef} className="rename-session-dialog" aria-labelledby="rename-session-title" onCancel={(event) => { event.preventDefault(); setRenameDialog(null) }} onClick={(event) => { if (event.target === event.currentTarget) setRenameDialog(null) }}>
          <form className="rename-session-form" onSubmit={submitRename}>
            <h2 id="rename-session-title">Rename session</h2>
            <p className="muted">{renameDialog.title}</p>
            <label className="rename-session-field">
              <span>Title</span>
              <input
                value={renameDialog.value}
                onChange={(event) => setRenameDialog((current) => current ? { ...current, value: event.target.value, error: null } : current)}
                disabled={renameDialog.saving}
                autoFocus
              />
            </label>
            {renameDialog.error ? <div className="panel error rename-session-error">{renameDialog.error}</div> : null}
            <div className="rename-session-actions">
              <button type="button" onClick={() => setRenameDialog(null)} disabled={renameDialog.saving}>Cancel</button>
              <button type="submit" disabled={renameDialog.saving || !renameDialog.value.trim()}>{renameDialog.saving ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </dialog>
      ) : null}
    </>
  )
}

export function useProjectSessionSelection({ sessionLimit = 10, selectInitialProject = true, enabled = true }: { sessionLimit?: number; selectInitialProject?: boolean; enabled?: boolean } = {}) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [shouldSelectInitialProject, setShouldSelectInitialProject] = useState(selectInitialProject)
  const projects = useInfiniteQuery({
    queryKey: sessionQueryKeys.projects,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchProjects(pageParam, 20),
    getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.nextCursor : undefined,
    retry: false,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    enabled,
  })
  const projectSessions = useQuery({
    queryKey: sessionQueryKeys.projectSessionsDetail(selectedProjectId, sessionLimit),
    queryFn: async (): Promise<ProjectSessionsResponse> => {
      const response = await queryProjectSessions([{ projectId: selectedProjectId!, limit: sessionLimit }])
      const window = response.sessionsByProject[selectedProjectId!]
      return {
        project: items.find((project) => project.id === selectedProjectId) ?? { id: selectedProjectId!, name: selectedProjectId! },
        sessions: window?.sessions ?? [],
        defaultSessionId: window?.sessions[0]?.id ?? null,
        hasMore: window?.hasMore ?? false,
        nextCursor: window?.nextCursor ?? null,
      }
    },
    enabled: enabled && Boolean(selectedProjectId),
    retry: false,
    refetchInterval: false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  })
  const items = useMemo(() => projects.data?.pages.flatMap((page) => page.projects) ?? [], [projects.data])

  useEffect(() => {
    if (shouldSelectInitialProject && !selectedProjectId && items.length > 0) setSelectedProjectId(items[0]!.id)
  }, [items, selectedProjectId, shouldSelectInitialProject])

  const clearSelection = useCallback(() => { setShouldSelectInitialProject(false); setSelectedProjectId(null); setSelectedSessionId(null) }, [])
  const selectProject = useCallback((projectId: string) => { setShouldSelectInitialProject(false); setSelectedProjectId(projectId); setSelectedSessionId(null) }, [])
  const selectSession = useCallback((projectId: string, sessionId: string) => { setShouldSelectInitialProject(false); setSelectedProjectId(projectId); setSelectedSessionId(sessionId) }, [])

  return {
    selectedProjectId,
    selectedSessionId,
    setSelectedSessionId,
    setSelectedProjectId,
    clearSelection,
    projects,
    projectSessions,
    items,
    selectProject,
    selectSession,
  }
}
