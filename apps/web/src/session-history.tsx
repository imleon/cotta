import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent as ReactUIEvent } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { ProjectSessionsResponse, ProjectSummary, SessionSummary } from '@cotta/shared'
import { fetchProjectSessions, fetchProjects, queryProjectSessions } from './api'
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

function statusValue(displayStatus?: string, rawStatus?: string, fallback = 'idle'): string {
  return displayStatus ?? rawStatus ?? fallback
}

function statusTone(value?: string): string {
  const normalized = value?.toLowerCase() ?? ''
  if (normalized.includes('running') || normalized.includes('live')) return 'running'
  if (normalized.includes('fail') || normalized.includes('error')) return 'danger'
  if (normalized.includes('interrupt') || normalized.includes('blocked') || normalized.includes('requires')) return 'warning'
  if (normalized.includes('complete') || normalized.includes('success')) return 'success'
  return 'neutral'
}

function statusLabel(value?: string): string {
  if (!value) return 'Idle'
  const normalized = value.toLowerCase()
  if (normalized === 'complete' || normalized === 'completed') return 'Complete'
  if (normalized.includes('requires')) return 'Action'
  if (normalized.includes('interrupt')) return 'Stopped'
  return value.replaceAll('_', ' ')
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
  const nodeMapRef = useRef(new Map<string, HTMLElement>())
  const lastRectsRef = useRef(new Map<string, DOMRect>())
  const exitTimersRef = useRef(new Map<string, number>())
  const enterTimersRef = useRef(new Map<string, number>())
  const styleTimersRef = useRef(new Map<string, number>())
  const animationFrameRef = useRef<number | null>(null)

  const setItemNode = useCallback((key: string, node: HTMLElement | null) => {
    if (node) nodeMapRef.current.set(key, node)
    else nodeMapRef.current.delete(key)
  }, [])

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

  useLayoutEffect(() => {
    const nodes = nodeMapRef.current
    const nextRects = new Map<string, DOMRect>()
    const reducedMotion = prefersReducedSidebarMotion()
    const movedNodes: HTMLElement[] = []

    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }

    for (const timer of styleTimersRef.current.values()) window.clearTimeout(timer)
    styleTimersRef.current.clear()
    for (const node of nodes.values()) {
      node.style.transition = ''
      node.style.transform = ''
    }

    for (const [key, node] of nodes) {
      const nextRect = node.getBoundingClientRect()
      nextRects.set(key, nextRect)

      if (reducedMotion) {
        node.style.transition = ''
        node.style.transform = ''
        continue
      }

      const previousRect = lastRectsRef.current.get(key)
      if (!previousRect) continue

      const deltaX = previousRect.left - nextRect.left
      const deltaY = previousRect.top - nextRect.top
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) continue

      const styleTimer = styleTimersRef.current.get(key)
      if (styleTimer !== undefined) {
        window.clearTimeout(styleTimer)
        styleTimersRef.current.delete(key)
      }

      node.style.transition = 'none'
      node.style.transform = `translate(${deltaX}px, ${deltaY}px)`
      movedNodes.push(node)
    }

    if (movedNodes.length > 0) {
      void movedNodes[0]!.offsetHeight
      animationFrameRef.current = window.requestAnimationFrame(() => {
        for (const node of movedNodes) {
          node.style.transition = `transform ${SIDEBAR_LIST_MOTION_MS}ms ease`
          node.style.transform = 'translate(0, 0)'
        }

        for (const [key, node] of nodes) {
          if (!movedNodes.includes(node)) continue
          const styleTimer = window.setTimeout(() => {
            node.style.transition = ''
            node.style.transform = ''
            styleTimersRef.current.delete(key)
          }, SIDEBAR_LIST_MOTION_MS)
          styleTimersRef.current.set(key, styleTimer)
        }
      })
    }

    lastRectsRef.current = nextRects
  }, [renderedItems])

  useEffect(() => () => {
    if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current)
    for (const timer of exitTimersRef.current.values()) window.clearTimeout(timer)
    for (const timer of enterTimersRef.current.values()) window.clearTimeout(timer)
    for (const timer of styleTimersRef.current.values()) window.clearTimeout(timer)
  }, [])

  return { items: renderedItems, setItemNode }
}

function ProjectCard({
  project,
  selected,
  expanded,
  sessionsRegionId,
  onToggleExpanded,
}: {
  project: ProjectSummary
  selected: boolean
  expanded: boolean
  sessionsRegionId: string
  onToggleExpanded: () => void
}) {
  return (
    <button
      className={`project-card ${selected ? 'selected' : ''}`}
      type="button"
      onClick={onToggleExpanded}
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
        <h2>{project.name}</h2>
      </div>
      <span className="project-card-chevron" aria-hidden="true">
        <svg viewBox="0 0 12 12" className="project-card-chevron-icon" focusable="false">
          <path d="M4 2.5 8 6 4 9.5" />
        </svg>
      </span>
    </button>
  )
}

function StatusBadge({ value }: { value?: string }) {
  const tone = statusTone(value)
  if (tone === 'neutral') return null
  return <span className={`status-badge status-${tone}`}>{statusLabel(value)}</span>
}

function SessionRow({
  session,
  selected,
  pending,
  onSelect,
  itemRef,
  motionState,
}: {
  session: SessionSummary
  selected: boolean
  pending?: boolean
  onSelect: () => void
  itemRef?: (node: HTMLLIElement | null) => void
  motionState?: SidebarMotionState
}) {
  const state = statusValue(session.displayStatus, session.rawStatus)
  return (
    <li ref={itemRef} className={`sidebar-motion-item${motionStateClass(motionState)}`}>
      <button className={`session-row ${selected ? 'selected' : ''}`} type="button" onClick={onSelect} aria-current={selected ? 'true' : undefined}>
        <div className="session-content">
          <div className="session-main">
            <strong>{session.title}</strong>
          </div>
          <StatusBadge value={state} />
        </div>
        <span className="session-age">{pending ? <span className="turn-spinner session-age-spinner" aria-hidden="true" /> : formatAge(session.lastActivityAt)}</span>
      </button>
    </li>
  )
}

function isNearScrollEnd(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= LOAD_MORE_SCROLL_THRESHOLD_PX
}

function ProjectSessionBranch({
  project,
  selectedProjectId,
  selectedSessionId,
  pendingProjectId,
  pendingSessionId,
  expanded,
  visibleSessionsLoading,
  visibleSessionsError,
  onToggleExpanded,
  onSelectSession,
  itemRef,
  motionState,
}: {
  project: ProjectSummary
  selectedProjectId: string | null
  selectedSessionId: string | null
  pendingProjectId?: string | null
  pendingSessionId?: string | null
  expanded: boolean
  visibleSessionsLoading?: boolean
  visibleSessionsError?: boolean
  onToggleExpanded: () => void
  onSelectSession: (projectId: string, sessionId: string) => void
  itemRef?: (node: HTMLDivElement | null) => void
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
  const sessionMotion = useSidebarListMotion(sessions, (session) => session.id)
  const selected = project.id === selectedProjectId
  const sessionsRegionId = projectSessionsRegionId(project.id)

  return (
    <div ref={itemRef} className={`project-tree-item sidebar-motion-item${motionStateClass(motionState)}`}>
      <ProjectCard
        project={project}
        selected={selected}
        expanded={expanded}
        sessionsRegionId={sessionsRegionId}
        onToggleExpanded={onToggleExpanded}
      />
      {expanded ? (
        <div className="project-sessions" id={sessionsRegionId} role="group" aria-label={`${project.name} sessions`}>
          {sessionsQuery.isLoading || (!sessionsQuery.data && visibleSessionsLoading) ? <div className="rail-empty">Loading sessions…</div> : null}
          {sessionsQuery.isError || (!sessionsQuery.data && visibleSessionsError) ? <div className="rail-empty error-text">Failed to load sessions</div> : null}
          {!sessionsQuery.isLoading && !visibleSessionsLoading && !sessionsQuery.isError && !visibleSessionsError && sessions.length === 0 && sessionMotion.items.length === 0 ? <div className="rail-empty">No sessions</div> : null}
          {sessionMotion.items.length > 0 ? (
            <ol className="session-list rail-session-list">
              {sessionMotion.items.map(({ key, item: session, motionState }) => (
                <SessionRow
                  key={key}
                  itemRef={(node) => sessionMotion.setItemNode(key, node)}
                  motionState={motionState}
                  session={session}
                  selected={project.id === selectedProjectId && session.id === selectedSessionId}
                  pending={project.id === pendingProjectId && session.id === pendingSessionId}
                  onSelect={() => onSelectSession(project.id, session.id)}
                />
              ))}
            </ol>
          ) : null}
          {sessionsQuery.hasNextPage ? (
            <button className="load-more-sessions" type="button" onClick={() => sessionsQuery.fetchNextPage()} disabled={sessionsQuery.isFetchingNextPage}>
              {sessionsQuery.isFetchingNextPage ? 'Loading…' : 'Load more sessions'}
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
  projectsHasMore,
  projectsLoadingMore,
  onLoadMoreProjects,
  visibleSessionsLoading,
  visibleSessionsError,
  onVisibleProjectIdsChange,
  onSelectSession,
}: {
  projects: ProjectSummary[]
  selectedProjectId: string | null
  selectedSessionId: string | null
  pendingProjectId?: string | null
  pendingSessionId?: string | null
  projectsHasMore?: boolean
  projectsLoadingMore?: boolean
  onLoadMoreProjects?: () => void
  visibleSessionsLoading?: boolean
  visibleSessionsError?: boolean
  onVisibleProjectIdsChange?: (projectIds: string[]) => void
  onSelectSession: (projectId: string, sessionId: string) => void
}) {
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set())
  const projectMotion = useSidebarListMotion(projects, (project) => project.id)

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

  const visibleProjectIds = useMemo(
    () => [...new Set([selectedProjectId, ...expandedProjectIds].filter((projectId): projectId is string => Boolean(projectId)))].sort(),
    [expandedProjectIds, selectedProjectId],
  )

  useEffect(() => {
    onVisibleProjectIdsChange?.(visibleProjectIds)
  }, [onVisibleProjectIdsChange, visibleProjectIds])

  function selectSession(projectId: string, sessionId: string) {
    expandProject(projectId)
    onSelectSession(projectId, sessionId)
  }

  function handleProjectRailScroll(event: ReactUIEvent<HTMLElement>) {
    if (!projectsHasMore || projectsLoadingMore || !isNearScrollEnd(event.currentTarget)) return
    onLoadMoreProjects?.()
  }

  return (
    <aside className="project-rail" id="project-session-rail" aria-label="Projects and sessions" onScroll={handleProjectRailScroll}>
      <section className="sidebar-section" aria-labelledby="projects-sidebar-section-heading">
        <div className="project-tree">
          {projectMotion.items.map(({ key, item: project, motionState }) => (
            <ProjectSessionBranch
              key={key}
              itemRef={(node) => projectMotion.setItemNode(key, node)}
              motionState={motionState}
              project={project}
              selectedProjectId={selectedProjectId}
              selectedSessionId={selectedSessionId}
              pendingProjectId={pendingProjectId}
              pendingSessionId={pendingSessionId}
              expanded={expandedProjectIds.has(project.id)}
              visibleSessionsLoading={visibleSessionsLoading}
              visibleSessionsError={visibleSessionsError}
              onToggleExpanded={() => toggleProject(project.id)}
              onSelectSession={selectSession}
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

export function useProjectSessionSelection({ sessionLimit = 10 }: { sessionLimit?: number } = {}) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const projects = useInfiniteQuery({
    queryKey: sessionQueryKeys.projects,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchProjects(pageParam, 20),
    getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.nextCursor : undefined,
    retry: false,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
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
    enabled: Boolean(selectedProjectId),
    retry: false,
    refetchInterval: false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  })
  const items = projects.data?.pages.flatMap((page) => page.projects) ?? []

  useEffect(() => { if (!selectedProjectId && items.length > 0) setSelectedProjectId(items[0]!.id) }, [items, selectedProjectId])

  return {
    selectedProjectId,
    selectedSessionId,
    setSelectedSessionId,
    setSelectedProjectId,
    startNewSession: (projectId: string) => {
      setSelectedProjectId(projectId)
      setSelectedSessionId(null)
    },
    projects,
    projectSessions,
    items,
    selectProject: (projectId: string) => { setSelectedProjectId(projectId); setSelectedSessionId(null) },
    selectSession: (projectId: string, sessionId: string) => { setSelectedProjectId(projectId); setSelectedSessionId(sessionId) },
  }
}
