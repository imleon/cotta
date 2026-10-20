import { type AppSettings, appSettingsSchema, type ListVersionsEvent, type ProjectSessionSearchMatch, type ProjectSessionSearchResult, type SessionRuntimeResponse } from '@cotta/shared'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { type CSSProperties, type PointerEvent as ReactPointerEvent, StrictMode, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  connectListVersions,
  deleteSession,
  ensureSessionRuntime,
  fetchAuthSession,
  fetchSessionPins,
  fetchSessionProject,
  fetchSessionTimeline,
  fetchSettings,
  forkSession,
  logout,
  PaginationCursorStaleError,
  queryProjectSessions,
  refreshModelCatalog,
  refreshProjects,
  renameSession,
  restartSessionRuntime,
  SessionRuntimeHttpError,
  setSessionPinned,
  TimelineSnapshotStaleError,
} from './api'
import { AccessRequired } from './app/access-required'
import { AgentsPage } from './app/agents-page'
import { AnonTurnDetail } from './app/anon-turn-detail'
import { AnonTurnShare } from './app/anon-turn-share'
import {
  APP_NAV_ITEMS,
  APP_SIDEBAR_COLLAPSE_WIDTH,
  APP_SIDEBAR_DEFAULT_WIDTH,
  APP_SIDEBAR_LAST_EXPANDED_WIDTH_STORAGE_KEY,
  APP_SIDEBAR_MIN_WIDTH,
  APP_SIDEBAR_WIDTH_STORAGE_KEY,
  AppLayout,
  type AppNavKey,
  AppSidebar,
  appNavKeyFromPath,
  appNavPath,
  chatPath,
  clampAppSidebarWidth,
  LEGACY_APP_SIDEBAR_LAST_EXPANDED_WIDTH_STORAGE_KEY,
  LEGACY_APP_SIDEBAR_WIDTH_STORAGE_KEY,
  type SessionLocation,
  sessionLocationFromPath,
  terminalOpenFromLocation,
} from './app/app-layout'
import { appsLayout, TOOL_PANEL_MIN_HEIGHT, TOOL_PANEL_MIN_WIDTH, type ToolLayout, terminalHeightMax, terminalWidthMax } from './app/apps-layout'
import { ProjectListSkeleton, ProjectSessionRail, useProjectSessionSelection, WorktreeBadge } from './app/session-history'
import {
  acknowledgeListRefresh,
  createListVersionState,
  markSessionSearchCacheStale,
  type ProjectRefreshResult,
  planListVersionEvent,
  refreshProjectsWindow,
  refreshVisibleProjectSessions,
  relocatedSelectedSession,
  removeProjectSessionFromCache,
  removeSessionFromSearchCache,
  resetSessionSearchCache,
  selectedSessionFromRailCache,
  sessionQueryKeys,
  shouldClearMissingSelection,
} from './app/session-query-refresh'
import { SessionSearchDialog } from './app/session-search-dialog'
import { SettingsPanel } from './app/settings-panel'
import { ShareManagementPanel } from './app/share-management-panel'
import { faviconHref, tabStatus } from './app/tab-status'
import { TerminalPanel } from './app/terminal-panel'
import type { ToastState } from './app/turn-composer'
import { WORKSPACE_EXPLORER_DEFAULT_WIDTH } from './app/workspace-explorer-layout'
import { WorkspacePanel, WorkspacePaneToggleIcon } from './app/workspace-panel'
import type { TimelineControlSignal, TranscriptSignal } from './timeline'
import 'react-medium-image-zoom/dist/styles.css'
import './styles.css'

function PlaceholderPage({ title }: { title: string }) {
  return (
    <section className="detail-panel app-placeholder-view" aria-label={title}>
      <div className="settings-section">
        <h2>{title}</h2>
        <p className="muted">Coming soon.</p>
      </div>
    </section>
  )
}

/** Project recorded on the current `/` history entry by the URL sync; null means home (no Project). */
function historyProjectId(): string | null {
  const projectId = (history.state as { projectId?: unknown } | null)?.projectId
  return typeof projectId === 'string' ? projectId : null
}

type SearchSelection = { kind: 'metadata'; result: ProjectSessionSearchResult } | { kind: 'message'; result: ProjectSessionSearchResult; match: ProjectSessionSearchMatch }

type SearchTarget = { kind: 'message'; turnId: string; messageUuid: string; blockIndex?: number; queryNonce: number } | { kind: 'jump-latest'; queryNonce: number }

function WorkspaceShell() {
  const queryClient = useQueryClient()
  const [activeAppNav, setActiveAppNav] = useState<AppNavKey>(appNavKeyFromPath)
  const [terminalOpen, setTerminalOpen] = useState(terminalOpenFromLocation)
  const [terminalConnected, setTerminalConnected] = useState(false)
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
    retry: false,
  })
  const authSession = useQuery({ queryKey: ['auth-session'], queryFn: fetchAuthSession, retry: false })
  const sessionPins = useQuery({ queryKey: sessionQueryKeys.sessionPins, queryFn: fetchSessionPins, retry: false })
  const settings: AppSettings = settingsQuery.data?.settings ?? appSettingsSchema.parse({})
  const catalogMissing = settingsQuery.isSuccess && !settings.modelCatalog
  const authed = Boolean(authSession.data?.authenticated)
  const workspaceActive = activeAppNav === 'chat'
  const selection = useProjectSessionSelection({ selectInitialProject: false })
  const { selectedProjectId, selectedSessionId, clearSelection, selectProject, selectSession: selectSessionOwner, setSelectedSessionId } = selection
  const [sidebarWidth, setSidebarWidth] = useState(APP_SIDEBAR_DEFAULT_WIDTH)
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const [terminalWidth, setTerminalWidth] = useState(420)
  const [terminalHeight, setTerminalHeight] = useState(280)
  const [terminalLayout, setTerminalLayout] = useState<ToolLayout>('side')
  const [shellSize, setShellSize] = useState({ width: 0, height: 0 })
  const [terminalResizing, setTerminalResizing] = useState(false)
  const [projectChoiceOpen, setProjectChoiceOpen] = useState(false)
  const [refreshingLists, setRefreshingLists] = useState(false)
  const [listUpdatesReconnecting, setListUpdatesReconnecting] = useState(false)
  const [transcriptSignal, setTranscriptSignal] = useState<{ projectId: string; sessionId: string; signal: TranscriptSignal } | null>(null)
  const [timelineControlSignal, setTimelineControlSignal] = useState<{ projectId: string; sessionId: string; signal: TimelineControlSignal } | null>(null)
  const [timelineInstanceNonce, setTimelineInstanceNonce] = useState(0)
  const [selectedSessionRuntime, setSelectedSessionRuntime] = useState<SessionRuntimeResponse | null>(null)
  const [unavailableProjectId, setUnavailableProjectId] = useState<string | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  // The catalog may be absent at boot when a model provider's upstream only authenticates after login
  // (server defers it). Once authenticated with no catalog yet, fetch it once so the composer/Settings
  // model menus aren't empty; refreshModelCatalog persists it, so this self-heals after one success. A
  // failure means the model backend is unreachable — surface it instead of leaving empty menus silently.
  useEffect(() => {
    if (!authed || !catalogMissing) return
    let cancelled = false
    refreshModelCatalog(null)
      .then((response) => {
        if (!cancelled) queryClient.setQueryData(['settings'], response)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const message = error instanceof Error ? error.message : String(error)
        setToast({ message: `Model catalog unavailable: ${message}. Open Settings → Default model to retry.`, tone: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [authed, catalogMissing, queryClient])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchNavigation, setSearchNavigation] = useState<{ sessionId: string; anchorTurnId: string | null; target: SearchTarget | null } | null>(null)
  const [highlightedRailSession, setHighlightedRailSession] = useState<{ projectId: string; sessionId: string } | null>(null)
  const [selectedRailContext, setSelectedRailContext] = useState<{ project: ProjectSessionSearchResult['project']; session: ProjectSessionSearchResult['session'] } | null>(null)
  const [highlightedRailSeen, setHighlightedRailSeen] = useState(false)
  const [explorerOpen, setExplorerOpen] = useState(false)
  const [explorerPaneWidth, setExplorerPaneWidth] = useState<number | null>(WORKSPACE_EXPLORER_DEFAULT_WIDTH)
  const [visibleSessionStates, setVisibleSessionStates] = useState<Record<string, { generation: number; loading: boolean; error: boolean }>>({})
  const [visibleProjectIds, setVisibleProjectIds] = useState<string[]>([])
  const sidebarWidthRef = useRef(APP_SIDEBAR_DEFAULT_WIDTH)
  const terminalWidthRef = useRef(420)
  const appLayoutRef = useRef<HTMLDivElement | null>(null)
  const lastExpandedSidebarWidthRef = useRef(APP_SIDEBAR_DEFAULT_WIDTH)
  const pendingSessionRequestRef = useRef(0)
  const pendingCreatedSelectionRef = useRef<{ projectId: string; sessionId: string } | null>(null)
  const listVersionStateRef = useRef(createListVersionState())
  const visibleSessionGenerationsRef = useRef(new Map<string, number>())
  const projectLoadMoreInFlightRef = useRef(false)
  const searchTriggerRef = useRef<HTMLButtonElement | null>(null)
  const searchQueryNonceRef = useRef(0)
  // Intent id of an in-flight URL → selection resolution; selection → URL sync waits while it is current.
  const urlResolvingIntentRef = useRef<number | null>(null)
  // Set by user navigation (showChat, session created); the URL sync in the same render pushes instead of replacing.
  const pushNextUrlRef = useRef(false)
  const [, setUrlResolvedTick] = useState(0)
  const applyLocationSessionRef = useRef<(location: SessionLocation | null) => Promise<void>>(async () => {})
  const urlTurnId = searchNavigation?.sessionId === selectedSessionId ? searchNavigation.anchorTurnId : null
  const currentChatPath = chatPath(selectedSessionId ? { sessionId: selectedSessionId, turnId: urlTurnId } : null)
  useEffect(() => {
    void applyLocationSessionRef.current(sessionLocationFromPath())
    function syncLocation() {
      const nav = appNavKeyFromPath()
      setActiveAppNav(nav)
      setTerminalOpen(terminalOpenFromLocation())
      if (nav === 'chat') void applyLocationSessionRef.current(sessionLocationFromPath())
    }
    window.addEventListener('popstate', syncLocation)
    return () => window.removeEventListener('popstate', syncLocation)
  }, [])
  // Runs after every render: user navigation pushes, derived selection changes (reconcile, jump to latest,
  // failed or superseded URL resolution) replace so history only holds places the user navigated to.
  // `/` entries record the selected Project so back/forward tells home apart from a pending new session.
  useEffect(() => {
    if (activeAppNav !== 'chat') return
    if (urlResolvingIntentRef.current !== null && urlResolvingIntentRef.current === pendingSessionRequestRef.current) return
    const push = pushNextUrlRef.current
    pushNextUrlRef.current = false
    const state = currentChatPath === '/' ? { projectId: selectedProjectId } : null
    if (window.location.pathname === currentChatPath) {
      if (state && historyProjectId() !== state.projectId) history.replaceState(state, '', window.location.href)
      return
    }
    history[push ? 'pushState' : 'replaceState'](state, '', `${currentChatPath}${window.location.search}`)
  })
  useEffect(() => {
    if (!workspaceActive || !terminalOpen || shellSize.width <= 0) return
    setTerminalLayout(
      appsLayout({
        shellWidth: shellSize.width,
        requestedSidebarWidth: sidebarWidth,
        explorerOpen,
        toolOpen: true,
        requestedToolWidth: terminalWidth,
      }).toolLayout,
    )
  }, [explorerOpen, shellSize.width, sidebarWidth, terminalOpen, terminalWidth, workspaceActive])

  useEffect(() => {
    if (activeAppNav !== 'settings' || window.location.hash !== '#settings-account-heading') return
    requestAnimationFrame(() => document.getElementById('settings-account-heading')?.scrollIntoView({ block: 'start' }))
  }, [activeAppNav])
  function navigateAppNav(nextNav: AppNavKey) {
    if (nextNav === 'chat') beginNewConversation()
    history.pushState(null, '', appNavPath(nextNav))
    setActiveAppNav(nextNav)
    setTerminalOpen(false)
  }

  async function handleLogout() {
    await logout()
    await authSession.refetch()
  }

  const beginSelectionIntent = useCallback((): number => {
    pendingCreatedSelectionRef.current = null
    const requestId = pendingSessionRequestRef.current + 1
    pendingSessionRequestRef.current = requestId
    return requestId
  }, [])

  function beginNewConversation() {
    beginSelectionIntent()
    setSelectedRailContext(null)
    setSelectedSessionRuntime(null)
    selection.clearSelection()
  }

  function showChat() {
    pushNextUrlRef.current = true
    setActiveAppNav('chat')
  }

  function openTerminal() {
    const search = new URLSearchParams(window.location.search)
    search.set('terminal', '1')
    history.pushState(null, '', `${currentChatPath}?${search}`)
    setActiveAppNav('chat')
    setTerminalOpen(true)
  }

  function toggleTerminal() {
    if (terminalOpen) closeTerminal()
    else openTerminal()
  }

  function closeTerminal() {
    const search = new URLSearchParams(window.location.search)
    search.delete('terminal')
    history.pushState(null, '', `${window.location.pathname}${search.size ? `?${search}` : ''}${window.location.hash}`)
    setTerminalOpen(false)
  }

  function closeSearch(cancelSelection = true) {
    if (cancelSelection) beginSelectionIntent()
    setSearchOpen(false)
    requestAnimationFrame(() => searchTriggerRef.current?.focus())
  }

  function openStats() {
    showChat()
    setExplorerOpen(false)
    beginNewConversation()
  }

  function beginNewSession() {
    showChat()
    setSelectedRailContext(null)
    if (!selectedProjectId) {
      beginNewConversation()
      return
    }
    beginSelectionIntent()
    setSelectedSessionRuntime(null)
    setSelectedSessionId(null)
  }

  function startPendingProject(projectId: string) {
    beginSelectionIntent()
    setSelectedRailContext(null)
    setProjectChoiceOpen(false)
    setSelectedSessionRuntime(null)
    selection.selectProject(projectId)
  }

  function handleSessionCreated(projectId: string, sessionId: string) {
    beginSelectionIntent()
    pushNextUrlRef.current = true
    setSelectedRailContext(null)
    pendingCreatedSelectionRef.current = { projectId, sessionId }
    selection.selectSession(projectId, sessionId)
    setSelectedSessionRuntime(null)
    setUnavailableProjectId(null)
  }

  function revealRailSession(projectId: string, sessionId: string) {
    if (sidebarCollapsed) expandAppSidebar()
    setHighlightedRailSession({ projectId, sessionId })
    setHighlightedRailSeen(false)
  }

  async function handleForkSession(projectId: string, sessionId: string, upToMessageId?: string) {
    try {
      const fork = await forkSession(projectId, sessionId, upToMessageId)
      setHighlightedRailSession(fork)
      setHighlightedRailSeen(false)
      await refreshProjectsOnly()
      await refreshVisibleWindows([projectId])
      setToast({ message: 'Fork created', tone: 'success' })
      return fork
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setToast({ message: `Failed to fork session: ${message}`, tone: 'error' })
      throw error
    }
  }

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(null), 2200)
    return () => window.clearTimeout(timeout)
  }, [toast])

  useEffect(() => {
    if (!highlightedRailSession || !highlightedRailSeen) return
    const timeout = window.setTimeout(() => {
      setHighlightedRailSession(null)
      setHighlightedRailSeen(false)
    }, 2500)
    return () => window.clearTimeout(timeout)
  }, [highlightedRailSeen, highlightedRailSession])

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth
  }, [sidebarWidth])

  useEffect(() => {
    terminalWidthRef.current = terminalWidth
  }, [terminalWidth])

  useEffect(() => {
    const appLayout = appLayoutRef.current
    if (!appLayout) return
    const update = () => {
      const bounds = appLayout.getBoundingClientRect()
      setShellSize({ width: bounds.width, height: bounds.height })
    }
    update()
    if (!('ResizeObserver' in window)) return
    const observer = new ResizeObserver(update)
    observer.observe(appLayout)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let storedExpandedValue: string | null = null
    try {
      storedExpandedValue = window.localStorage.getItem(APP_SIDEBAR_LAST_EXPANDED_WIDTH_STORAGE_KEY)
      if (storedExpandedValue === null) {
        storedExpandedValue = window.localStorage.getItem(LEGACY_APP_SIDEBAR_LAST_EXPANDED_WIDTH_STORAGE_KEY)
        if (storedExpandedValue !== null) window.localStorage.setItem(APP_SIDEBAR_LAST_EXPANDED_WIDTH_STORAGE_KEY, storedExpandedValue)
      }
      window.localStorage.removeItem(LEGACY_APP_SIDEBAR_LAST_EXPANDED_WIDTH_STORAGE_KEY)
    } catch {
      // ignore localStorage migration errors
    }
    const storedExpandedWidth = Number(storedExpandedValue)
    if (storedExpandedValue !== null && Number.isFinite(storedExpandedWidth)) {
      const expandedWidth = clampAppSidebarWidth(storedExpandedWidth)
      if (expandedWidth > APP_SIDEBAR_COLLAPSE_WIDTH) lastExpandedSidebarWidthRef.current = expandedWidth
    }

    let storedValue: string | null = null
    try {
      storedValue = window.localStorage.getItem(APP_SIDEBAR_WIDTH_STORAGE_KEY)
      if (storedValue === null) {
        storedValue = window.localStorage.getItem(LEGACY_APP_SIDEBAR_WIDTH_STORAGE_KEY)
        if (storedValue !== null) window.localStorage.setItem(APP_SIDEBAR_WIDTH_STORAGE_KEY, storedValue)
      }
      window.localStorage.removeItem(LEGACY_APP_SIDEBAR_WIDTH_STORAGE_KEY)
    } catch {
      // ignore localStorage migration errors
    }
    const storedWidth = Number(storedValue)
    if (storedValue === null || !Number.isFinite(storedWidth)) return
    const clampedWidth = clampAppSidebarWidth(storedWidth)
    const nextWidth = clampedWidth <= APP_SIDEBAR_COLLAPSE_WIDTH ? APP_SIDEBAR_MIN_WIDTH : clampedWidth
    sidebarWidthRef.current = nextWidth
    if (nextWidth > APP_SIDEBAR_COLLAPSE_WIDTH) lastExpandedSidebarWidthRef.current = nextWidth
    setSidebarWidth(nextWidth)
  }, [])

  function beginSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    const pointerId = event.pointerId
    const startX = event.clientX
    const startWidth = effectiveSidebarWidth
    setSidebarResizing(true)
    handle.setPointerCapture?.(pointerId)

    function handlePointerMove(moveEvent: PointerEvent) {
      if (moveEvent.pointerId !== pointerId) return
      const requestedWidth = startWidth + moveEvent.clientX - startX
      const clampedWidth = clampAppSidebarWidth(requestedWidth)
      const nextWidth = clampedWidth <= APP_SIDEBAR_COLLAPSE_WIDTH ? APP_SIDEBAR_MIN_WIDTH : clampedWidth
      sidebarWidthRef.current = nextWidth
      setSidebarWidth(nextWidth)
    }

    function finishResize() {
      const settledWidth = sidebarWidthRef.current <= APP_SIDEBAR_COLLAPSE_WIDTH ? APP_SIDEBAR_MIN_WIDTH : sidebarWidthRef.current
      sidebarWidthRef.current = settledWidth
      setSidebarWidth(settledWidth)
      if (settledWidth > APP_SIDEBAR_COLLAPSE_WIDTH) lastExpandedSidebarWidthRef.current = settledWidth
      setSidebarResizing(false)
      try {
        handle.releasePointerCapture?.(pointerId)
      } catch {
        // ignore pointer capture release errors
      }
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
      try {
        window.localStorage.setItem(APP_SIDEBAR_WIDTH_STORAGE_KEY, String(settledWidth))
        if (settledWidth > APP_SIDEBAR_COLLAPSE_WIDTH) window.localStorage.setItem(APP_SIDEBAR_LAST_EXPANDED_WIDTH_STORAGE_KEY, String(settledWidth))
      } catch {
        // ignore localStorage write errors
      }
    }

    function handlePointerUp(event: PointerEvent) {
      if (event.pointerId === pointerId) finishResize()
    }

    function handlePointerCancel(event: PointerEvent) {
      if (event.pointerId === pointerId) finishResize()
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
  }

  function beginTerminalResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0) return
    const appLayout = appLayoutRef.current
    if (!appLayout) return
    event.preventDefault()
    const handle = event.currentTarget
    const pointerId = event.pointerId
    const startX = event.clientX
    const startY = event.clientY
    const startWidth = terminalWidthRef.current
    const startHeight = terminalHeight
    const bounds = appLayout.getBoundingClientRect()
    setTerminalResizing(true)
    handle.setPointerCapture?.(pointerId)

    function handlePointerMove(moveEvent: PointerEvent) {
      if (moveEvent.pointerId !== pointerId) return
      if (terminalLayout === 'bottom') {
        const maxHeight = terminalHeightMax(bounds.height) ?? terminalHeight
        setTerminalHeight(Math.min(maxHeight, Math.max(TOOL_PANEL_MIN_HEIGHT, startHeight + startY - moveEvent.clientY)))
        return
      }
      const appsWidth = appsLayout({ shellWidth: bounds.width, requestedSidebarWidth: sidebarWidthRef.current, explorerOpen, toolOpen: true, requestedToolWidth: terminalWidthRef.current }).appsWidth
      const maxWidth = terminalWidthMax(appsWidth, explorerOpen)
      const nextWidth = Math.min(maxWidth, Math.max(TOOL_PANEL_MIN_WIDTH, startWidth + startX - moveEvent.clientX))
      terminalWidthRef.current = nextWidth
      setTerminalWidth(nextWidth)
    }

    function finishResize() {
      setTerminalResizing(false)
      try {
        handle.releasePointerCapture?.(pointerId)
      } catch {
        // ignore pointer capture release errors
      }
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
    }

    function handlePointerUp(upEvent: PointerEvent) {
      if (upEvent.pointerId === pointerId) finishResize()
    }

    function handlePointerCancel(cancelEvent: PointerEvent) {
      if (cancelEvent.pointerId === pointerId) finishResize()
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
  }

  function expandAppSidebar() {
    const nextWidth = lastExpandedSidebarWidthRef.current > APP_SIDEBAR_COLLAPSE_WIDTH ? lastExpandedSidebarWidthRef.current : APP_SIDEBAR_DEFAULT_WIDTH
    sidebarWidthRef.current = nextWidth
    setSidebarWidth(nextWidth)
    try {
      window.localStorage.setItem(APP_SIDEBAR_WIDTH_STORAGE_KEY, String(nextWidth))
      window.localStorage.setItem(APP_SIDEBAR_LAST_EXPANDED_WIDTH_STORAGE_KEY, String(nextWidth))
    } catch {}
  }

  function toggleAppSidebar() {
    const nextWidth = sidebarCollapsed ? APP_SIDEBAR_DEFAULT_WIDTH : APP_SIDEBAR_MIN_WIDTH
    sidebarWidthRef.current = nextWidth
    setSidebarWidth(nextWidth)
    if (nextWidth > APP_SIDEBAR_COLLAPSE_WIDTH) lastExpandedSidebarWidthRef.current = nextWidth
    try {
      window.localStorage.setItem(APP_SIDEBAR_WIDTH_STORAGE_KEY, String(nextWidth))
      if (nextWidth > APP_SIDEBAR_COLLAPSE_WIDTH) window.localStorage.setItem(APP_SIDEBAR_LAST_EXPANDED_WIDTH_STORAGE_KEY, String(nextWidth))
    } catch {}
  }

  const terminalVisible = workspaceActive && terminalOpen
  const {
    sidebarWidth: effectiveSidebarWidth,
    appsWidth,
    toolWidth: effectiveTerminalWidth,
  } = appsLayout({
    shellWidth: shellSize.width,
    requestedSidebarWidth: sidebarWidth,
    explorerOpen,
    toolOpen: terminalVisible,
    requestedToolWidth: terminalWidth,
    minimumAppsWidth: workspaceActive ? undefined : 0,
  })
  const sidebarCollapsed = effectiveSidebarWidth <= APP_SIDEBAR_COLLAPSE_WIDTH
  const effectiveTerminalHeight = Math.min(terminalHeight, terminalHeightMax(shellSize.height) ?? terminalHeight)
  const detail = selection.selectedProjectSessionsQuery.data
  // Derive loaded projects live so renames / worktree changes reach the header immediately; detail
  // remains the selected-project context when that project is outside the normal project pages.
  const selectedProject = selection.projectList.find((project) => project.id === selectedProjectId) ?? detail?.project
  const selectedSession =
    detail?.sessions.find((session) => session.id === selectedSessionId) ??
    detail?.selectedSessionDetail ??
    selectedSessionFromRailCache(queryClient, selectedProjectId, selectedSessionId) ??
    sessionPins.data?.pins.find((pin) => pin.project.id === selectedProjectId && pin.session.id === selectedSessionId)?.session
  const workspaceTitle = selectedProject?.name ?? (selection.selectedProjectSessionsQuery.isLoading ? 'Loading project…' : selectedProjectId ? 'Project' : '')
  const selectedSessionAvailable = Boolean(selectedSession)
  const selectedSessionExternallyOwned = selectedSession?.occupiedBy === 'external'
  const pageTitle = activeAppNav === 'chat' ? (selectedSession?.title ?? selectedProject?.name) : APP_NAV_ITEMS.find((item) => item.key === activeAppNav)?.label
  const pageTitleLoading = activeAppNav === 'chat' && ((selectedSessionId && !selectedSession) || (selectedProjectId && !selectedProject))
  const selectedTabStatus = tabStatus(selectedSession?.occupiedStatus)
  useEffect(() => {
    // Keep the previous tab title while the selection is still resolving.
    if (pageTitleLoading) return
    document.title = pageTitle ? `${pageTitle} · Cotta` : 'Cotta'
  }, [pageTitle, pageTitleLoading])
  useEffect(() => {
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (icon) icon.href = faviconHref(selectedTabStatus)
  }, [selectedTabStatus])
  // biome-ignore lint/correctness/useExhaustiveDependencies: timelineInstanceNonce re-runs runtime ensure after a session restart
  useEffect(() => {
    if (!selectedProjectId || !selectedSessionId || !selectedSessionAvailable) return
    const requestId = beginSelectionIntent()
    if (selectedSessionExternallyOwned) {
      setSelectedSessionRuntime(null)
      return
    }
    void ensureSessionRuntime(selectedSessionId)
      .then((runtime) => {
        if (pendingSessionRequestRef.current !== requestId) return
        setSelectedSessionRuntime(runtime)
      })
      .catch((error) => {
        if (pendingSessionRequestRef.current === requestId && error instanceof SessionRuntimeHttpError && error.code === 'project_directory_unavailable') setUnavailableProjectId(selectedProjectId)
      })
  }, [selectedProjectId, selectedSessionAvailable, selectedSessionExternallyOwned, selectedSessionId, timelineInstanceNonce, beginSelectionIntent])
  const reconcileSelection = useCallback(
    (selectionSnapshot: { intentId: number; projectId: string | null; sessionId: string | null }, outcomes: Map<string, ProjectRefreshResult>) => {
      if (pendingSessionRequestRef.current !== selectionSnapshot.intentId || selectedProjectId !== selectionSnapshot.projectId || selectedSessionId !== selectionSnapshot.sessionId) return
      if (!selectionSnapshot.projectId) return
      const selectedProjectOutcome = outcomes.get(selectionSnapshot.projectId)
      if (selectedProjectOutcome?.outcome === 'missing') {
        const projects = queryClient.getQueryData<{ pages: Array<{ projects: Array<{ id: string }> }> }>(sessionQueryKeys.projects)
        const nextProjectId = projects?.pages.flatMap((page) => page.projects).find((project) => project.id !== selectionSnapshot.projectId)?.id
        if (nextProjectId) selectProject(nextProjectId)
        else clearSelection()
        return
      }
      if (selectionSnapshot.sessionId) {
        if (selectedSessionFromRailCache(queryClient, selectionSnapshot.projectId, selectionSnapshot.sessionId)) pendingCreatedSelectionRef.current = null
        if (shouldClearMissingSelection({ projectId: selectionSnapshot.projectId, sessionId: selectionSnapshot.sessionId }, selectedProjectOutcome, pendingCreatedSelectionRef.current)) {
          beginSelectionIntent()
          setSelectedSessionId(null)
          setSelectedSessionRuntime(null)
        }
      }
    },
    [clearSelection, queryClient, selectProject, selectedProjectId, selectedSessionId, setSelectedSessionId, beginSelectionIntent],
  )

  const refreshVisibleWindows = useCallback(
    async (projectIds = visibleProjectIds, sessionIdOverride?: string | null, selectedSessionProjectIds: string[] = []) => {
      const targetProjectIds = [...new Set([...projectIds, selectedProjectId, ...selectedSessionProjectIds].filter((projectId): projectId is string => Boolean(projectId)))]
      if (targetProjectIds.length === 0) return new Map<string, ProjectRefreshResult>()
      const selectionSnapshot = {
        intentId: pendingSessionRequestRef.current,
        projectId: selectedProjectId,
        sessionId: sessionIdOverride ?? selectedSessionId,
      }
      const generations: Record<string, number> = Object.fromEntries(
        targetProjectIds.map((projectId) => {
          const generation = (visibleSessionGenerationsRef.current.get(projectId) ?? 0) + 1
          visibleSessionGenerationsRef.current.set(projectId, generation)
          return [projectId, generation]
        }),
      )
      setVisibleSessionStates((current) => ({
        ...current,
        ...Object.fromEntries(targetProjectIds.map((projectId) => [projectId, { generation: generations[projectId], loading: true, error: false }])),
      }))
      try {
        const outcomes = await refreshVisibleProjectSessions(queryClient, {
          selectedProjectId: selectionSnapshot.projectId,
          selectedSessionId: selectionSnapshot.sessionId,
          selectedSessionProjectIds,
          visibleProjectIds: targetProjectIds,
        })
        const selectionStillCurrent =
          pendingSessionRequestRef.current === selectionSnapshot.intentId && selectedProjectId === selectionSnapshot.projectId && selectedSessionId === selectionSnapshot.sessionId
        const relocatedSession =
          selectionStillCurrent && selectionSnapshot.projectId && selectionSnapshot.sessionId ? relocatedSelectedSession(outcomes, selectionSnapshot.projectId, selectionSnapshot.sessionId) : null
        if (relocatedSession) {
          beginSelectionIntent()
          selectSessionOwner(relocatedSession.projectId, relocatedSession.id)
        } else {
          reconcileSelection(selectionSnapshot, outcomes)
        }
        setVisibleSessionStates((current) => {
          const next = { ...current }
          for (const projectId of targetProjectIds) {
            if (next[projectId]?.generation !== generations[projectId]) continue
            next[projectId] = { generation: generations[projectId], loading: false, error: false }
          }
          return next
        })
        return outcomes
      } catch (error) {
        console.error('visible-sessions:refresh failed', error)
        setVisibleSessionStates((current) => {
          const next = { ...current }
          for (const projectId of targetProjectIds) {
            if (next[projectId]?.generation !== generations[projectId]) continue
            next[projectId] = { generation: generations[projectId], loading: false, error: true }
          }
          return next
        })
        return new Map<string, ProjectRefreshResult>()
      }
    },
    [queryClient, reconcileSelection, selectSessionOwner, selectedProjectId, selectedSessionId, visibleProjectIds, beginSelectionIntent],
  )

  const refreshProjectsOnly = useCallback(async () => {
    const attempted = listVersionStateRef.current
    const outcome = await refreshProjectsWindow(queryClient)
    acknowledgeListRefresh(listVersionStateRef.current, attempted, { projects: outcome })
    return outcome
  }, [queryClient])

  function handleSelectSession(projectId: string, sessionId: string) {
    beginSelectionIntent()
    setSelectedSessionRuntime(null)
    setUnavailableProjectId(null)
    setSearchNavigation(null)
    if (projectId !== selectedProjectId || sessionId !== selectedSessionId) {
      selection.selectSession(projectId, sessionId)
    }
    showChat()
  }

  function openSessionTurn(projectId: string, location: SessionLocation) {
    if (projectId !== selectedProjectId || location.sessionId !== selectedSessionId) {
      setSelectedRailContext(null)
      setSelectedSessionRuntime(null)
      setUnavailableProjectId(null)
      selectSessionOwner(projectId, location.sessionId)
      revealRailSession(projectId, location.sessionId)
    }
    const queryNonce = searchQueryNonceRef.current + 1
    searchQueryNonceRef.current = queryNonce
    setSearchNavigation(
      location.turnId ? { sessionId: location.sessionId, anchorTurnId: location.turnId, target: { kind: 'message', turnId: location.turnId, messageUuid: location.turnId, queryNonce } } : null,
    )
  }

  function handleOpenSharedTurn(sessionId: string, turnId: string) {
    showChat()
    void openSessionLocation({ sessionId, turnId })
  }

  applyLocationSessionRef.current = async (location) => {
    if (!location) {
      // Back/forward to `/` restores the Project recorded on that entry: none is home, otherwise a pending new session.
      const projectId = historyProjectId()
      if (currentChatPath === '/' && projectId === selectedProjectId) return
      beginSelectionIntent()
      setSelectedRailContext(null)
      setSelectedSessionRuntime(null)
      setSearchNavigation(null)
      if (projectId) selectProject(projectId)
      else clearSelection()
      return
    }
    if (chatPath(location) !== currentChatPath) await openSessionLocation(location)
  }

  // The session's current Project is resolved by the server (a share or URL may predate a relocation).
  async function openSessionLocation(location: SessionLocation) {
    const intentId = beginSelectionIntent()
    if (location.sessionId === selectedSessionId && selectedProjectId) {
      openSessionTurn(selectedProjectId, location)
      return
    }
    urlResolvingIntentRef.current = intentId
    try {
      const resolved = await fetchSessionProject(location.sessionId)
      if (pendingSessionRequestRef.current !== intentId) return
      if (!resolved) {
        setToast({ message: 'Session is no longer available.', tone: 'error' })
        return
      }
      openSessionTurn(resolved.projectId, location)
    } catch (error) {
      if (pendingSessionRequestRef.current === intentId) setToast({ message: error instanceof Error ? error.message : String(error), tone: 'error' })
    } finally {
      // Unresolved or superseded: the next render's URL sync replaces the URL with the current selection.
      if (urlResolvingIntentRef.current === intentId) urlResolvingIntentRef.current = null
      setUrlResolvedTick((tick) => tick + 1)
    }
  }

  async function resolveSearchSelection(searchSelection: SearchSelection) {
    const intentId = beginSelectionIntent()
    const sessionId = searchSelection.result.session.id
    let detail: ProjectSessionSearchResult['session'] | undefined
    try {
      const detailResponse = await queryProjectSessions([{ projectId: searchSelection.result.project.id, limit: 1, selectedSessionId: sessionId }])
      if (pendingSessionRequestRef.current !== intentId) return
      const selectedWindow = Object.values(detailResponse.sessionsByProject).find((window) => window.selectedSessionDetail?.id === sessionId)
      detail = selectedWindow?.selectedSessionDetail ?? undefined
      if (!detail) {
        await resetSessionSearchCache(queryClient)
        if (pendingSessionRequestRef.current !== intentId) return
        setToast({ message: 'Session is no longer available.', tone: 'error' })
        return
      }
      setSelectedRailContext({ project: selectedWindow?.project ?? searchSelection.result.project, session: selectedWindow?.selectedSessionDetail ?? searchSelection.result.session })
      if (searchSelection.kind === 'metadata') {
        setSearchNavigation(null)
        setSelectedSessionRuntime(null)
        setUnavailableProjectId(null)
        selectSessionOwner(detail.projectId, sessionId)
        revealRailSession(detail.projectId, sessionId)
        showChat()
        closeSearch(false)
        return
      }
      const { locator } = searchSelection.match
      if (!locator) return
      const page = await fetchSessionTimeline(sessionId, { anchorTurnId: locator.turnId })
      if (pendingSessionRequestRef.current !== intentId) return
      queryClient.setQueryData(sessionQueryKeys.sessionTimeline(sessionId, locator.turnId), page)
      const turn = page.turns.find((item) => item.primaryUserUuid === locator.turnId)
      const targetExists =
        turn?.messages.some((message) => {
          if (typeof message !== 'object' || message === null || !('uuid' in message) || (message as { uuid?: unknown }).uuid !== locator.messageUuid) return false
          const payload = 'message' in message && typeof message.message === 'object' && message.message !== null ? (message.message as { content?: unknown }).content : undefined
          if (typeof payload === 'string') return locator.blockIndex === 0
          const block = Array.isArray(payload) ? payload[locator.blockIndex] : undefined
          return typeof block === 'object' && block !== null && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string'
        }) ?? false
      setSelectedSessionRuntime(null)
      setUnavailableProjectId(null)
      selectSessionOwner(detail.projectId, sessionId)
      revealRailSession(detail.projectId, sessionId)
      const queryNonce = searchQueryNonceRef.current + 1
      searchQueryNonceRef.current = queryNonce
      setSearchNavigation({
        sessionId,
        anchorTurnId: targetExists ? locator.turnId : null,
        target: targetExists ? { kind: 'message', turnId: locator.turnId, messageUuid: locator.messageUuid, blockIndex: locator.blockIndex, queryNonce } : { kind: 'jump-latest', queryNonce },
      })
      if (!targetExists) setToast({ message: 'Original message can no longer be located. Opened the session instead.', tone: 'error' })
      showChat()
      closeSearch(false)
    } catch (error) {
      if (pendingSessionRequestRef.current !== intentId) return
      if (error instanceof TimelineSnapshotStaleError && detail) {
        setSelectedSessionRuntime(null)
        setUnavailableProjectId(null)
        selectSessionOwner(detail.projectId, sessionId)
        revealRailSession(detail.projectId, sessionId)
        const queryNonce = searchQueryNonceRef.current + 1
        searchQueryNonceRef.current = queryNonce
        setSearchNavigation({ sessionId, anchorTurnId: null, target: { kind: 'jump-latest', queryNonce } })
        setToast({ message: 'Original message can no longer be located. Opened the session instead.', tone: 'error' })
        showChat()
        closeSearch(false)
        return
      }
      setToast({ message: error instanceof Error ? error.message : String(error), tone: 'error' })
    }
  }

  async function handlePinSession(sessionId: string, pinned: boolean) {
    try {
      await setSessionPinned(sessionId, pinned)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setToast({ message: `Failed to ${pinned ? 'pin' : 'unpin'} session: ${message}`, tone: 'error' })
      throw error
    }
    setToast({ message: pinned ? 'Session pinned' : 'Session unpinned', tone: 'success' })
    void sessionPins.refetch()
  }

  async function handleRestartSession(sessionId: string) {
    const intentId = beginSelectionIntent()
    const projectId = selectedProjectId
    try {
      const result = await restartSessionRuntime(sessionId)
      if (pendingSessionRequestRef.current !== intentId || selectedSessionId !== sessionId) return
      setSelectedSessionRuntime(null)
      setTimelineInstanceNonce((current) => current + 1)
      await refreshVisibleWindows(projectId ? [projectId] : [])
      if (pendingSessionRequestRef.current !== intentId || selectedSessionId !== sessionId) return
      setToast({ message: result.restarted ? 'Runtime restarted' : 'Runtime closed for CLI', tone: 'success' })
    } catch (error) {
      if (pendingSessionRequestRef.current !== intentId) throw error
      const message = error instanceof Error ? error.message : String(error)
      setToast({ message: `Failed to restart runtime: ${message}`, tone: 'error' })
      throw error
    }
  }

  async function handleDeleteSession(projectId: string, sessionId: string, confirmationSessionId: string) {
    try {
      await deleteSession(projectId, sessionId, confirmationSessionId)
      removeProjectSessionFromCache(queryClient, projectId, sessionId)
      await resetSessionSearchCache(queryClient)
      if (selectedSessionId === sessionId) {
        beginSelectionIntent()
        setSelectedSessionId(null)
        setSelectedSessionRuntime(null)
      }
      await refreshProjectsOnly()
      await refreshVisibleWindows([projectId])
      await sessionPins.refetch()
      setToast({ message: 'Session deleted', tone: 'success' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setToast({ message: `Failed to delete session: ${message}`, tone: 'error' })
      throw error
    }
  }

  async function handleRenameSession(projectId: string, sessionId: string, title: string) {
    try {
      await renameSession(projectId, sessionId, title)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setToast({ message: `Failed to rename session: ${message}`, tone: 'error' })
      throw error
    }
    try {
      const outcomes = await refreshVisibleWindows([projectId])
      const pins = await sessionPins.refetch()
      const refreshed = outcomes.get(projectId)
      if (!refreshed || refreshed.outcome === 'missing' || pins.isError) {
        setToast({ message: 'Session renamed, but lists could not be refreshed.', tone: 'error' })
        return
      }
      setToast({ message: 'Session renamed', tone: 'success' })
    } catch (error) {
      console.error('session:rename refresh failed', error)
      setToast({ message: 'Session renamed, but lists could not be refreshed.', tone: 'error' })
    }
  }

  useEffect(() => {
    const events = connectListVersions(
      (event: ListVersionsEvent) => {
        setListUpdatesReconnecting(false)
        const plan = planListVersionEvent(listVersionStateRef.current, event, { selectedProjectId, selectedSessionId, visibleProjectIds })
        listVersionStateRef.current = plan.state
        if (plan.refreshProjects) void refreshProjectsOnly()
        if (plan.refreshProjects || event.sessionChanges.length > 0) markSessionSearchCacheStale(queryClient)
        for (const change of plan.removedSessions) {
          removeProjectSessionFromCache(queryClient, change.projectId, change.sessionId)
          removeSessionFromSearchCache(queryClient, change.sessionId)
        }
        if (plan.refreshPins) void sessionPins.refetch()
        if (selectedProjectId && selectedSessionId) {
          if (plan.transcriptSignal) setTranscriptSignal({ projectId: selectedProjectId, sessionId: selectedSessionId, signal: plan.transcriptSignal })
          if (plan.controlSignal) setTimelineControlSignal({ projectId: selectedProjectId, sessionId: selectedSessionId, signal: plan.controlSignal })
          if (plan.invalidateSelectedSessionSubagents) void queryClient.invalidateQueries({ queryKey: ['turn-subagents-tree', selectedSessionId] })
        }
        const { projectIds, selectedSessionProjectIds } = plan
        if (projectIds.length === 0) return
        const attempted = plan.state
        void refreshVisibleWindows(projectIds, undefined, selectedSessionProjectIds).then((sessions) => {
          acknowledgeListRefresh(listVersionStateRef.current, attempted, { sessions })
        })
      },
      () => setListUpdatesReconnecting(true),
      selectedProjectId && selectedSessionId ? { projectId: selectedProjectId, sessionId: selectedSessionId } : null,
    )
    return () => events.close()
  }, [queryClient, refreshProjectsOnly, refreshVisibleWindows, selectedProjectId, selectedSessionId, visibleProjectIds, sessionPins.refetch])

  useEffect(() => {
    if (visibleProjectIds.length === 0) return
    void refreshVisibleWindows()
  }, [refreshVisibleWindows, visibleProjectIds])

  useEffect(() => {
    function refreshIfVisible() {
      if (document.visibilityState === 'hidden') return
      void refreshProjectsOnly()
      void sessionPins.refetch()
      if (visibleProjectIds.length > 0) void refreshVisibleWindows()
    }
    const timer = window.setInterval(refreshIfVisible, 60_000)
    window.addEventListener('focus', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [refreshProjectsOnly, refreshVisibleWindows, visibleProjectIds, sessionPins.refetch])

  async function handleRefreshLists() {
    if (refreshingLists) return
    setRefreshingLists(true)
    const attempted = listVersionStateRef.current
    try {
      await refreshProjects(selection.selectedProjectId)
      await refreshProjectsOnly()
      await sessionPins.refetch()
      const sessions = await refreshVisibleWindows()
      acknowledgeListRefresh(listVersionStateRef.current, attempted, { sessions })
    } finally {
      setRefreshingLists(false)
    }
  }

  function handleOpenAccount() {
    history.pushState(null, '', `${appNavPath('settings')}#settings-account-heading`)
    setActiveAppNav('settings')
    setTerminalOpen(false)
    requestAnimationFrame(() => document.getElementById('settings-account-heading')?.scrollIntoView({ block: 'start' }))
  }

  const projectsContent = selection.projectsQuery.isLoading ? (
    <ProjectListSkeleton />
  ) : selection.projectsQuery.isError ? (
    <div className="rail-empty error-text">Failed to load projects: {selection.projectsQuery.error instanceof Error ? selection.projectsQuery.error.message : 'unknown error'}</div>
  ) : (
    <ProjectSessionRail
      projects={selection.projectList}
      pins={sessionPins.data?.pins}
      selectedProjectId={selectedProjectId}
      selectedSessionId={selectedSessionId}
      selectedProjectContext={selectedRailContext?.project.id === selectedProjectId ? selectedRailContext.project : selectedProject}
      selectedSessionSummary={selectedRailContext?.session.id === selectedSessionId ? selectedRailContext.session : selectedSession}
      highlightedSession={highlightedRailSession}
      projectsHasMore={selection.projectsQuery.hasNextPage}
      projectsLoadingMore={selection.projectsQuery.isFetchingNextPage}
      refreshingProjects={refreshingLists}
      listUpdatesReconnecting={listUpdatesReconnecting}
      onLoadMoreProjects={() => {
        if (projectLoadMoreInFlightRef.current || !selection.projectsQuery.hasNextPage || selection.projectsQuery.isFetchingNextPage) return
        projectLoadMoreInFlightRef.current = true
        void selection.projectsQuery
          .fetchNextPage({ throwOnError: true })
          .catch((error) => {
            if (error instanceof PaginationCursorStaleError) return refreshProjectsWindow(queryClient)
          })
          .finally(() => {
            projectLoadMoreInFlightRef.current = false
          })
      }}
      onRefreshProjects={handleRefreshLists}
      visibleSessionStates={visibleSessionStates}
      onVisibleProjectIdsChange={setVisibleProjectIds}
      onSelectProject={(projectId) => {
        beginSelectionIntent()
        pushNextUrlRef.current = true
        setSelectedRailContext(null)
        setSelectedSessionRuntime(null)
        selection.selectProject(projectId)
      }}
      onSelectSession={(projectId, sessionId) => {
        if (selectedRailContext?.session.id !== sessionId) setSelectedRailContext(null)
        handleSelectSession(projectId, sessionId)
      }}
      onDeleteSession={handleDeleteSession}
      onRenameSession={handleRenameSession}
      onPinSession={handlePinSession}
      onForkSession={handleForkSession}
      onRestartSession={handleRestartSession}
      onSessionCursorStale={(projectId) => {
        void refreshVisibleWindows([projectId])
      }}
      onHighlightedSessionSeen={() => setHighlightedRailSeen(true)}
    />
  )

  return (
    <AppLayout
      layoutRef={appLayoutRef}
      sidebarWidth={effectiveSidebarWidth}
      sidebarCollapsed={effectiveSidebarWidth <= APP_SIDEBAR_COLLAPSE_WIDTH}
      sidebarResizing={sidebarResizing}
      sidebar={
        <AppSidebar
          activeAppNav={activeAppNav}
          terminalOpen={terminalOpen}
          terminalConnected={terminalConnected}
          authSession={authSession.data}
          createMenu={
            <button className="app-sidebar-plus" type="button" onClick={beginNewSession} disabled={refreshingLists} aria-label="New Session" title="New Session">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M10 4v12M4 10h12" />
              </svg>
            </button>
          }
          projectsContent={projectsContent}
          onNavigate={navigateAppNav}
          onOpenTerminal={toggleTerminal}
          onExpandSidebar={expandAppSidebar}
          onOpenAccount={handleOpenAccount}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenStats={openStats}
          searchTriggerRef={searchTriggerRef}
        />
      }
      onSidebarResizeStart={beginSidebarResize}
    >
      <div className="app-main">
        <section
          className="apps-view"
          hidden={!workspaceActive}
          data-tool-panel={terminalVisible ? 'terminal' : undefined}
          data-tool-layout={terminalLayout}
          data-tool-resizing={terminalResizing ? 'true' : 'false'}
          style={{ '--tool-panel-width': `${effectiveTerminalWidth}px`, '--tool-panel-height': `${effectiveTerminalHeight}px` } as CSSProperties}
        >
          <section className="workspace-group">
            <section className="workspace-panel">
              <div className="workspace-main-pane">
                <div className="workspace-main-content">
                  {selection.selectedProjectSessionsQuery.isError ? (
                    <div className="panel error workspace-panel-error">
                      Failed to load project sessions: {selection.selectedProjectSessionsQuery.error instanceof Error ? selection.selectedProjectSessionsQuery.error.message : 'unknown error'}
                    </div>
                  ) : (
                    <WorkspacePanel
                      chatHeader={
                        <header className="workspace-main-header workspace-panel-header">
                          <div className="project-title-block">
                            <button
                              className="workspace-pane-toggle workspace-sidebar-toggle"
                              type="button"
                              onClick={toggleAppSidebar}
                              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                              aria-expanded={!sidebarCollapsed}
                              aria-controls="app-sidebar"
                              title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                            >
                              <WorkspacePaneToggleIcon expanded={!sidebarCollapsed} />
                            </button>
                            <div className="project-title-text">
                              <div
                                className="project-session-title"
                                title={selectedSession ? `${workspaceTitle} / ${selectedSession.title}` : workspaceTitle || undefined}
                                data-has-project={selectedProjectId ? 'true' : 'false'}
                                data-has-session={selectedSession ? 'true' : 'false'}
                                data-has-worktree={selectedProject?.worktreeName ? 'true' : 'false'}
                              >
                                {selectedProjectId ? (
                                  <svg viewBox="0 0 640 640" className="project-card-folder-icon" aria-hidden="true" data-icon="FolderOutlined">
                                    <path
                                      d="M129.5 464 179.5 304h379.4l-50 160H129.5zM320.2 512H509c21 0 39.6-13.6 45.8-33.7l50-160c9.7-30.9-13.3-62.3-45.9-62.3H179.6c-21 0-39.6 13.6-45.8 33.7L112.2 358.4V160c0-8.8 7.2-16 16-16h138.7c3.5 0 6.8 1.1 9.6 3.2l38.4 28.8c13.8 10.4 30.7 16 48 16h117.3c8.8 0 16 7.2 16 16h48c0-35.3-28.7-64-64-64H362.9c-6.9 0-13.7-2.2-19.2-6.4l-38.4-28.8C294.2 100.5 280.8 96 266.9 96H128.2c-35.3 0-64 28.7-64 64v288c0 35.3 28.7 64 64 64h192z"
                                      fill="currentColor"
                                    />
                                  </svg>
                                ) : null}
                                <span className="project-name">{workspaceTitle}</span>
                                {selectedProject?.worktreeName ? <WorktreeBadge name={selectedProject.worktreeName} /> : null}
                                {selectedSession ? (
                                  <span className="project-session-identity">
                                    <span className="project-session-separator" aria-hidden="true">
                                      /
                                    </span>
                                    <span className="project-session-name">{selectedSession.title}</span>
                                  </span>
                                ) : null}
                              </div>
                            </div>
                          </div>
                          <div className="project-meta-lines">
                            <button
                              className="workspace-pane-toggle workspace-explorer-toggle"
                              type="button"
                              onClick={() =>
                                setExplorerOpen((open) => {
                                  setExplorerPaneWidth(WORKSPACE_EXPLORER_DEFAULT_WIDTH)
                                  return !open
                                })
                              }
                              aria-label={explorerOpen ? 'Collapse explorer' : 'Expand explorer'}
                              aria-expanded={explorerOpen}
                              aria-controls="workspace-explorer-pane"
                              title={explorerOpen ? 'Collapse explorer' : 'Expand explorer'}
                            >
                              <WorkspacePaneToggleIcon expanded={explorerOpen} />
                            </button>
                          </div>
                        </header>
                      }
                      githubLogin={authSession.data?.authenticated ? (authSession.data.user?.login ?? null) : null}
                      explorerOpen={explorerOpen}
                      explorerPaneWidth={explorerPaneWidth}
                      onExplorerPaneWidthChange={setExplorerPaneWidth}
                      onExplorerOpenChange={(open) => {
                        setExplorerOpen(open)
                        if (open) setExplorerPaneWidth(WORKSPACE_EXPLORER_DEFAULT_WIDTH)
                      }}
                      projectId={selection.selectedProjectId}
                      projectName={selectedProject?.name}
                      projectPath={selectedProject?.path ?? null}
                      currentCwd={selectedSession?.currentCwd ?? selectedProject?.path ?? null}
                      transcriptSignal={transcriptSignal?.sessionId === selectedSessionId ? transcriptSignal.signal : null}
                      timelineControlSignal={timelineControlSignal?.sessionId === selectedSessionId ? timelineControlSignal.signal : null}
                      timelineInstanceNonce={timelineInstanceNonce}
                      selectedSession={selectedSession}
                      selectedSessionId={selection.selectedSessionId}
                      setSelectedSessionId={selection.setSelectedSessionId}
                      searchAnchorTurnId={searchNavigation?.sessionId === selection.selectedSessionId ? searchNavigation.anchorTurnId : null}
                      searchTarget={searchNavigation?.sessionId === selection.selectedSessionId ? searchNavigation.target : null}
                      onSearchTargetHandled={() => setSearchNavigation((current) => (current ? { ...current, target: null } : current))}
                      onJumpToLatest={() => {
                        if (!selection.selectedSessionId) return
                        const queryNonce = searchQueryNonceRef.current + 1
                        searchQueryNonceRef.current = queryNonce
                        setSearchNavigation({ sessionId: selection.selectedSessionId, anchorTurnId: null, target: { kind: 'jump-latest', queryNonce } })
                      }}
                      refreshSessionLists={refreshVisibleWindows}
                      onSessionCreated={handleSessionCreated}
                      settings={settings}
                      sessionRuntime={selectedSessionRuntime}
                      projectDirectoryUnavailable={selectedProjectId !== null && unavailableProjectId === selectedProjectId}
                      onForkSession={handleForkSession}
                      onNotify={setToast}
                    />
                  )}
                </div>
              </div>
            </section>
          </section>
          {terminalVisible ? (
            // biome-ignore lint/a11y/useSemanticElements: pointer-driven resize handle; <hr> cannot carry the drag affordance
            <div
              className="tool-panel-resize-handle"
              role="separator"
              aria-label={terminalLayout === 'bottom' ? 'Resize terminal height' : 'Resize terminal panel'}
              aria-orientation={terminalLayout === 'bottom' ? 'horizontal' : 'vertical'}
              aria-valuemin={terminalLayout === 'bottom' ? TOOL_PANEL_MIN_HEIGHT : TOOL_PANEL_MIN_WIDTH}
              aria-valuemax={terminalLayout === 'bottom' ? (terminalHeightMax(shellSize.height) ?? terminalHeight) : terminalWidthMax(appsWidth, explorerOpen)}
              aria-valuenow={terminalLayout === 'bottom' ? effectiveTerminalHeight : effectiveTerminalWidth}
              onPointerDown={beginTerminalResize}
            />
          ) : null}
          <TerminalPanel className="tool-panel terminal-panel" open={terminalVisible} onClose={closeTerminal} onConnectedChange={setTerminalConnected} />
        </section>
        <section className="app-route-view" hidden={workspaceActive}>
          {activeAppNav === 'agents' ? (
            <AgentsPage setStatus={setToast} />
          ) : activeAppNav === 'settings' ? (
            <SettingsPanel settings={settings} authSession={authSession.data} onLogout={handleLogout} />
          ) : activeAppNav === 'shares' ? (
            <ShareManagementPanel onOpenTurn={handleOpenSharedTurn} sharingEnabled={!!settings.publicBaseUrl} />
          ) : (
            <PlaceholderPage title={APP_NAV_ITEMS.find((item) => item.key === activeAppNav)?.label ?? 'Page'} />
          )}
        </section>
      </div>
      <SessionSearchDialog open={searchOpen} onClose={closeSearch} onSelect={resolveSearchSelection} />
      {toast ? (
        <div className={`settings-toast settings-toast-${toast.tone}`} role="status">
          {toast.message}
        </div>
      ) : null}
      {projectChoiceOpen ? (
        <dialog className="project-choice-dialog" open aria-labelledby="project-choice-title">
          <form className="project-choice-form">
            <h2 id="project-choice-title">Choose a project</h2>
            <p>Your first message will start a new session in the selected project.</p>
            {selection.projectList.length > 0 ? (
              <div className="project-choice-list">
                {selection.projectList.map((project) => (
                  <button key={project.id} type="button" onClick={() => startPendingProject(project.id)}>
                    {project.name}
                  </button>
                ))}
              </div>
            ) : (
              <p className="panel muted">No existing projects found.</p>
            )}
            <div className="project-choice-actions">
              <button type="button" onClick={() => setProjectChoiceOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        </dialog>
      ) : null}
    </AppLayout>
  )
}

function AuthenticatedApp() {
  const authSession = useQuery({ queryKey: ['auth-session'], queryFn: fetchAuthSession, retry: false })
  const session = authSession.data
  const authenticated = Boolean(session?.authenticated)

  if (authSession.isLoading)
    return (
      <main className="shell">
        <div className="panel muted">Loading authentication…</div>
      </main>
    )
  if (!authenticated) return <AccessRequired loginMethod={session?.loginMethod} />
  return (
    <main className="shell">
      <WorkspaceShell />
    </main>
  )
}

function App() {
  const path = window.location.pathname
  if (path.startsWith('/detail/')) return <AnonTurnDetail token={decodeURIComponent(path.slice('/detail/'.length))} />
  if (path.startsWith('/share/')) return <AnonTurnShare token={decodeURIComponent(path.slice('/share/'.length))} />
  return <AuthenticatedApp />
}

const queryClient = new QueryClient()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
