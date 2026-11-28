import { type AppSettings, appSettingsSchema, type ListVersionsEvent, type ProjectSessionSearchMatch, type ProjectSessionSearchResult, type ProjectSummary, type SessionSummary } from '@cotta/shared'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { type PointerEvent as ReactPointerEvent, StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels'
import { PaginationCursorStaleError, TimelineSnapshotStaleError } from './api'
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
import { appsLayout, MAIN_AREA_MIN_WIDTH, TOOLS_AREA_MIN_WIDTH } from './app/apps-layout'
import { ProjectListSkeleton, ProjectSessionRail, useProjectSessionSelection, WorktreeBadge } from './app/session-history'
import { SessionPane } from './app/session-pane'
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
import { ToolsArea } from './app/tools-area'
import type { ToastState } from './app/turn-composer'
import { WorkspacePaneToggleIcon } from './app/workspace-panel'
import { SAME_ORIGIN_MACHINE_ID, useMachineApi } from './client/machine-scope'
import { AreaView } from './layout/area-view'
import {
  AREA_MAX_PANES,
  type Area,
  activateTab,
  activeTab,
  addTab,
  closePane,
  createArea,
  defaultIdFactory,
  focusedPane,
  focusPane,
  type PaneNode,
  paneForSession,
  panes,
  replaceActiveTab,
  type SessionTab,
  type SplitSide,
  setSplitSizes,
  splitPane,
} from './layout/layout-model'
import { type DraggedSession, type DropZone, PaneDropTarget, type RailPanes, RailPanesProvider } from './layout/session-drag'
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

function sessionTab(projectId: string | null, sessionId: string | null): SessionTab {
  return { kind: 'session', id: defaultIdFactory(), machineId: SAME_ORIGIN_MACHINE_ID, projectId, sessionId }
}

/** Files and Changes always; the machine terminal when the page was opened with `?terminal=1`. */
function initialToolsArea(withTerminal: boolean): Area {
  const files = createArea('tools', { kind: 'files', id: 'files' })
  const withChanges = addTab(files, files.focusedPaneId, { kind: 'changes', id: 'changes' }) ?? files
  const area = activateTab(withChanges, withChanges.focusedPaneId, 'files')
  return withTerminal ? (addTab(area, area.focusedPaneId, { kind: 'terminal', id: 'machine-terminal', machineId: SAME_ORIGIN_MACHINE_ID, cwd: null }) ?? area) : area
}

function WorkspaceShell() {
  const api = useMachineApi()
  const queryClient = useQueryClient()
  const [activeAppNav, setActiveAppNav] = useState<AppNavKey>(appNavKeyFromPath)
  const [terminalConnected, setTerminalConnected] = useState(false)
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: api.fetchSettings,
    retry: false,
  })
  const authSession = useQuery({ queryKey: ['auth-session'], queryFn: api.fetchAuthSession, retry: false })
  const sessionPins = useQuery({ queryKey: sessionQueryKeys.sessionPins, queryFn: api.fetchSessionPins, retry: false })
  const settings: AppSettings = settingsQuery.data?.settings ?? appSettingsSchema.parse({})
  const catalogMissing = settingsQuery.isSuccess && !settings.modelCatalog
  const authed = Boolean(authSession.data?.authenticated)
  const workspaceActive = activeAppNav === 'chat'
  const selection = useProjectSessionSelection({ selectInitialProject: false })
  const { selectedProjectId, selectedSessionId, clearSelection, selectProject, selectSession: selectSessionOwner, setSelectedSessionId } = selection
  const [sidebarWidth, setSidebarWidth] = useState(APP_SIDEBAR_DEFAULT_WIDTH)
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const [shellSize, setShellSize] = useState({ width: 0, height: 0 })
  // Tools area (Files, Changes, the machine terminal). It collapses rather than unmounts, so its tabs keep their state.
  const [toolsOpen, setToolsOpen] = useState(terminalOpenFromLocation)
  const [toolsArea, setToolsArea] = useState<Area>(() => initialToolsArea(terminalOpenFromLocation()))
  const toolsPanelRef = usePanelRef()
  const [projectChoiceOpen, setProjectChoiceOpen] = useState(false)
  const [refreshingLists, setRefreshingLists] = useState(false)
  const [listUpdatesReconnecting, setListUpdatesReconnecting] = useState(false)
  // Latest Timeline signals per open session (every pane gets its own, focused or not).
  const [transcriptSignals, setTranscriptSignals] = useState<Record<string, TranscriptSignal>>({})
  const [timelineControlSignals, setTimelineControlSignals] = useState<Record<string, TimelineControlSignal>>({})
  // Per-session restart counters; a session pane re-ensures its runtime and remounts its Timeline when its count changes.
  const [restartNonces, setRestartNonces] = useState<Record<string, number>>({})
  const [toast, setToast] = useState<ToastState | null>(null)
  // The catalog may be absent at boot when the active model provider's backend only authenticates after
  // the user connects it in Settings (server defers it). Whenever we're authenticated with no catalog yet,
  // fetch it once so the composer/Settings model menus aren't empty; refreshModelCatalog persists it, so
  // this self-heals after a connect succeeds. A failure means the backend is unreachable — surface it.
  useEffect(() => {
    if (!authed || !catalogMissing) return
    let cancelled = false
    api
      .refreshModelCatalog(null)
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
  }, [authed, catalogMissing, queryClient, api.refreshModelCatalog])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchNavigation, setSearchNavigation] = useState<{ sessionId: string; anchorTurnId: string | null; target: SearchTarget | null } | null>(null)
  const [highlightedRailSession, setHighlightedRailSession] = useState<{ projectId: string; sessionId: string } | null>(null)
  const [selectedRailContext, setSelectedRailContext] = useState<{ project: ProjectSessionSearchResult['project']; session: ProjectSessionSearchResult['session'] } | null>(null)
  const [highlightedRailSeen, setHighlightedRailSeen] = useState(false)
  const [visibleSessionStates, setVisibleSessionStates] = useState<Record<string, { generation: number; loading: boolean; error: boolean }>>({})
  const [visibleProjectIds, setVisibleProjectIds] = useState<string[]>([])
  const sidebarWidthRef = useRef(APP_SIDEBAR_DEFAULT_WIDTH)
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
  // The main area's panes. The focused pane always shows the shell's selection; other panes keep their own session.
  const [mainArea, setMainArea] = useState<Area>(() => createArea('main', sessionTab(null, null)))
  const mainPanes = panes(mainArea.root)
  // Last known summaries, so a pane that is not focused can still title itself when its session is not in the rail cache.
  const knownSessionsRef = useRef(new Map<string, SessionSummary>())
  const knownProjectsRef = useRef(new Map<string, ProjectSummary>())
  // Selection → focused pane. A session already open in another pane is focused there instead of duplicated.
  useEffect(() => {
    setMainArea((area) => {
      const current = activeTab(focusedPane(area))
      if (current.kind === 'session' && current.projectId === selectedProjectId && current.sessionId === selectedSessionId) return area
      const elsewhere = selectedSessionId ? paneForSession(area, SAME_ORIGIN_MACHINE_ID, selectedSessionId) : null
      if (elsewhere && elsewhere.id !== area.focusedPaneId) return focusPane(area, elsewhere.id)
      return replaceActiveTab(area, area.focusedPaneId, sessionTab(selectedProjectId, selectedSessionId)) ?? area
    })
  }, [selectedProjectId, selectedSessionId])
  // Every pane's session, focused first: the list-version stream watches each and delivers each its signals.
  const openSessions = useMemo(() => {
    const focused = mainArea.focusedPaneId
    return panes(mainArea.root)
      .sort((left, right) => (left.id === focused ? -1 : right.id === focused ? 1 : 0))
      .flatMap((pane) => pane.tabs.flatMap((tab) => (tab.kind === 'session' && tab.projectId && tab.sessionId ? [{ projectId: tab.projectId, sessionId: tab.sessionId }] : [])))
  }, [mainArea])
  const openSessionsKey = openSessions.map(({ projectId, sessionId }) => `${projectId}\0${sessionId}`).join('\n')
  const currentChatPath = chatPath(selectedSessionId ? { sessionId: selectedSessionId, turnId: urlTurnId } : null)
  useEffect(() => {
    void applyLocationSessionRef.current(sessionLocationFromPath())
    function syncLocation() {
      const nav = appNavKeyFromPath()
      setActiveAppNav(nav)
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
    if (activeAppNav !== 'settings' || window.location.hash !== '#settings-account-heading') return
    requestAnimationFrame(() => document.getElementById('settings-account-heading')?.scrollIntoView({ block: 'start' }))
  }, [activeAppNav])
  function navigateAppNav(nextNav: AppNavKey) {
    if (nextNav === 'chat') beginNewConversation()
    history.pushState(null, '', appNavPath(nextNav))
    setActiveAppNav(nextNav)
  }

  async function handleLogout() {
    await api.logout()
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
    selection.clearSelection()
  }

  function showChat() {
    pushNextUrlRef.current = true
    setActiveAppNav('chat')
  }

  /** The machine terminal is a single tools tab; opening it again just shows it. */
  function openTerminal() {
    setActiveAppNav('chat')
    setToolsArea((current) => {
      const existing = panes(current.root)
        .flatMap((pane) => pane.tabs.map((tab) => ({ pane, tab })))
        .find(({ tab }) => tab.kind === 'terminal')
      if (existing) return activateTab({ ...current, focusedPaneId: existing.pane.id }, existing.pane.id, existing.tab.id)
      return addTab(current, current.focusedPaneId, { kind: 'terminal', id: 'machine-terminal', machineId: SAME_ORIGIN_MACHINE_ID, cwd: null }) ?? current
    })
    setToolsOpen(true)
  }

  function toggleTerminal() {
    if (terminalShown) setToolsOpen(false)
    else openTerminal()
  }

  function closeSearch(cancelSelection = true) {
    if (cancelSelection) beginSelectionIntent()
    setSearchOpen(false)
    requestAnimationFrame(() => searchTriggerRef.current?.focus())
  }

  function openStats() {
    showChat()
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
    setSelectedSessionId(null)
  }

  function startPendingProject(projectId: string) {
    beginSelectionIntent()
    setSelectedRailContext(null)
    setProjectChoiceOpen(false)
    selection.selectProject(projectId)
  }

  function handleSessionCreated(projectId: string, sessionId: string) {
    beginSelectionIntent()
    pushNextUrlRef.current = true
    setSelectedRailContext(null)
    pendingCreatedSelectionRef.current = { projectId, sessionId }
    selection.selectSession(projectId, sessionId)
  }

  function revealRailSession(projectId: string, sessionId: string) {
    if (sidebarCollapsed) expandAppSidebar()
    setHighlightedRailSession({ projectId, sessionId })
    setHighlightedRailSeen(false)
  }

  async function handleForkSession(projectId: string, sessionId: string, upToMessageId?: string) {
    try {
      const fork = await api.forkSession(projectId, sessionId, upToMessageId)
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

  const toolsActiveTab = focusedPane(toolsArea).tabs.find((tab) => tab.id === focusedPane(toolsArea).activeTabId)
  const terminalShown = workspaceActive && toolsOpen && toolsActiveTab?.kind === 'terminal'
  const { sidebarWidth: effectiveSidebarWidth } = appsLayout({
    shellWidth: shellSize.width,
    requestedSidebarWidth: sidebarWidth,
    toolsOpen: workspaceActive && toolsOpen,
    minimumAppsWidth: workspaceActive ? undefined : 0,
  })
  const sidebarCollapsed = effectiveSidebarWidth <= APP_SIDEBAR_COLLAPSE_WIDTH
  const detail = selection.selectedProjectSessionsQuery.data
  // Derive loaded projects live so renames / worktree changes reach the header immediately; detail
  // remains the selected-project context when that project is outside the normal project pages.
  const selectedProject = selection.projectList.find((project) => project.id === selectedProjectId) ?? detail?.project
  const selectedSession =
    detail?.sessions.find((session) => session.id === selectedSessionId) ??
    detail?.selectedSessionDetail ??
    selectedSessionFromRailCache(queryClient, selectedProjectId, selectedSessionId) ??
    sessionPins.data?.pins.find((pin) => pin.project.id === selectedProjectId && pin.session.id === selectedSessionId)?.session
  useEffect(() => {
    if (selectedSession) knownSessionsRef.current.set(selectedSession.id, selectedSession)
    if (selectedProject) knownProjectsRef.current.set(selectedProject.id, selectedProject)
  }, [selectedProject, selectedSession])
  const workspaceTitle = selectedProject?.name ?? (selection.selectedProjectSessionsQuery.isLoading ? 'Loading project…' : selectedProjectId ? 'Project' : '')
  const selectedSessionAvailable = Boolean(selectedSession)
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
  // When the focused session becomes available a new selection intent begins, superseding in-flight selection
  // resolutions and clearing the just-created guard. (The runtime itself is ensured by the session pane.)
  useEffect(() => {
    if (!selectedProjectId || !selectedSessionId || !selectedSessionAvailable) return
    beginSelectionIntent()
  }, [selectedProjectId, selectedSessionAvailable, selectedSessionId, beginSelectionIntent])
  useEffect(() => {
    const panel = toolsPanelRef.current
    if (!panel) return
    if (toolsOpen && panel.isCollapsed()) panel.expand()
    if (!toolsOpen && !panel.isCollapsed()) panel.collapse()
  }, [toolsOpen, toolsPanelRef])
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
        const outcomes = await refreshVisibleProjectSessions(queryClient, api, {
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
    [queryClient, reconcileSelection, selectSessionOwner, selectedProjectId, selectedSessionId, visibleProjectIds, beginSelectionIntent, api],
  )

  const refreshProjectsOnly = useCallback(async () => {
    const attempted = listVersionStateRef.current
    const outcome = await refreshProjectsWindow(queryClient, api)
    acknowledgeListRefresh(listVersionStateRef.current, attempted, { projects: outcome })
    return outcome
  }, [queryClient, api])

  function handleSelectSession(projectId: string, sessionId: string) {
    beginSelectionIntent()
    setSearchNavigation(null)
    if (projectId !== selectedProjectId || sessionId !== selectedSessionId) {
      selection.selectSession(projectId, sessionId)
    }
    showChat()
  }

  function openSessionTurn(projectId: string, location: SessionLocation) {
    if (projectId !== selectedProjectId || location.sessionId !== selectedSessionId) {
      setSelectedRailContext(null)
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
      const resolved = await api.fetchSessionProject(location.sessionId)
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
      const detailResponse = await api.queryProjectSessions([{ projectId: searchSelection.result.project.id, limit: 1, selectedSessionId: sessionId }])
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
        selectSessionOwner(detail.projectId, sessionId)
        revealRailSession(detail.projectId, sessionId)
        showChat()
        closeSearch(false)
        return
      }
      const { locator } = searchSelection.match
      if (!locator) return
      const page = await api.fetchSessionTimeline(sessionId, { anchorTurnId: locator.turnId })
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
      await api.setSessionPinned(sessionId, pinned)
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
      const result = await api.restartSessionRuntime(sessionId)
      if (pendingSessionRequestRef.current !== intentId || selectedSessionId !== sessionId) return
      setRestartNonces((current) => ({ ...current, [sessionId]: (current[sessionId] ?? 0) + 1 }))
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
      await api.deleteSession(projectId, sessionId, confirmationSessionId)
      removeProjectSessionFromCache(queryClient, projectId, sessionId)
      await resetSessionSearchCache(queryClient)
      if (selectedSessionId === sessionId) {
        beginSelectionIntent()
        setSelectedSessionId(null)
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
      await api.renameSession(projectId, sessionId, title)
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

  // The stream reconnects only when the set of open sessions changes, which openSessionsKey stands for.
  // biome-ignore lint/correctness/useExhaustiveDependencies: openSessions is represented by openSessionsKey
  useEffect(() => {
    const events = api.connectListVersions(
      (event: ListVersionsEvent) => {
        setListUpdatesReconnecting(false)
        const plan = planListVersionEvent(listVersionStateRef.current, event, {
          selectedProjectId,
          selectedSessionId,
          visibleProjectIds,
          openSessionIds: openSessions.map(({ sessionId }) => sessionId),
        })
        listVersionStateRef.current = plan.state
        if (plan.refreshProjects) void refreshProjectsOnly()
        if (plan.refreshProjects || event.sessionChanges.length > 0) markSessionSearchCacheStale(queryClient)
        for (const change of plan.removedSessions) {
          removeProjectSessionFromCache(queryClient, change.projectId, change.sessionId)
          removeSessionFromSearchCache(queryClient, change.sessionId)
        }
        if (plan.refreshPins) void sessionPins.refetch()
        for (const { sessionId, transcriptSignal, controlSignal, invalidateSubagents } of plan.sessionSignals) {
          if (transcriptSignal) setTranscriptSignals((current) => ({ ...current, [sessionId]: transcriptSignal }))
          if (controlSignal) setTimelineControlSignals((current) => ({ ...current, [sessionId]: controlSignal }))
          if (invalidateSubagents) void queryClient.invalidateQueries({ queryKey: ['turn-subagents-tree', sessionId] })
        }
        const { projectIds, selectedSessionProjectIds } = plan
        if (projectIds.length === 0) return
        const attempted = plan.state
        void refreshVisibleWindows(projectIds, undefined, selectedSessionProjectIds).then((sessions) => {
          acknowledgeListRefresh(listVersionStateRef.current, attempted, { sessions })
        })
      },
      () => setListUpdatesReconnecting(true),
      openSessions,
    )
    return () => events.close()
  }, [queryClient, refreshProjectsOnly, refreshVisibleWindows, selectedProjectId, selectedSessionId, visibleProjectIds, sessionPins.refetch, api.connectListVersions, openSessionsKey])

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
      await api.refreshProjects(selection.selectedProjectId)
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
    requestAnimationFrame(() => document.getElementById('settings-account-heading')?.scrollIntoView({ block: 'start' }))
  }

  /** Makes `pane` the focused pane and points the shell's selection at its session. */
  function focusMainPane(pane: PaneNode) {
    const tab = activeTab(pane)
    setMainArea((area) => focusPane(area, pane.id))
    if (tab.kind !== 'session') return
    if (tab.projectId && tab.sessionId) handleSelectSession(tab.projectId, tab.sessionId)
    else if (tab.projectId) startPendingProject(tab.projectId)
    else beginNewConversation()
  }

  function closeMainPane(paneId: string) {
    const next = closePane(mainArea, paneId)
    if (!next) return
    setMainArea(next)
    if (next.focusedPaneId !== mainArea.focusedPaneId) focusMainPane(focusedPane(next))
  }

  /** Opens a rail session in a new pane beside `targetPaneId` (the focused pane by default), or focuses it if already open. */
  function openSessionInSplit(session: DraggedSession, targetPaneId = mainArea.focusedPaneId, side: SplitSide = 'right') {
    const existing = paneForSession(mainArea, SAME_ORIGIN_MACHINE_ID, session.sessionId)
    if (existing) {
      focusMainPane(existing)
      return
    }
    const next = splitPane(mainArea, targetPaneId, side, sessionTab(session.projectId, session.sessionId))
    if (!next) return
    setMainArea(next)
    handleSelectSession(session.projectId, session.sessionId)
  }

  function dropSessionOnPane(paneId: string, zone: DropZone, session: DraggedSession) {
    if (zone !== 'center') {
      openSessionInSplit(session, paneId, zone)
      return
    }
    const existing = paneForSession(mainArea, SAME_ORIGIN_MACHINE_ID, session.sessionId)
    if (existing) {
      focusMainPane(existing)
      return
    }
    setMainArea((area) => focusPane(area, paneId))
    handleSelectSession(session.projectId, session.sessionId)
  }

  /** One main-area pane. The focused pane shows the shell's selection; the others show the session their tab holds. */
  function renderMainPane(pane: PaneNode, focused: boolean) {
    const tab = activeTab(pane) as SessionTab
    const paneIndex = mainPanes.findIndex((candidate) => candidate.id === pane.id)
    const isFirst = paneIndex <= 0
    const isLast = paneIndex === mainPanes.length - 1
    const canClose = mainPanes.length > 1
    const paneProjectId = focused ? selectedProjectId : tab.projectId
    const paneSessionId = focused ? selectedSessionId : tab.sessionId
    const paneProject = focused ? selectedProject : paneProjectId ? (selection.projectList.find((project) => project.id === paneProjectId) ?? knownProjectsRef.current.get(paneProjectId)) : undefined
    const paneSession = focused
      ? selectedSession
      : paneSessionId
        ? (selectedSessionFromRailCache(queryClient, paneProjectId, paneSessionId) ??
          sessionPins.data?.pins.find((pin) => pin.session.id === paneSessionId)?.session ??
          knownSessionsRef.current.get(paneSessionId))
        : undefined
    const paneTitle = focused ? workspaceTitle : (paneProject?.name ?? (paneProjectId ? 'Project' : ''))
    return (
      <PaneDropTarget allowSides={mainPanes.length < AREA_MAX_PANES.main} onDropSession={(zone, dragged) => dropSessionOnPane(pane.id, zone, dragged)}>
        <section
          className="workspace-panel"
          data-focused={focused ? 'true' : 'false'}
          onPointerDownCapture={() => {
            if (!focused) focusMainPane(pane)
          }}
        >
          <div className="workspace-main-pane">
            <div className="workspace-main-content">
              {focused && selection.selectedProjectSessionsQuery.isError ? (
                <div className="panel error workspace-panel-error">
                  Failed to load project sessions: {selection.selectedProjectSessionsQuery.error instanceof Error ? selection.selectedProjectSessionsQuery.error.message : 'unknown error'}
                </div>
              ) : (
                <SessionPane
                  chatHeader={
                    <header className="workspace-main-header workspace-panel-header">
                      <div className="project-title-block">
                        {isFirst ? (
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
                        ) : null}
                        <div className="project-title-text">
                          <div
                            className="project-session-title"
                            title={paneSession ? `${paneTitle} / ${paneSession.title}` : paneTitle || undefined}
                            data-has-project={paneProjectId ? 'true' : 'false'}
                            data-has-session={paneSession ? 'true' : 'false'}
                            data-has-worktree={paneProject?.worktreeName ? 'true' : 'false'}
                          >
                            {paneProjectId ? (
                              <svg viewBox="0 0 640 640" className="project-card-folder-icon" aria-hidden="true" data-icon="FolderOutlined">
                                <path
                                  d="M129.5 464 179.5 304h379.4l-50 160H129.5zM320.2 512H509c21 0 39.6-13.6 45.8-33.7l50-160c9.7-30.9-13.3-62.3-45.9-62.3H179.6c-21 0-39.6 13.6-45.8 33.7L112.2 358.4V160c0-8.8 7.2-16 16-16h138.7c3.5 0 6.8 1.1 9.6 3.2l38.4 28.8c13.8 10.4 30.7 16 48 16h117.3c8.8 0 16 7.2 16 16h48c0-35.3-28.7-64-64-64H362.9c-6.9 0-13.7-2.2-19.2-6.4l-38.4-28.8C294.2 100.5 280.8 96 266.9 96H128.2c-35.3 0-64 28.7-64 64v288c0 35.3 28.7 64 64 64h192z"
                                  fill="currentColor"
                                />
                              </svg>
                            ) : null}
                            <span className="project-name">{paneTitle}</span>
                            {paneProject?.worktreeName ? <WorktreeBadge name={paneProject.worktreeName} /> : null}
                            {paneSession ? (
                              <span className="project-session-identity">
                                <span className="project-session-separator" aria-hidden="true">
                                  /
                                </span>
                                <span className="project-session-name">{paneSession.title}</span>
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                      <div className="project-meta-lines">
                        {canClose ? (
                          <button type="button" className="workspace-pane-toggle workspace-pane-close" onClick={() => closeMainPane(pane.id)} aria-label="Close pane" title="Close pane">
                            ×
                          </button>
                        ) : null}
                        {isLast ? (
                          <button
                            className="workspace-pane-toggle workspace-explorer-toggle"
                            type="button"
                            onClick={() => setToolsOpen((open) => !open)}
                            aria-label={toolsOpen ? 'Collapse tools' : 'Expand tools'}
                            aria-expanded={toolsOpen}
                            aria-controls="workbench-tools"
                            title={toolsOpen ? 'Collapse tools' : 'Expand tools'}
                          >
                            <WorkspacePaneToggleIcon expanded={toolsOpen} />
                          </button>
                        ) : null}
                      </div>
                    </header>
                  }
                  githubLogin={authSession.data?.authenticated ? (authSession.data.user?.login ?? null) : null}
                  projectId={paneProjectId}
                  projectName={paneProject?.name}
                  projectPath={paneProject?.path ?? null}
                  transcriptSignal={paneSessionId ? (transcriptSignals[paneSessionId] ?? null) : null}
                  timelineControlSignal={paneSessionId ? (timelineControlSignals[paneSessionId] ?? null) : null}
                  restartNonce={paneSessionId ? (restartNonces[paneSessionId] ?? 0) : 0}
                  selectedSession={paneSession}
                  selectedSessionId={paneSessionId}
                  setSelectedSessionId={focused ? selection.setSelectedSessionId : () => {}}
                  searchAnchorTurnId={focused && searchNavigation?.sessionId === paneSessionId ? searchNavigation.anchorTurnId : null}
                  searchTarget={focused && searchNavigation?.sessionId === paneSessionId ? searchNavigation.target : null}
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
                  onForkSession={handleForkSession}
                  onNotify={setToast}
                />
              )}
            </div>
          </div>
        </section>
      </PaneDropTarget>
    )
  }

  const railPanes: RailPanes = {
    openSessionIds: new Set(openSessions.map(({ sessionId }) => sessionId)),
    canOpenInSplit: mainPanes.length < AREA_MAX_PANES.main,
    openInSplit: (session) => openSessionInSplit(session),
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
            if (error instanceof PaginationCursorStaleError) return refreshProjectsWindow(queryClient, api)
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
          terminalOpen={terminalShown}
          terminalConnected={terminalConnected}
          authSession={authSession.data}
          createMenu={
            <button className="app-sidebar-plus" type="button" onClick={beginNewSession} disabled={refreshingLists} aria-label="New Session" title="New Session">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M10 4v12M4 10h12" />
              </svg>
            </button>
          }
          projectsContent={<RailPanesProvider value={railPanes}>{projectsContent}</RailPanesProvider>}
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
        <section className="apps-view" hidden={!workspaceActive}>
          <Group orientation="horizontal" className="apps-split">
            <Panel id="workbench-main" minSize={MAIN_AREA_MIN_WIDTH} className="apps-main-panel">
              <section className="workspace-group">
                <AreaView
                  area={mainArea}
                  minPaneSize={MAIN_AREA_MIN_WIDTH}
                  onSplitSizesChange={(splitId, sizes) => setMainArea((current) => setSplitSizes(current, splitId, sizes))}
                  renderPane={(pane, { focused }) => renderMainPane(pane, focused)}
                />
              </section>
            </Panel>
            <Separator className="layout-separator apps-tools-separator" disabled={!toolsOpen} />
            <Panel
              id="workbench-tools"
              panelRef={toolsPanelRef}
              collapsible
              collapsedSize={0}
              minSize={TOOLS_AREA_MIN_WIDTH}
              defaultSize="38"
              className="apps-tools-panel"
              onResize={(size) => {
                // Dragging the separator past the minimum collapses the area; keep the toggle in step with it.
                if (size.inPixels === 0 && toolsOpen) setToolsOpen(false)
              }}
            >
              <div className="apps-tools-content" hidden={!toolsOpen}>
                <ToolsArea
                  area={toolsArea}
                  onAreaChange={(next) => {
                    if (next) setToolsArea(next)
                    else setToolsOpen(false)
                  }}
                  visible={workspaceActive && toolsOpen}
                  project={{ projectId: selectedProjectId, projectName: selectedProject?.name, currentCwd: selectedSession?.currentCwd ?? selectedProject?.path ?? null }}
                  onTerminalConnectedChange={setTerminalConnected}
                />
              </div>
            </Panel>
          </Group>
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
  const api = useMachineApi()
  const authSession = useQuery({ queryKey: ['auth-session'], queryFn: api.fetchAuthSession, retry: false })
  const session = authSession.data
  const authenticated = Boolean(session?.authenticated)

  if (authSession.isLoading)
    return (
      <main className="shell">
        <div className="panel muted">Loading authentication…</div>
      </main>
    )
  if (!authenticated) return <AccessRequired />
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
