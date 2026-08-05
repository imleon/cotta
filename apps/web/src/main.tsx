import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { StrictMode, type CSSProperties, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createTurnResponseSchema,
  type AppSettings,
  type ListVersionsEvent,
  type CreateTurnResponse,
  type DefaultTurnOption,
  type EffortLevel,
  type ModelCatalogItem,
  type ModelSelection,
  type PermissionMode,
  type ProjectSessionsResponse,
  type SessionInfoResponse,
  type SessionObservation,
  type SessionObservationSort,
  type SessionRuntimeResponse,
  type SessionTask,
  type SessionTimelineResponse,
  type TurnMetaTranscriptRow,
  type TurnSummary,
} from '@cotta/shared'
import { connectListVersions, createProject, deleteSession, ensureSessionRuntime, fetchAuthSession, fetchProjectDirectories, fetchSessionInfo, fetchSessionObservations, fetchSettings, fetchTurnMetaTranscript, forkSession, logout, PaginationCursorStaleError, pollGitHubDeviceLogin, refreshModelCatalog, refreshProjects, renameSession, saveSettings, startGitHubDeviceLogin } from './api'
import { ProjectSessionRail, useProjectSessionSelection } from './session-history'
import { refreshProjectsWindow, refreshVisibleProjectSessions, removeProjectSessionFromCache, sessionQueryKeys } from './session-query-refresh'
import { SessionTaskList, SessionTimeline } from './timeline'
import './styles.css'

const DASHBOARD_NAV_ITEMS = [
  { key: 'chat', label: 'Chat', path: '/chat' },
  { key: 'automations', label: 'Automations', path: '/automations' },
  { key: 'agents', label: 'Agents', path: '/agents' },
  { key: 'skills', label: 'Skills', path: '/skills' },
  { key: 'mcp', label: 'MCP', path: '/mcp' },
  { key: 'settings', label: 'Settings', path: '/settings' },
  { key: 'debug', label: 'Debug', path: '/debug' },
] as const

type DashboardNavKey = (typeof DASHBOARD_NAV_ITEMS)[number]['key']

function routePath(key: DashboardNavKey): string {
  return DASHBOARD_NAV_ITEMS.find((item) => item.key === key)?.path ?? '/chat'
}

function navKeyFromPath(): DashboardNavKey {
  const path = window.location.pathname === '/' ? '/chat' : window.location.pathname
  const pathKey = DASHBOARD_NAV_ITEMS.find((item) => item.path === path)?.key
  if (pathKey) return pathKey
  const hashKey = window.location.pathname === '/' ? window.location.hash.slice(1) : ''
  return DASHBOARD_NAV_ITEMS.some((item) => item.key === hashKey) ? hashKey as DashboardNavKey : 'chat'
}

function DashboardNavIcon({ itemKey }: { itemKey: DashboardNavKey }) {
  if (itemKey === 'chat') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 5.5h11a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9l-3.5 3v-3H4.5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2Z" /></svg>
  }
  if (itemKey === 'debug') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5a2 2 0 0 1 2 2v.8h1.5a1 1 0 0 1 1 1V9h1a1 1 0 1 1 0 2h-1v1.7a1 1 0 0 1-1 1H12v.8a2 2 0 1 1-4 0v-.8H6.5a1 1 0 0 1-1-1V11h-1a1 1 0 1 1 0-2h1V7.3a1 1 0 0 1 1-1H8v-.8a2 2 0 0 1 2-2Zm-2.5 4.8v3.4h5V8.3Z" /></svg>
  }
  if (itemKey === 'automations') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5v3M10 14.5v3M2.5 10h3M14.5 10h3M4.7 4.7l2.1 2.1M13.2 13.2l2.1 2.1M15.3 4.7l-2.1 2.1M6.8 13.2l-2.1 2.1M10 6.5 12.2 8v4L10 13.5 7.8 12V8Z" /></svg>
  }
  if (itemKey === 'agents') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 15.5v-1.2a3.5 3.5 0 0 1 7 0v1.2M10 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3.5 14.5v-.7a2.5 2.5 0 0 1 2.9-2.5M16.5 14.5v-.7a2.5 2.5 0 0 0-2.9-2.5" /></svg>
  }
  if (itemKey === 'skills') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m10 2.8 2 4.1 4.5.7-3.2 3.1.8 4.5-4.1-2.2-4.1 2.2.8-4.5-3.2-3.1 4.5-.7Z" /></svg>
  }
  if (itemKey === 'mcp') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6.5h12M4 10h12M4 13.5h7M3 4.5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" /></svg>
  }
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v2M10 14.5v2M4.7 5.3l1.4 1.4M13.9 14.3l1.4 1.4M3.5 10h2M14.5 10h2M4.7 14.7l1.4-1.4M13.9 5.7l1.4-1.4M10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /></svg>
}

const DASHBOARD_NAV_MIN_WIDTH = 46
const DASHBOARD_NAV_MAX_WIDTH = 184
const DASHBOARD_NAV_DEFAULT_WIDTH = 216
const DASHBOARD_NAV_COLLAPSE_WIDTH = 96
const DASHBOARD_NAV_WIDTH_STORAGE_KEY = 'cotta:dashboard-nav-width'
const WORKSPACE_RAIL_MIN_WIDTH = 240
const WORKSPACE_RAIL_MAX_WIDTH = 520
const WORKSPACE_RAIL_DEFAULT_WIDTH = 320
const WORKSPACE_RAIL_WIDTH_STORAGE_KEY = 'cotta:workspace-rail-width'
const WORKSPACE_RAIL_COLLAPSED_STORAGE_KEY = 'cotta:workspace-rail-collapsed'

function clampDashboardNavWidth(width: number): number {
  return Math.min(DASHBOARD_NAV_MAX_WIDTH, Math.max(DASHBOARD_NAV_MIN_WIDTH, width))
}

function clampWorkspaceRailWidth(width: number): number {
  return Math.min(WORKSPACE_RAIL_MAX_WIDTH, Math.max(WORKSPACE_RAIL_MIN_WIDTH, width))
}

function clampWorkspaceRailDragWidth(width: number): number {
  return Math.min(WORKSPACE_RAIL_MAX_WIDTH, Math.max(0, width))
}

class CreateTurnHttpError extends Error {
  constructor(readonly status: number) {
    super(`Create turn failed: ${status}`)
  }
}

function createUserMessageUuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function createTurn(projectId: string, existingSessionId: string | null, sessionId: string, text: string, userMessageUuid: string, permissionMode: PermissionMode, model: ModelSelection | DefaultTurnOption, effort: EffortLevel | DefaultTurnOption): Promise<CreateTurnResponse> {
  const path = existingSessionId
    ? `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(existingSessionId)}/turns`
    : `/api/projects/${encodeURIComponent(projectId)}/sessions`
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, text, userMessageUuid, permissionMode, model, effort }),
  })
  if (!response.ok) throw new CreateTurnHttpError(response.status)
  return createTurnResponseSchema.parse(await response.json())
}

async function interruptTurn(projectId: string, sessionId: string): Promise<void> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/interrupt`,
    { method: 'POST' },
  )
  if (!response.ok) throw new Error(`Interrupt failed: ${response.status}`)
}

function pendingUserTurn(text: string, sessionId: string, userMessageUuid: string): { sessionId: string; turn: TurnSummary } {
  const timestamp = new Date().toISOString()
  return {
    sessionId,
    turn: {
      primaryUserUuid: userMessageUuid,
      primaryUserTimestampMs: Date.parse(timestamp),
      messages: [{
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        uuid: userMessageUuid,
        session_id: sessionId,
        timestamp,
      }],
    },
  }
}

function effortLabel(value: EffortLevel | DefaultTurnOption): string {
  return value
}

const EFFORT_ORDER: EffortLevel[] = ['max', 'xhigh', 'high', 'medium', 'low']
const DEFAULT_TURN_OPTION: DefaultTurnOption = 'default'
const DEFAULT_EFFORT: EffortLevel = 'medium'

function defaultEffort(levels: EffortLevel[]): EffortLevel {
  return levels.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : levels[0] ?? DEFAULT_EFFORT
}

const PERMISSION_MODE_OPTIONS: Array<{ value: PermissionMode; description: string }> = [
  { value: 'plan', description: 'Planning mode, no execution of tools.' },
  { value: 'dontAsk', description: "Don't prompt for permissions, deny if not pre-approved." },
  { value: 'default', description: 'Standard permission behavior, prompts for dangerous operations.' },
  { value: 'acceptEdits', description: 'Auto-accept file edit operations.' },
  { value: 'auto', description: 'Use a model classifier to approve/deny permission prompts.' },
  { value: 'bypassPermissions', description: 'Bypass all permission checks.' },
]

function ComposerIcon({ name }: { name: PermissionMode | 'add' | 'shield' }) {
  if (name === 'add') return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11" /></svg>
  if (name === 'shield') return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.2 15 5v4.1c0 3.2-1.8 5.8-5 7.7-3.2-1.9-5-4.5-5-7.7V5Z" /></svg>
  if (name === 'plan') return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5h10M5 10h10M5 15h6" /></svg>
  if (name === 'dontAsk') return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15" /></svg>
  if (name === 'acceptEdits') return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 13.5-.5 2 2-.5 8-8-1.5-1.5Z" /><path d="M11.5 5.5 13 4l3 3-1.5 1.5" /></svg>
  if (name === 'auto') return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v2M10 14v2M4 10h2M14 10h2M5.8 5.8l1.4 1.4M12.8 12.8l1.4 1.4M14.2 5.8l-1.4 1.4M7.2 12.8l-1.4 1.4" /></svg>
  if (name === 'bypassPermissions') return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m11 2-6 9h4l-1 7 7-10h-4Z" /></svg>
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 10a5.5 5.5 0 1 0 11 0 5.5 5.5 0 0 0-11 0Z" /></svg>
}

function TurnComposer({
  projectId,
  selectedSessionId,
  selectedSessionRunState,
  liveUserMessageUuid,
  setSelectedSessionId,
  setPendingTurn,
  refreshSessionLists,
  onProjectRequired,
  pendingProjectId,
  pendingProjectRequest,
  onSessionCreated,
  settings,
  sessionRuntime,
  sessionInfo,
  sessionMeta,
}: {
  projectId: string | null
  selectedSessionId: string | null
  selectedSessionRunState: ProjectSessionsResponse['sessions'][number]['runState'] | null
  liveUserMessageUuid: string | null
  setSelectedSessionId: (sessionId: string | null) => void
  setPendingTurn: Dispatch<SetStateAction<{ sessionId: string; turn: TurnSummary } | null>>
  refreshSessionLists: (projectId?: string) => void
  onProjectRequired: (text: string) => void
  pendingProjectId: string | null
  pendingProjectRequest: number
  onSessionCreated: (projectId: string, sessionId: string) => void
  settings: AppSettings
  sessionRuntime: SessionRuntimeResponse | null
  sessionInfo: SessionInfoResponse | null
  sessionMeta: SessionTimelineResponse['sessionMeta'] | null
}) {
  const [inputText, setInputText] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [interrupting, setInterrupting] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const handledProjectRequestRef = useRef(0)
  const [retryProjectId, setRetryProjectId] = useState<string | null>(null)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(settings.defaultPermissionMode ?? 'default')
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false)
  const permissionMenuRef = useRef<HTMLDivElement | null>(null)
  const [model, setModel] = useState<ModelSelection | DefaultTurnOption>(settings.defaultModel ?? DEFAULT_TURN_OPTION)
  const [effort, setEffort] = useState<EffortLevel | DefaultTurnOption>(settings.defaultEffort ?? DEFAULT_EFFORT)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [menuModelValue, setMenuModelValue] = useState<ModelSelection | DefaultTurnOption>(DEFAULT_TURN_OPTION)
  const [effortMenuPosition, setEffortMenuPosition] = useState<CSSProperties>()
  const modelMenuRef = useRef<HTMLDivElement | null>(null)
  const composerScopeKey = `${projectId ?? ''}\0${selectedSessionId ?? ''}`
  const initializedComposerScopeRef = useRef<string | null>(null)
  const composerManuallyChangedRef = useRef(false)
  const permissionOptions = PERMISSION_MODE_OPTIONS
  const catalogModels = settings.modelCatalog?.models ?? []
  const selectedModel = model === DEFAULT_TURN_OPTION ? undefined : catalogModels.find((item) => item.value === model || item.resolvedModel === model)
  const menuModel = menuModelValue === DEFAULT_TURN_OPTION ? undefined : catalogModels.find((item) => item.value === menuModelValue || item.resolvedModel === menuModelValue)
  const triggerModelLabel = selectedModel?.displayName || 'Claude Code default'
  const triggerEffortLabel = model === DEFAULT_TURN_OPTION ? effortLabel(effort) : selectedModel?.supportsEffort && effort !== DEFAULT_TURN_OPTION ? effortLabel(effort) : null

  useEffect(() => { setSubmitError(null); setInterrupting(false) }, [projectId, selectedSessionId])
  useEffect(() => { if (!liveUserMessageUuid) setInterrupting(false) }, [liveUserMessageUuid])
  useEffect(() => {
    initializedComposerScopeRef.current = null
    composerManuallyChangedRef.current = false
  }, [composerScopeKey])
  useEffect(() => {
    if (initializedComposerScopeRef.current === composerScopeKey || composerManuallyChangedRef.current) return
    const wantsSessionMeta = Boolean(selectedSessionId && (settings.resumeUsesLastPermissionMode === true || settings.resumeUsesLastModelAndEffort === true))
    if (wantsSessionMeta && !sessionMeta) return
    setPermissionMode(settings.resumeUsesLastPermissionMode === true && selectedSessionId ? sessionMeta?.permissionMode ?? settings.defaultPermissionMode ?? 'default' : settings.defaultPermissionMode ?? 'default')
    setModel(settings.resumeUsesLastModelAndEffort === true && selectedSessionId ? sessionMeta?.model ?? DEFAULT_TURN_OPTION : settings.defaultModel ?? DEFAULT_TURN_OPTION)
    setEffort(settings.resumeUsesLastModelAndEffort === true && selectedSessionId ? sessionMeta?.effort ?? DEFAULT_EFFORT : settings.defaultEffort ?? DEFAULT_EFFORT)
    initializedComposerScopeRef.current = composerScopeKey
  }, [composerScopeKey, selectedSessionId, sessionMeta, settings.defaultPermissionMode, settings.defaultModel, settings.defaultEffort, settings.resumeUsesLastPermissionMode, settings.resumeUsesLastModelAndEffort])
  useEffect(() => {
    if (model === DEFAULT_TURN_OPTION || selectedModel) return
    setModel(DEFAULT_TURN_OPTION)
    setEffort(DEFAULT_TURN_OPTION)
  }, [model, selectedModel])
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 112)}px`
  }, [inputText])
  useEffect(() => {
    if (!permissionMenuOpen && !modelMenuOpen) return
    function closeOnOutsidePointer(event: globalThis.PointerEvent) {
      const target = event.target as Node
      if (permissionMenuRef.current?.contains(target) || modelMenuRef.current?.contains(target)) return
      setPermissionMenuOpen(false)
      setModelMenuOpen(false)
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setPermissionMenuOpen(false)
        setModelMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [permissionMenuOpen, modelMenuOpen])

  const cliSessionActive = selectedSessionRunState?.phase === 'cli_busy' || selectedSessionRunState?.phase === 'cli_shell' || selectedSessionRunState?.phase === 'cli_waiting'
  const cliSubmitBlocked = Boolean(selectedSessionId && cliSessionActive)

  async function submitTurn(targetProjectId = projectId) {
    if (submitting || liveUserMessageUuid || interrupting || !inputText.trim() || (targetProjectId === projectId && cliSubmitBlocked)) return
    const text = inputText.trim()
    if (!targetProjectId) {
      onProjectRequired(text)
      return
    }
    const userMessageUuid = createUserMessageUuid()
    const existingSessionId = targetProjectId === projectId ? selectedSessionId : null
    const targetSessionId = existingSessionId ?? createUserMessageUuid()
    setSubmitting(true)
    setSubmitError(null)
    if (!existingSessionId && targetProjectId === projectId) setSelectedSessionId(targetSessionId)
    try {
      setPendingTurn(pendingUserTurn(text, targetSessionId, userMessageUuid))
      setInputText('')
      const response = await createTurn(targetProjectId, existingSessionId, targetSessionId, text, userMessageUuid, permissionMode, model, selectedModel?.supportsEffort ? effort : DEFAULT_TURN_OPTION)
      if (targetProjectId !== projectId) onSessionCreated(response.projectId, response.sessionId)
      else setSelectedSessionId(response.sessionId)
      await refreshProjects(response.projectId)
      refreshSessionLists(response.projectId)
    } catch (error) {
      if (error instanceof CreateTurnHttpError) {
        setPendingTurn(null)
        setInputText(text)
        if (!existingSessionId && targetProjectId === projectId) setSelectedSessionId(null)
        if (targetProjectId !== projectId) setRetryProjectId(targetProjectId)
        setSubmitError(error.message)
      } else {
        setSubmitError(`Submission status unknown. Check the timeline or session list before retrying. ${error instanceof Error ? error.message : String(error)}`)
        refreshSessionLists(targetProjectId)
      }
    } finally {
      setSubmitting(false)
    }
  }

  useEffect(() => {
    if (!pendingProjectId || pendingProjectRequest === handledProjectRequestRef.current || !inputText.trim()) return
    handledProjectRequestRef.current = pendingProjectRequest
    void submitTurn(pendingProjectId)
  }, [pendingProjectId, pendingProjectRequest, inputText])

  async function stopLiveTurn() {
    if (!projectId || !selectedSessionId || !liveUserMessageUuid || interrupting) return
    setInterrupting(true)
    setSubmitError(null)
    try {
      await interruptTurn(projectId, selectedSessionId)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error))
      setInterrupting(false)
    }
  }

  function markComposerManualChange() {
    composerManuallyChangedRef.current = true
    initializedComposerScopeRef.current = composerScopeKey
  }

  function toggleModelMenu() {
    setMenuModelValue(DEFAULT_TURN_OPTION)
    setModelMenuOpen((open) => !open)
  }

  function showEffortMenu(option: ModelCatalogItem, target: HTMLElement) {
    const menu = modelMenuRef.current?.querySelector('.model-effort-menu')
    if (!(menu instanceof HTMLElement)) return
    const itemRect = target.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const effortCount = option.supportedEffortLevels?.length ?? 0
    const effortMenuHeight = Math.min(220, effortCount * 38 + 16)
    const alignedTop = itemRect.top - menuRect.top
    const clippingBottom = menu.closest('.workspace-main-panel')?.getBoundingClientRect().bottom ?? window.innerHeight
    const maxTop = Math.min(window.innerHeight, clippingBottom) - menuRect.top - effortMenuHeight - 8
    setMenuModelValue(option.value)
    setEffortMenuPosition({ top: Math.max(8, Math.min(alignedTop, maxTop)) })
  }

  function chooseDefaultModel() {
    markComposerManualChange()
    setModel(DEFAULT_TURN_OPTION)
    setEffort(DEFAULT_EFFORT)
    setModelMenuOpen(false)
  }

  function chooseModelOnly(option: ModelCatalogItem) {
    markComposerManualChange()
    setModel(option.value)
    setEffort(DEFAULT_TURN_OPTION)
    setModelMenuOpen(false)
  }

  function chooseEffort(option: ModelCatalogItem, nextEffort: EffortLevel) {
    markComposerManualChange()
    setModel(option.value)
    setEffort(nextEffort)
    setModelMenuOpen(false)
  }

  const actionMode = submitting || interrupting ? 'loading' : liveUserMessageUuid ? 'stop' : 'submit'

  return (
    <section className="composer-card composer-card-bottom">
      <form className="turn-form" onSubmit={(event) => { event.preventDefault(); void submitTurn(retryProjectId ?? projectId) }}>
        <div
          className="turn-composer"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('button, textarea, select, .permission-mode-menu, .model-effort-menu')) return
            inputRef.current?.focus()
          }}
        >
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={(event) => setInputText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || submitting || liveUserMessageUuid || interrupting || !inputText.trim() || cliSubmitBlocked) return
              event.preventDefault()
              void submitTurn(retryProjectId ?? projectId)
            }}
            placeholder="Type whatever you like"
            rows={2}
          />
          <div className="turn-composer-footer">
            <div className="turn-composer-left-actions">
              <button type="button" className="turn-tool-button" disabled aria-label="Add attachment" title="Add attachment">
                <ComposerIcon name="add" />
              </button>
              <div className="permission-mode-picker" ref={permissionMenuRef}>
                <button
                  type="button"
                  className="turn-tool-button permission-mode-trigger"
                  aria-haspopup="menu"
                  aria-expanded={permissionMenuOpen}
                  aria-label={`Permission mode: ${permissionMode}`}
                  onClick={() => setPermissionMenuOpen((open) => !open)}
                >
                  <ComposerIcon name="shield" />
                  <span>{permissionMode}</span>
                </button>
                {permissionMenuOpen ? (
                  <div className="permission-mode-menu" role="menu" aria-label="Permission mode">
                    {permissionOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className="permission-mode-option"
                        role="menuitemradio"
                        aria-checked={permissionMode === option.value}
                        onClick={() => { markComposerManualChange(); setPermissionMode(option.value); setPermissionMenuOpen(false) }}
                      >
                        <span className="permission-mode-option-icon"><ComposerIcon name={option.value} /></span>
                        <span className="permission-mode-option-copy">
                          <span className="permission-mode-option-title">{option.value}</span>
                          <span className="permission-mode-option-description">{option.description}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="turn-composer-submit-actions">
              <div className="model-effort-picker" ref={modelMenuRef}>
                <button
                  type="button"
                  className="model-effort-trigger"
                  aria-haspopup="menu"
                  aria-expanded={modelMenuOpen}
                  aria-label={`Model ${triggerModelLabel}${triggerEffortLabel ? `, effort ${triggerEffortLabel}` : ''}`}
                  title={`${triggerModelLabel}${triggerEffortLabel ? ` / ${triggerEffortLabel}` : ''}`}
                  onClick={toggleModelMenu}
                >
                  <span className="model-effort-trigger-icon" aria-hidden="true">◉</span>
                  <span className="model-effort-trigger-copy">
                    <span className="model-effort-trigger-model">{triggerModelLabel}</span>
                    {triggerEffortLabel ? <span className="model-effort-trigger-effort">{triggerEffortLabel}</span> : null}
                  </span>
                </button>
                {modelMenuOpen ? (
                  <div className="model-effort-menu" role="menu" aria-label="Model and effort">
                    {!catalogModels.length ? <div className="model-effort-hint">Load models in Settings to choose one.</div> : null}
                    <div className="model-effort-models" role="group" aria-label="Models">
                      <button type="button" className="model-effort-option" role="menuitem" aria-current={model === DEFAULT_TURN_OPTION} onClick={chooseDefaultModel}>
                        <span className="model-effort-option-title">Claude Code default</span>
                        {model === DEFAULT_TURN_OPTION ? <span className="model-effort-option-check" aria-hidden="true">✓</span> : null}
                      </button>
                      {catalogModels.length ? catalogModels.map((option) => {
                        const active = menuModel?.value === option.value
                        const selected = selectedModel?.value === option.value
                        return (
                          <button
                            key={option.value}
                            type="button"
                            className="model-effort-option"
                            role="menuitem"
                            aria-current={active}
                            onMouseEnter={(event) => showEffortMenu(option, event.currentTarget)}
                            onFocus={(event) => showEffortMenu(option, event.currentTarget)}
                            onClick={(event) => option.supportsEffort && option.supportedEffortLevels?.length ? showEffortMenu(option, event.currentTarget) : chooseModelOnly(option)}
                          >
                            <span className="model-effort-option-title">{option.displayName || option.value}</span>
                            {selected ? <span className="model-effort-option-check" aria-hidden="true">✓</span> : null}
                          </button>
                        )
                      }) : null}
                    </div>
                    {menuModel?.supportsEffort && menuModel.supportedEffortLevels?.length ? (
                      <div className="model-effort-efforts" style={effortMenuPosition} role="group" aria-label={`${menuModel.displayName || menuModel.value} efforts`}>
                        {EFFORT_ORDER.filter((level) => menuModel.supportedEffortLevels!.includes(level)).map((level) => {
                          const selected = selectedModel?.value === menuModel.value && effort === level
                          return (
                            <button
                              key={`${menuModel.value}:${level}`}
                              type="button"
                              className="model-effort-option model-effort-option-compact"
                              role="menuitemradio"
                              aria-checked={selected}
                              onClick={() => chooseEffort(menuModel, level)}
                            >
                              <span className="model-effort-option-title">{effortLabel(level)}</span>
                              {selected ? <span className="model-effort-option-check" aria-hidden="true">✓</span> : null}
                            </button>
                          )
                        })}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <button
                type={actionMode === 'submit' ? 'submit' : 'button'}
                className="turn-action-button"
                onClick={actionMode === 'stop' ? stopLiveTurn : undefined}
                disabled={actionMode === 'loading' || (actionMode === 'submit' && (!inputText.trim() || cliSubmitBlocked))}
                aria-label={interrupting ? 'Interrupting' : actionMode === 'loading' ? 'Submitting' : actionMode === 'stop' ? 'Stop generation' : cliSubmitBlocked ? 'CLI session is active' : 'Submit'}
              >
                {actionMode === 'loading' ? <span className="turn-spinner" aria-hidden="true" /> : actionMode === 'stop' ? <span className="turn-stop-icon" aria-hidden="true" /> : cliSubmitBlocked ? <svg className="turn-blocked-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.5" /><path d="m5.4 5.4 9.2 9.2" /></svg> : '↑'}
              </button>
            </div>
          </div>
        </div>
        {submitError ? <div className="panel error">{submitError}</div> : null}
      </form>
    </section>
  )
}

function WorkspacePanel({
  projectId,
  detail,
  selectedSessionId,
  setSelectedSessionId,
  refreshSessionLists,
  onProjectRequired,
  pendingProjectId,
  pendingProjectRequest,
  onSessionCreated,
  settings,
  sessionRuntime,
  sessionInfo,
  onSessionInfoChange,
  onForkSession,
  onNotify,
}: {
  projectId: string | null
  detail: ProjectSessionsResponse | undefined
  selectedSessionId: string | null
  setSelectedSessionId: (sessionId: string | null) => void
  refreshSessionLists: (projectIds: string[]) => void
  onProjectRequired: (text: string) => void
  pendingProjectId: string | null
  pendingProjectRequest: number
  onSessionCreated: (projectId: string, sessionId: string) => void
  settings: AppSettings
  sessionRuntime: SessionRuntimeResponse | null
  sessionInfo: SessionInfoResponse | null
  onSessionInfoChange: (info: SessionInfoResponse) => void
  onForkSession: (projectId: string, sessionId: string, upToMessageId: string) => Promise<unknown>
  onNotify: (toast: ToastState) => void
}) {
  const [liveUserMessageUuid, setLiveUserMessageUuid] = useState<string | null>(null)
  const [pendingTurn, setPendingTurn] = useState<{ sessionId: string; turn: TurnSummary } | null>(null)
  const [sessionTasks, setSessionTasks] = useState<SessionTask[]>([])
  const [sessionMeta, setSessionMeta] = useState<{ projectId: string; sessionId: string; meta: SessionTimelineResponse['sessionMeta'] } | null>(null)
  const projectName = detail?.project.name

  useEffect(() => { setLiveUserMessageUuid(null); setSessionTasks([]); setSessionMeta(null) }, [projectId, selectedSessionId])
  useEffect(() => { setPendingTurn(null) }, [projectId])

  function refreshSessionListsForCurrentProject(targetProjectId = projectId) {
    if (targetProjectId) refreshSessionLists([targetProjectId])
  }

  function handleLiveTurnChange(userMessageUuid: string | null) {
    setLiveUserMessageUuid(userMessageUuid)
  }

  const selectedPendingTurn = pendingTurn?.sessionId === selectedSessionId ? pendingTurn.turn : null
  const selectedSessionRunState = detail?.sessions.find((session) => session.id === selectedSessionId)?.runState ?? null
  const selectedSessionMeta = sessionMeta?.projectId === projectId && sessionMeta.sessionId === selectedSessionId ? sessionMeta.meta : null

  return (
    <section className="detail-panel workspace-main-panel">
      <div className="workspace-timeline">
        {projectId && selectedSessionId
          ? <SessionTimeline projectId={projectId} projectName={projectName} sessionId={selectedSessionId} pendingTurn={selectedPendingTurn} runState={selectedSessionRunState} tasks={sessionTasks} onLiveTurnChange={handleLiveTurnChange} onTasksChange={setSessionTasks} onSessionListStale={refreshSessionListsForCurrentProject} onSessionInfoChange={onSessionInfoChange} onSessionMetaChange={(meta) => setSessionMeta({ projectId, sessionId: selectedSessionId, meta })} onForkSession={selectedSessionId ? (upToMessageId) => onForkSession(projectId, selectedSessionId, upToMessageId) : undefined} onNotify={onNotify} />
          : <div className="timeline-empty-state">{projectName ? `What should we work on in ${projectName}?` : 'What should we build?'}</div>}
      </div>
      <SessionTaskList tasks={sessionTasks} />

      <TurnComposer
        projectId={projectId}
        selectedSessionId={selectedSessionId}
        selectedSessionRunState={selectedSessionRunState}
        liveUserMessageUuid={liveUserMessageUuid}
        setSelectedSessionId={setSelectedSessionId}
        setPendingTurn={setPendingTurn}
        refreshSessionLists={refreshSessionListsForCurrentProject}
        onProjectRequired={onProjectRequired}
        pendingProjectId={pendingProjectId}
        pendingProjectRequest={pendingProjectRequest}
        onSessionCreated={onSessionCreated}
        settings={settings}
        sessionRuntime={sessionRuntime}
        sessionInfo={sessionInfo}
        sessionMeta={selectedSessionMeta}
      />
    </section>
  )
}

type ToastState = { message: string; tone: 'success' | 'error' }

function SettingsPanel({ projectId, settings }: { projectId: string | null; settings: AppSettings }) {
  const queryClient = useQueryClient()
  const catalogModels = settings.modelCatalog?.models ?? []
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(settings.defaultPermissionMode ?? 'default')
  const [model, setModel] = useState<ModelSelection | DefaultTurnOption>(settings.defaultModel ?? DEFAULT_TURN_OPTION)
  const [effort, setEffort] = useState<EffortLevel | DefaultTurnOption>(settings.defaultEffort ?? DEFAULT_EFFORT)
  const [status, setStatus] = useState<ToastState | null>(null)
  const [saving, setSaving] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [menuModelValue, setMenuModelValue] = useState<ModelSelection | DefaultTurnOption>(DEFAULT_TURN_OPTION)
  const [effortMenuPosition, setEffortMenuPosition] = useState<CSSProperties>()
  const permissionMenuRef = useRef<HTMLDivElement | null>(null)
  const modelMenuRef = useRef<HTMLDivElement | null>(null)
  const selectedPermission = PERMISSION_MODE_OPTIONS.find((option) => option.value === permissionMode)
  const selectedModel = model === DEFAULT_TURN_OPTION ? undefined : catalogModels.find((item) => item.value === model || item.resolvedModel === model)
  const menuModel = menuModelValue === DEFAULT_TURN_OPTION ? undefined : catalogModels.find((item) => item.value === menuModelValue || item.resolvedModel === menuModelValue)
  const effortLevels = selectedModel?.supportsEffort ? EFFORT_ORDER.filter((level) => selectedModel.supportedEffortLevels?.includes(level)) : []
  const triggerModelLabel = selectedModel?.displayName || selectedModel?.value || 'Claude Code default'

  useEffect(() => {
    setPermissionMode(settings.defaultPermissionMode ?? 'default')
    setModel(settings.defaultModel ?? DEFAULT_TURN_OPTION)
    setEffort(settings.defaultEffort ?? DEFAULT_EFFORT)
  }, [settings.defaultPermissionMode, settings.defaultModel, settings.defaultEffort])

  useEffect(() => {
    if (model === DEFAULT_TURN_OPTION) { if (effort === DEFAULT_TURN_OPTION) setEffort(DEFAULT_EFFORT); return }
    if (!selectedModel) { setModel(DEFAULT_TURN_OPTION); setEffort(DEFAULT_EFFORT); return }
    if (!effortLevels.length) { setEffort(DEFAULT_EFFORT); return }
    if (effort === DEFAULT_TURN_OPTION || !effortLevels.includes(effort)) setEffort(defaultEffort(effortLevels))
  }, [model, selectedModel, effort, effortLevels])

  useEffect(() => {
    if (!permissionMenuOpen && !modelMenuOpen) return
    function closeOnOutsidePointer(event: globalThis.PointerEvent) {
      const target = event.target as Node
      if (permissionMenuRef.current?.contains(target) || modelMenuRef.current?.contains(target)) return
      setPermissionMenuOpen(false)
      setModelMenuOpen(false)
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setPermissionMenuOpen(false)
        setModelMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [permissionMenuOpen, modelMenuOpen])
  useEffect(() => {
    if (!status) return
    const timer = window.setTimeout(() => setStatus(null), 2200)
    return () => window.clearTimeout(timer)
  }, [status])

  function showEffortMenu(option: ModelCatalogItem, target: HTMLElement) {
    const menu = modelMenuRef.current?.querySelector('.model-effort-menu')
    if (!(menu instanceof HTMLElement)) return
    const itemRect = target.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const effortCount = option.supportedEffortLevels?.length ?? 0
    const effortMenuHeight = Math.min(220, effortCount * 38 + 16)
    const alignedTop = itemRect.top - menuRect.top
    const maxTop = window.innerHeight - menuRect.top - effortMenuHeight - 16
    setMenuModelValue(option.value)
    setEffortMenuPosition({ top: Math.max(8, Math.min(alignedTop, maxTop)) })
  }

  function chooseModelOnly(nextModel: ModelSelection | DefaultTurnOption) {
    void saveModelDefault(nextModel, DEFAULT_TURN_OPTION)
  }

  function chooseEffort(option: ModelCatalogItem, nextEffort: EffortLevel) {
    void saveModelDefault(option.value, nextEffort)
  }

  async function loadCatalog() {
    if (catalogModels.length || catalogLoading) return
    setCatalogLoading(true)
    setStatus(null)
    try {
      const response = await refreshModelCatalog(projectId)
      queryClient.setQueryData(['settings'], response)
    } catch (error) {
      setStatus({ message: error instanceof Error ? error.message : String(error), tone: 'error' })
    } finally {
      setCatalogLoading(false)
    }
  }

  async function savePermissionDefault(nextPermissionMode: PermissionMode) {
    setPermissionMode(nextPermissionMode)
    setPermissionMenuOpen(false)
    setSaving(true)
    setStatus(null)
    try {
      const response = await saveSettings({ ...settings, defaultPermissionMode: nextPermissionMode })
      queryClient.setQueryData(['settings'], response)
      setStatus({ message: 'Saved', tone: 'success' })
    } catch (error) {
      setStatus({ message: error instanceof Error ? error.message : String(error), tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  async function saveModelDefault(nextModel: ModelSelection | DefaultTurnOption, nextEffort: EffortLevel | DefaultTurnOption) {
    setModel(nextModel)
    setEffort(nextEffort)
    setModelMenuOpen(false)
    setSaving(true)
    setStatus(null)
    try {
      const response = await saveSettings({ ...settings, defaultModel: nextModel === DEFAULT_TURN_OPTION ? null : nextModel, defaultEffort: nextEffort === DEFAULT_TURN_OPTION ? null : nextEffort })
      queryClient.setQueryData(['settings'], response)
      setStatus({ message: 'Saved', tone: 'success' })
    } catch (error) {
      setStatus({ message: error instanceof Error ? error.message : String(error), tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  async function saveResumeUsesLastPermissionMode(resumeUsesLastPermissionMode: boolean) {
    setSaving(true)
    setStatus(null)
    try {
      const response = await saveSettings({ ...settings, resumeUsesLastPermissionMode })
      queryClient.setQueryData(['settings'], response)
      setStatus({ message: 'Saved', tone: 'success' })
    } catch (error) {
      setStatus({ message: error instanceof Error ? error.message : String(error), tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  async function saveResumeUsesLastModelAndEffort(resumeUsesLastModelAndEffort: boolean) {
    setSaving(true)
    setStatus(null)
    try {
      const response = await saveSettings({ ...settings, resumeUsesLastModelAndEffort })
      queryClient.setQueryData(['settings'], response)
      setStatus({ message: 'Saved', tone: 'success' })
    } catch (error) {
      setStatus({ message: error instanceof Error ? error.message : String(error), tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  async function saveShowDebugNav(showDebugNav: boolean) {
    setSaving(true)
    setStatus(null)
    try {
      const response = await saveSettings({ ...settings, showDebugNav })
      queryClient.setQueryData(['settings'], response)
      setStatus({ message: 'Saved', tone: 'success' })
    } catch (error) {
      setStatus({ message: error instanceof Error ? error.message : String(error), tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="detail-panel settings-panel" aria-label="Settings">
      <div className="settings-section">
        <h2>Settings</h2>
        <p className="muted">These defaults apply to new turns from the composer.</p>
      </div>

      <form className="settings-card" onSubmit={(event) => event.preventDefault()}>
        <div className="settings-card-copy">
          <h3>Default permission</h3>
          <p className="muted">Pick the permission mode used by new composer turns.</p>
        </div>
        <div className="settings-card-controls">
          <div className="permission-mode-picker settings-picker" ref={permissionMenuRef}>
            <button
              type="button"
              className="turn-tool-button permission-mode-trigger settings-trigger"
              aria-haspopup="menu"
              aria-expanded={permissionMenuOpen}
              onClick={() => setPermissionMenuOpen((open) => !open)}
            >
              <ComposerIcon name={permissionMode} />
              <span>{permissionMode}</span>
            </button>
            {permissionMenuOpen ? (
              <div className="permission-mode-menu settings-menu" role="menu" aria-label="Default permission mode">
                {PERMISSION_MODE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="permission-mode-option"
                    role="menuitemradio"
                    aria-checked={permissionMode === option.value}
                    onClick={() => void savePermissionDefault(option.value)}
                  >
                    <span className="permission-mode-option-icon"><ComposerIcon name={option.value} /></span>
                    <span className="permission-mode-option-copy">
                      <span className="permission-mode-option-title">{option.value}</span>
                      <span className="permission-mode-option-description">{option.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <p className="settings-picked-copy">{selectedPermission?.description}</p>
        </div>
      </form>

      <form className="settings-card" onSubmit={(event) => event.preventDefault()}>
        <div className="settings-card-copy">
          <h3>Default model / effort</h3>
          <p className="muted">Choose what the composer should send by default.</p>
        </div>
        <div className="settings-card-controls">
          <div className="model-effort-picker settings-picker" ref={modelMenuRef}>
            <button
              type="button"
              className="model-effort-trigger settings-model-trigger"
              aria-haspopup="menu"
              aria-expanded={modelMenuOpen}
              onClick={() => { setMenuModelValue(DEFAULT_TURN_OPTION); setModelMenuOpen((open) => !open); void loadCatalog() }}
            >
              <span className="model-effort-trigger-icon" aria-hidden="true">◉</span>
              <span className="model-effort-trigger-copy">
                <span className="model-effort-trigger-model">{triggerModelLabel}</span>
                {(model === DEFAULT_TURN_OPTION || selectedModel?.supportsEffort && effort !== DEFAULT_TURN_OPTION) ? <span className="model-effort-trigger-effort">{effortLabel(effort)}</span> : null}
              </span>
            </button>
            {modelMenuOpen ? (
              <div className="model-effort-menu settings-menu" role="menu" aria-label="Default model and effort">
                {catalogLoading ? <div className="model-effort-hint">Loading model catalog…</div> : null}
                {!catalogLoading && !catalogModels.length ? <div className="model-effort-hint">No models found.</div> : null}
                <div className="model-effort-models" role="group" aria-label="Models">
                  <button type="button" className="model-effort-option" role="menuitem" aria-current={model === DEFAULT_TURN_OPTION} onClick={() => chooseModelOnly(DEFAULT_TURN_OPTION)}>
                    <span className="model-effort-option-title">Claude Code default</span>
                    {model === DEFAULT_TURN_OPTION ? <span className="model-effort-option-check" aria-hidden="true">✓</span> : null}
                  </button>
                  {catalogModels.map((option) => {
                    const active = menuModel?.value === option.value
                    const selected = selectedModel?.value === option.value
                    return (
                      <button
                        key={option.value}
                        type="button"
                        className="model-effort-option"
                        role="menuitem"
                        aria-current={active}
                        onMouseEnter={(event) => showEffortMenu(option, event.currentTarget)}
                        onFocus={(event) => showEffortMenu(option, event.currentTarget)}
                        onClick={(event) => option.supportsEffort && option.supportedEffortLevels?.length ? showEffortMenu(option, event.currentTarget) : chooseModelOnly(option.value)}
                      >
                        <span className="model-effort-option-title">{option.displayName || option.value}</span>
                        {selected ? <span className="model-effort-option-check" aria-hidden="true">✓</span> : null}
                      </button>
                    )
                  })}
                </div>
                {menuModel?.supportsEffort && menuModel.supportedEffortLevels?.length ? (
                  <div className="model-effort-efforts" style={effortMenuPosition} role="group" aria-label={`${menuModel.displayName || menuModel.value} efforts`}>
                    {EFFORT_ORDER.filter((level) => menuModel.supportedEffortLevels!.includes(level)).map((level) => {
                      const selected = selectedModel?.value === menuModel.value && effort === level
                      return (
                        <button
                          key={`${menuModel.value}:${level}`}
                          type="button"
                          className="model-effort-option model-effort-option-compact"
                          role="menuitemradio"
                          aria-checked={selected}
                          onClick={() => chooseEffort(menuModel, level)}
                        >
                          <span className="model-effort-option-title">{effortLabel(level)}</span>
                          {selected ? <span className="model-effort-option-check" aria-hidden="true">✓</span> : null}
                        </button>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </form>

      <form className="settings-card" onSubmit={(event) => event.preventDefault()}>
        <div className="settings-card-copy">
          <h3>Resume permission</h3>
          <p className="muted">Use the last session permission mode when resuming instead of the default.</p>
        </div>
        <div className="settings-card-controls">
          <button
            type="button"
            className="settings-switch"
            role="switch"
            aria-checked={settings.resumeUsesLastPermissionMode === true}
            disabled={saving}
            onClick={() => void saveResumeUsesLastPermissionMode(settings.resumeUsesLastPermissionMode !== true)}
          >
            <span className="settings-switch-thumb" />
          </button>
        </div>
      </form>

      <form className="settings-card" onSubmit={(event) => event.preventDefault()}>
        <div className="settings-card-copy">
          <h3>Resume model / effort</h3>
          <p className="muted">Use the last session model and effort when resuming instead of the default.</p>
        </div>
        <div className="settings-card-controls">
          <button
            type="button"
            className="settings-switch"
            role="switch"
            aria-checked={settings.resumeUsesLastModelAndEffort === true}
            disabled={saving}
            onClick={() => void saveResumeUsesLastModelAndEffort(settings.resumeUsesLastModelAndEffort !== true)}
          >
            <span className="settings-switch-thumb" />
          </button>
        </div>
      </form>

      <form className="settings-card" onSubmit={(event) => event.preventDefault()}>
        <div className="settings-card-copy">
          <h3>Show Debug</h3>
          <p className="muted">Keep the raw message inspector in the sidebar.</p>
        </div>
        <div className="settings-card-controls">
          <button
            type="button"
            className="settings-switch"
            role="switch"
            aria-checked={settings.showDebugNav !== false}
            disabled={saving}
            onClick={() => void saveShowDebugNav(settings.showDebugNav === false)}
          >
            <span className="settings-switch-thumb" />
          </button>
        </div>
      </form>

      {status ? <div className={`settings-toast settings-toast-${status.tone}`} role="status">{status.message}</div> : null}
    </section>
  )
}

function PlaceholderPage({ title }: { title: string }) {
  return (
    <section className="detail-panel settings-panel" aria-label={title}>
      <div className="settings-section">
        <h2>{title}</h2>
        <p className="muted">Coming soon.</p>
      </div>
    </section>
  )
}

const DEBUG_TABS = ['Session observations', 'Turn meta transcript', 'Events', 'Diagnostics'] as const
const TURN_META_COLUMNS: Array<keyof TurnMetaTranscriptRow> = [
  'id', 'projectKey', 'transcriptPath', 'sessionId', 'primaryUserUuid', 'primaryTimestampMs', 'primaryByteOffset', 'primaryEntrypoint',
  'durationUuid', 'durationParentUuid', 'durationTimestampMs', 'durationMs', 'durationMessageCount', 'durationLineNo', 'durationByteOffset', 'durationByteLength',
  'durationIsSidechain', 'durationIsMeta', 'durationUserType', 'durationEntrypoint', 'durationCwd', 'durationVersion', 'durationGitBranch', 'durationSlug',
  'durationPendingBackgroundAgentCount', 'durationSessionKind', 'durationForkedFromJson', 'durationPendingWorkflowCount', 'durationPayloadJson',
  'fileMtimeMs', 'fileSize', 'scanByteOffset', 'scanLineNo', 'createdAtMs', 'updatedAtMs',
]

function turnMetaValue(key: keyof TurnMetaTranscriptRow, value: TurnMetaTranscriptRow[keyof TurnMetaTranscriptRow]) {
  if (value === null) return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if ((key === 'durationForkedFromJson' || key === 'durationPayloadJson') && typeof value === 'string') {
    let formatted = value
    try { formatted = JSON.stringify(JSON.parse(value), null, 2) } catch {}
    return <details><summary>View JSON</summary><pre>{formatted}</pre></details>
  }
  return String(value)
}
type ObservationColumnKey = SessionObservationSort | 'updatedDelta'
const OBSERVATION_COLUMNS: Array<{ key: ObservationColumnKey; label: string; value: (row: SessionObservation, previous?: SessionObservation) => unknown }> = [
  { key: 'fileMtimeMs', label: 'File mtime', value: (row) => row.fileMtimeMs },
  { key: 'payloadPid', label: 'Payload PID', value: (row) => row.payloadPid },
  { key: 'sessionId', label: 'Session', value: (row) => row.sessionId }, { key: 'cwd', label: 'CWD', value: (row) => row.cwd },
  { key: 'startedAtMs', label: 'Started', value: (row) => row.startedAtMs }, { key: 'updatedAtMs', label: 'Updated', value: (row) => row.updatedAtMs },
  { key: 'updatedDelta', label: 'Delta', value: (row, next) => next ? row.updatedAtMs !== null && next.updatedAtMs !== null ? next.updatedAtMs - row.updatedAtMs : null : null },
  { key: 'statusUpdatedAtMs', label: 'Status updated', value: (row) => row.statusUpdatedAtMs }, { key: 'version', label: 'Version', value: (row) => row.version },
  { key: 'peerProtocol', label: 'Peer protocol', value: (row) => row.peerProtocol }, { key: 'kind', label: 'Kind', value: (row) => row.kind },
  { key: 'entrypoint', label: 'Entrypoint', value: (row) => row.entrypoint }, { key: 'name', label: 'Name', value: (row) => row.name },
  { key: 'nameSource', label: 'Name source', value: (row) => row.nameSource }, { key: 'status', label: 'Status', value: (row) => row.status },
  { key: 'waitingFor', label: 'Waiting for', value: (row) => row.waitingFor }, { key: 'tempo', label: 'Tempo', value: (row) => row.tempo },
  { key: 'state', label: 'State', value: (row) => row.state }, { key: 'detail', label: 'Detail', value: (row) => row.detail },
  { key: 'needs', label: 'Needs', value: (row) => row.needs }, { key: 'agent', label: 'Agent', value: (row) => row.agent },
  { key: 'messagingSocketPath', label: 'Socket', value: (row) => row.messagingSocketPath }, { key: 'jobId', label: 'Job', value: (row) => row.jobId },
  { key: 'parkedJobId', label: 'Parked job', value: (row) => row.parkedJobId }, { key: 'bridgeSessionId', label: 'Bridge session', value: (row) => row.bridgeSessionId },
  { key: 'logPath', label: 'Log path', value: (row) => row.logPath }, { key: 'tmux', label: 'tmux', value: (row) => row.tmux },
  { key: 'pidAlive', label: 'PID alive', value: (row) => row.pidAlive }, { key: 'procStartMatches', label: 'Proc matches', value: (row) => row.procStartMatches },
  { key: 'parseError', label: 'Parse error', value: (row) => row.parseError }, { key: 'rawJson', label: 'Raw JSON', value: (row) => row.rawJson },
]
const OBSERVATION_TIME_FIELDS = new Set<SessionObservationSort>(['observedAtMs', 'fileMtimeMs', 'startedAtMs', 'updatedAtMs', 'statusUpdatedAtMs'])
const BEIJING_TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})

function observationValue(key: ObservationColumnKey, value: unknown) {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (key === 'updatedDelta' && typeof value === 'number') return `${value >= 0 ? '+' : '-'}${(Math.abs(value) / 1000).toFixed(3)}s`
  if (OBSERVATION_TIME_FIELDS.has(key as SessionObservationSort) && typeof value === 'number') return `${BEIJING_TIME_FORMAT.format(value)} CST`
  if (key === 'cwd' && typeof value === 'string') return value.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || value
  if (key === 'rawJson' && typeof value === 'string') return <details><summary>View JSON</summary><pre>{value}</pre></details>
  return String(value)
}

function DebugWorkspacePanel() {
  const [tab, setTab] = useState(0)
  const sessionSort: SessionObservationSort = 'fileMtimeMs'
  const sessionDirection: 'asc' | 'desc' = 'asc'
  const [sessionFilter, setSessionFilter] = useState<string | null | undefined>(undefined)
  const [limit, setLimit] = useState(100)
  const [offset, setOffset] = useState(0)
  const [turnMetaSession, setTurnMetaSession] = useState('')
  const [turnMetaLimit, setTurnMetaLimit] = useState(100)
  const [turnMetaOffset, setTurnMetaOffset] = useState(0)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const observations = useQuery({ queryKey: ['session-observations', sessionFilter, sessionSort, sessionDirection, limit, offset], queryFn: () => fetchSessionObservations({ sessionId: sessionFilter, sort: sessionSort, direction: sessionDirection, limit, offset }), retry: false })
  const turnMeta = useQuery({ queryKey: ['turn-meta-transcript', turnMetaSession, turnMetaLimit, turnMetaOffset], queryFn: () => fetchTurnMetaTranscript({ sessionId: turnMetaSession || undefined, limit: turnMetaLimit, offset: turnMetaOffset }), retry: false })

  function selectTab(next: number, focus = false) {
    setTab(next)
    if (focus) requestAnimationFrame(() => tabRefs.current[next]?.focus())
  }
  function handleTabKey(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const next = event.key === 'ArrowRight' ? (tab + 1) % DEBUG_TABS.length : event.key === 'ArrowLeft' ? (tab - 1 + DEBUG_TABS.length) % DEBUG_TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? DEBUG_TABS.length - 1 : null
    if (next === null) return
    event.preventDefault()
    selectTab(next, true)
  }
  useEffect(() => {
    if (sessionFilter !== undefined) return
    const firstSession = observations.data?.sessionIds.find((sessionId) => sessionId !== null) ?? observations.data?.sessionIds[0]
    if (firstSession !== undefined) setSessionFilter(firstSession)
  }, [observations.data?.sessionIds, sessionFilter])

  const entrypointGroups = Array.from((observations.data?.observations ?? []).reduce((groups, row) => {
    const key = row.entrypoint ?? 'unknown'
    groups.set(key, [...(groups.get(key) ?? []), row])
    return groups
  }, new Map<string, SessionObservation[]>()))
    .sort(([left], [right]) => (left === 'cli' ? 0 : left === 'sdk-ts' ? 1 : 2) - (right === 'cli' ? 0 : right === 'sdk-ts' ? 1 : 2) || left.localeCompare(right))

  return (
    <section className="detail-panel debug-page-panel debug-tabs-page" aria-label="Debug workspace">
      <div className="debug-tab-list" role="tablist" aria-label="Debug datasets">
        {DEBUG_TABS.map((label, index) => <button key={label} ref={(node) => { tabRefs.current[index] = node }} id={`debug-tab-${index}`} role="tab" aria-selected={tab === index} aria-controls={`debug-panel-${index}`} tabIndex={tab === index ? 0 : -1} onClick={() => selectTab(index)} onKeyDown={handleTabKey}>{label}</button>)}
      </div>
      {DEBUG_TABS.map((label, index) => (
        <div key={label} id={`debug-panel-${index}`} role="tabpanel" aria-labelledby={`debug-tab-${index}`} hidden={tab !== index} className="debug-tab-panel">
          {index === 0 ? (
            <>
              <div className="debug-observation-toolbar">
                <div><strong>Session registry observations</strong><span className="muted">Append-only snapshots from ~/.claude/sessions</span></div>
                <div className="debug-observation-actions">
                  <label>Session <select value={sessionFilter === undefined ? '' : sessionFilter ?? '__null__'} onChange={(event) => { setSessionFilter(event.target.value === '__null__' ? null : event.target.value); setOffset(0) }}>{observations.data?.sessionIds.map((sessionId) => <option key={sessionId ?? '__null__'} value={sessionId ?? '__null__'}>{sessionId ?? 'No session ID'}</option>)}</select></label>
                  <label>Rows <select value={limit} onChange={(event) => { setLimit(Number(event.target.value)); setOffset(0) }}><option>50</option><option>100</option><option>250</option></select></label>
                  <button type="button" disabled={observations.isFetching} onClick={() => void observations.refetch()}>{observations.isFetching ? 'Refreshing…' : 'Refresh'}</button>
                </div>
              </div>
              {observations.isLoading ? <div className="panel muted">Loading session observations…</div> : null}
              {observations.isError ? <div className="panel error">Failed to load session observations: {observations.error instanceof Error ? observations.error.message : 'unknown error'}</div> : null}
              {observations.data?.observations.length === 0 ? <p className="debug-empty">No session observations recorded.</p> : null}
              {entrypointGroups.length ? <div className="debug-observations-groups">{entrypointGroups.map(([entrypoint, rows]) => <section className="debug-observation-group" key={entrypoint}><h3>{entrypoint}</h3><div className="debug-table-wrap"><table className="debug-table debug-observations-table"><thead><tr>{OBSERVATION_COLUMNS.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={row.id} className={row.status === 'idle' ? 'debug-row-idle' : row.status === 'busy' ? 'debug-row-busy' : row.status === 'waiting' ? 'debug-row-waiting' : undefined}>{OBSERVATION_COLUMNS.map((column) => <td key={column.key} className={`debug-observation-cell debug-observation-${column.key}${column.key === 'entrypoint' && row.entrypoint === 'cli' ? ' debug-entrypoint-cli' : column.key === 'entrypoint' && row.entrypoint?.includes('ts') ? ' debug-entrypoint-ts' : ''}`}>{observationValue(column.key, column.value(row, rows[rowIndex + 1]))}</td>)}</tr>)}</tbody></table></div></section>)}</div> : null}
              <div className="debug-pagination"><button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</button><span>{offset + 1}–{offset + (observations.data?.observations.length ?? 0)}</span><button type="button" disabled={!observations.data?.hasMore} onClick={() => setOffset(offset + limit)}>Next</button></div>
            </>
          ) : index === 1 ? (
            <>
              <div className="debug-observation-toolbar">
                <div><strong>Turn meta transcript</strong><span className="muted">Persisted primary-message and duration metadata</span></div>
                <div className="debug-observation-actions">
                  <label>Session <select value={turnMetaSession} onChange={(event) => { setTurnMetaSession(event.target.value); setTurnMetaOffset(0) }}><option value="">All sessions</option>{turnMeta.data?.sessionIds.map((sessionId) => <option key={sessionId} value={sessionId}>{sessionId}</option>)}</select></label>
                  <label>Rows <select value={turnMetaLimit} onChange={(event) => { setTurnMetaLimit(Number(event.target.value)); setTurnMetaOffset(0) }}><option>50</option><option>100</option><option>250</option></select></label>
                  <button type="button" disabled={turnMeta.isFetching} onClick={() => void turnMeta.refetch()}>{turnMeta.isFetching ? 'Refreshing…' : 'Refresh'}</button>
                </div>
              </div>
              {turnMeta.isLoading ? <div className="panel muted">Loading turn meta transcript…</div> : null}
              {turnMeta.isError ? <div className="panel error">Failed to load turn meta transcript: {turnMeta.error instanceof Error ? turnMeta.error.message : 'unknown error'}</div> : null}
              {turnMeta.data?.entries.length === 0 ? <p className="debug-empty">No turn metadata recorded.</p> : null}
              {turnMeta.data?.entries.length ? <div className="debug-table-wrap debug-observations-wrap"><table className="debug-table debug-observations-table"><thead><tr>{TURN_META_COLUMNS.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{turnMeta.data.entries.map((entry) => <tr key={entry.id}>{TURN_META_COLUMNS.map((column) => <td key={column} className={`debug-observation-cell${column === 'durationForkedFromJson' || column === 'durationPayloadJson' ? ' debug-observation-rawJson' : ''}`}>{turnMetaValue(column, entry[column])}</td>)}</tr>)}</tbody></table></div> : null}
              <div className="debug-pagination"><button type="button" disabled={turnMetaOffset === 0} onClick={() => setTurnMetaOffset(Math.max(0, turnMetaOffset - turnMetaLimit))}>Previous</button><span>{turnMetaOffset + 1}–{turnMetaOffset + (turnMeta.data?.entries.length ?? 0)}</span><button type="button" disabled={!turnMeta.data?.hasMore} onClick={() => setTurnMetaOffset(turnMetaOffset + turnMetaLimit)}>Next</button></div>
            </>
          ) : null}
        </div>
      ))}
    </section>
  )
}

function ProjectsDashboard() {
  const queryClient = useQueryClient()
  const [activeNav, setActiveNav] = useState<DashboardNavKey>(navKeyFromPath)
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
    retry: false,
  })
  const authSession = useQuery({ queryKey: ['auth-session'], queryFn: fetchAuthSession, retry: false })
  const settings = settingsQuery.data?.settings ?? {}
  const navItems = settings.showDebugNav === false ? DASHBOARD_NAV_ITEMS.filter((item) => item.key !== 'debug') : DASHBOARD_NAV_ITEMS
  const workspaceNavActive = activeNav === 'chat'
  const selection = useProjectSessionSelection({ selectInitialProject: false, enabled: workspaceNavActive })
  const {
    selectedProjectId,
    selectedSessionId,
    clearSelection,
    selectProject,
    setSelectedSessionId,
  } = selection
  const [navWidth, setNavWidth] = useState(DASHBOARD_NAV_DEFAULT_WIDTH)
  const [isResizing, setIsResizing] = useState(false)
  const [sessionRailWidth, setSessionRailWidth] = useState(WORKSPACE_RAIL_DEFAULT_WIDTH)
  const [isSessionRailResizing, setIsSessionRailResizing] = useState(false)
  const [isSessionRailCollapsed, setIsSessionRailCollapsed] = useState(false)
  const [projectChoice, setProjectChoice] = useState<{ text: string; mode: 'choose' | 'create'; error: string | null } | null>(null)
  const [newProjectParentPath, setNewProjectParentPath] = useState('')
  const [newProjectName, setNewProjectName] = useState('')
  const projectDirectories = useQuery({
    queryKey: ['project-directories', newProjectParentPath],
    queryFn: () => fetchProjectDirectories(newProjectParentPath),
    enabled: Boolean(projectChoice && projectChoice.mode === 'create'),
    retry: false,
  })
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null)
  const [pendingProjectRequest, setPendingProjectRequest] = useState(0)
  const [refreshingLists, setRefreshingLists] = useState(false)
  const [selectedSessionRuntime, setSelectedSessionRuntime] = useState<SessionRuntimeResponse | null>(null)
  const [selectedSessionInfo, setSelectedSessionInfo] = useState<SessionInfoResponse | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [highlightedForkSession, setHighlightedForkSession] = useState<{ projectId: string; sessionId: string } | null>(null)
  const [highlightedForkSeen, setHighlightedForkSeen] = useState(false)
  const [sessionInfoOpen, setSessionInfoOpen] = useState(false)
  const [newConversationMenuOpen, setNewConversationMenuOpen] = useState(false)
  const [isSessionRailSnapping, setIsSessionRailSnapping] = useState(false)
  const [visibleSessionStates, setVisibleSessionStates] = useState<Record<string, { generation: number; loading: boolean; error: boolean }>>({})
  const [visibleProjectIds, setVisibleProjectIds] = useState<string[]>([])
  const navWidthRef = useRef(DASHBOARD_NAV_DEFAULT_WIDTH)
  const sessionRailWidthRef = useRef(WORKSPACE_RAIL_DEFAULT_WIDTH)
  const newConversationMenuRef = useRef<HTMLDivElement | null>(null)
  const pendingSessionRequestRef = useRef(0)
  const listVersionEpochRef = useRef<string | null>(null)
  const desiredProjectsVersionRef = useRef(0)
  const acknowledgedProjectsVersionRef = useRef(-1)
  const desiredProjectVersionsRef = useRef(new Map<string, number>())
  const acknowledgedProjectVersionsRef = useRef(new Map<string, number>())
  const visibleSessionGenerationsRef = useRef(new Map<string, number>())
  const projectLoadMoreInFlightRef = useRef(false)
  useEffect(() => {
    function syncPathNav() { setActiveNav(navKeyFromPath()) }
    window.addEventListener('popstate', syncPathNav)
    return () => window.removeEventListener('popstate', syncPathNav)
  }, [])
  useEffect(() => {
    if (settings.showDebugNav === false && activeNav === 'debug') navigateNav('settings')
  }, [settings.showDebugNav, activeNav])

  function navigateNav(nextNav: DashboardNavKey) {
    if (nextNav === 'chat') beginNewConversation()
    history.pushState(null, '', `${routePath(nextNav)}${window.location.search}`)
    setActiveNav(nextNav)
  }

  async function handleLogout() {
    await logout()
    await authSession.refetch()
  }

  function beginSelectionIntent(): number {
    const requestId = pendingSessionRequestRef.current + 1
    pendingSessionRequestRef.current = requestId
    return requestId
  }

  function beginNewConversation() {
    beginSelectionIntent()
    setPendingProjectId(null)
    setSelectedSessionRuntime(null)
    setSelectedSessionInfo(null)
    selection.clearSelection()
  }

  function beginNewSession() {
    setNewConversationMenuOpen(false)
    if (!selectedProjectId) {
      beginNewConversation()
      return
    }
    beginSelectionIntent()
    setPendingProjectId(null)
    setSelectedSessionRuntime(null)
    setSelectedSessionInfo(null)
    setSelectedSessionId(null)
  }

  function beginNewProject() {
    setNewConversationMenuOpen(false)
    setNewProjectName('')
    setNewProjectParentPath('')
    setProjectChoice({ text: '', mode: 'create', error: null })
  }

  function startPendingProject(projectId: string) {
    const requestId = beginSelectionIntent()
    setProjectChoice(null)
    setSelectedSessionRuntime(null)
    setSelectedSessionInfo(null)
    setPendingProjectId(projectId)
    setPendingProjectRequest(requestId)
  }

  function handleSessionCreated(projectId: string, sessionId: string) {
    selection.selectSession(projectId, sessionId)
    setSelectedSessionRuntime(null)
    setSelectedSessionInfo(null)
    setPendingProjectId(null)
  }

  async function handleForkSession(projectId: string, sessionId: string, upToMessageId?: string) {
    try {
      const fork = await forkSession(projectId, sessionId, upToMessageId)
      setHighlightedForkSession(fork)
      setHighlightedForkSeen(false)
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

  useEffect(() => { setSessionInfoOpen(false) }, [selectedProjectId, selectedSessionId])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(null), 2200)
    return () => window.clearTimeout(timeout)
  }, [toast])

  useEffect(() => {
    if (!highlightedForkSession || !highlightedForkSeen) return
    const timeout = window.setTimeout(() => {
      setHighlightedForkSession(null)
      setHighlightedForkSeen(false)
    }, 2500)
    return () => window.clearTimeout(timeout)
  }, [highlightedForkSeen, highlightedForkSession])

  useEffect(() => {
    if (!newConversationMenuOpen) return
    function closeOnOutsidePointer(event: globalThis.PointerEvent) {
      if (newConversationMenuRef.current?.contains(event.target as Node)) return
      setNewConversationMenuOpen(false)
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setNewConversationMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [newConversationMenuOpen])


  useEffect(() => {
    setSelectedSessionInfo(null)
  }, [selectedProjectId, selectedSessionId])

  async function createProjectForPendingTurn(directoryPath: string) {
    if (!projectChoice || projectChoice.mode !== 'create') return
    try {
      const { project } = await createProject(directoryPath)
      setToast({ message: 'Project created', tone: 'success' })
      if (projectChoice.text.trim()) {
        startPendingProject(project.id)
        return
      }
      beginSelectionIntent()
      setProjectChoice(null)
      setPendingProjectId(null)
      setSelectedSessionRuntime(null)
      setSelectedSessionInfo(null)
      selection.selectProject(project.id)
      await refreshProjects(project.id)
      await refreshProjectsOnly()
      await refreshVisibleWindows([project.id])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setProjectChoice((current) => current ? { ...current, error: message } : current)
      setToast({ message: `Failed to create project: ${message}`, tone: 'error' })
    }
  }

  useEffect(() => {
    navWidthRef.current = navWidth
  }, [navWidth])

  useEffect(() => {
    if (sessionRailWidth >= WORKSPACE_RAIL_MIN_WIDTH) sessionRailWidthRef.current = sessionRailWidth
  }, [sessionRailWidth])

  useEffect(() => {
    try {
      const storedWidth = window.localStorage.getItem(DASHBOARD_NAV_WIDTH_STORAGE_KEY)
      if (!storedWidth) return
      const parsedWidth = Number(storedWidth)
      if (!Number.isFinite(parsedWidth)) return
      const nextWidth = clampDashboardNavWidth(parsedWidth)
      navWidthRef.current = nextWidth
      setNavWidth(nextWidth)
    } catch {
      // ignore localStorage read errors
    }
  }, [])

  useEffect(() => {
    try {
      const storedCollapsed = window.localStorage.getItem(WORKSPACE_RAIL_COLLAPSED_STORAGE_KEY) === 'true'
      const storedWidth = window.localStorage.getItem(WORKSPACE_RAIL_WIDTH_STORAGE_KEY)
      if (storedWidth) {
        const parsedWidth = Number(storedWidth)
        if (Number.isFinite(parsedWidth)) {
          const nextWidth = clampWorkspaceRailWidth(parsedWidth)
          sessionRailWidthRef.current = nextWidth
          setSessionRailWidth(storedCollapsed ? 0 : nextWidth)
        }
      } else if (storedCollapsed) {
        setSessionRailWidth(0)
      }
      setIsSessionRailCollapsed(storedCollapsed)
    } catch {
      // ignore localStorage read errors
    }
  }, [])

  function beginNavResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()
    const handle = event.currentTarget
    const pointerId = event.pointerId
    const startX = event.clientX
    const startWidth = navWidthRef.current
    setIsResizing(true)
    handle.setPointerCapture?.(pointerId)

    function handlePointerMove(moveEvent: PointerEvent) {
      const nextWidth = clampDashboardNavWidth(startWidth + moveEvent.clientX - startX)
      navWidthRef.current = nextWidth
      setNavWidth(nextWidth)
    }

    function finishResize() {
      setIsResizing(false)
      try {
        handle.releasePointerCapture?.(pointerId)
      } catch {
        // ignore pointer capture release errors
      }
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
      try {
        window.localStorage.setItem(DASHBOARD_NAV_WIDTH_STORAGE_KEY, String(navWidthRef.current))
      } catch {
        // ignore localStorage write errors
      }
    }

    function handlePointerUp() {
      finishResize()
    }

    function handlePointerCancel() {
      finishResize()
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
  }

  function setSessionRailCollapsed(nextCollapsed: boolean) {
    setSessionRailWidth(nextCollapsed ? 0 : sessionRailWidthRef.current)
    setIsSessionRailCollapsed(nextCollapsed)
    try {
      window.localStorage.setItem(WORKSPACE_RAIL_COLLAPSED_STORAGE_KEY, String(nextCollapsed))
    } catch {
      // ignore localStorage write errors
    }
  }

  function beginSessionRailResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (window.matchMedia('(max-width: 900px)').matches) return
    event.preventDefault()
    const handle = event.currentTarget
    const pointerId = event.pointerId
    const startX = event.clientX
    const startWidth = isSessionRailCollapsed ? 0 : sessionRailWidth
    let nextSavedWidth = startWidth
    setIsSessionRailResizing(true)
    setIsSessionRailSnapping(false)
    handle.setPointerCapture?.(pointerId)

    function handlePointerMove(moveEvent: PointerEvent) {
      const dragWidth = clampWorkspaceRailDragWidth(startWidth + moveEvent.clientX - startX)
      if (startWidth === 0 && dragWidth < WORKSPACE_RAIL_MIN_WIDTH / 2) {
        nextSavedWidth = 0
        setIsSessionRailSnapping(false)
        setSessionRailWidth(0)
        setIsSessionRailCollapsed(true)
        return
      }
      if (startWidth > 0 && dragWidth < WORKSPACE_RAIL_MIN_WIDTH / 2) {
        nextSavedWidth = 0
        setIsSessionRailSnapping(true)
        setSessionRailWidth(0)
        setIsSessionRailCollapsed(true)
        return
      }
      const nextWidth = Math.max(WORKSPACE_RAIL_MIN_WIDTH, dragWidth)
      nextSavedWidth = nextWidth
      setIsSessionRailSnapping(dragWidth < WORKSPACE_RAIL_MIN_WIDTH)
      setSessionRailWidth(nextWidth)
      setIsSessionRailCollapsed(false)
      sessionRailWidthRef.current = nextWidth
    }

    function finishResize(forceCollapsed?: boolean) {
      const collapsed = forceCollapsed ?? nextSavedWidth < WORKSPACE_RAIL_MIN_WIDTH
      if (collapsed) setSessionRailWidth(0)
      setIsSessionRailCollapsed(collapsed)
      setIsSessionRailResizing(false)
      setIsSessionRailSnapping(false)
      try {
        handle.releasePointerCapture?.(pointerId)
      } catch {
        // ignore pointer capture release errors
      }
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
      try {
        window.localStorage.setItem(WORKSPACE_RAIL_COLLAPSED_STORAGE_KEY, String(collapsed))
        if (!collapsed) window.localStorage.setItem(WORKSPACE_RAIL_WIDTH_STORAGE_KEY, String(sessionRailWidthRef.current))
      } catch {
        // ignore localStorage write errors
      }
    }

    function handlePointerUp() {
      finishResize()
    }

    function handlePointerCancel() {
      finishResize()
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
  }

  const navCollapsed = navWidth <= DASHBOARD_NAV_COLLAPSE_WIDTH
  const detail = selection.projectSessions.data
  const selectedSession = detail?.sessions.find((session) => session.id === selectedSessionId)
    ?? queryClient.getQueryData<{ pages: Array<{ sessions: ProjectSessionsResponse['sessions'] }> }>(sessionQueryKeys.projectSessionsRail(selectedProjectId ?? ''))?.pages
      .flatMap((page) => page.sessions)
      .find((session) => session.id === selectedSessionId)
  const workspaceTitle = detail?.project.name ?? (selection.projectSessions.isLoading ? 'Loading project…' : selectedProjectId ? 'Project' : '')
  const headerSessionInfo = selectedSessionInfo?.projectId === selectedProjectId && selectedSessionInfo.sessionId === selectedSessionId ? selectedSessionInfo : null
  const infoText = (value: string | number | null | undefined) => {
    if (value == null) return '—'
    if (typeof value === 'string') return value.trim() ? value : '—'
    return String(value)
  }
  const infoTime = (value: number | null | undefined) => value == null ? '—' : new Date(value).toLocaleString()
  const infoBytes = (value: number | null | undefined) => value == null ? '—' : `${value.toLocaleString()} bytes`
  const headerSessionInfoRows: Array<[string, string]> = headerSessionInfo
    ? [
        ['Summary', infoText(headerSessionInfo.summary)],
        ['Session ID', infoText(headerSessionInfo.sessionId)],
        ['Custom title', infoText(headerSessionInfo.customTitle)],
        ['First prompt', infoText(headerSessionInfo.firstPrompt)],
        ['Git branch', infoText(headerSessionInfo.gitBranch)],
        ['CWD', infoText(headerSessionInfo.cwd)],
        ['Tag', infoText(headerSessionInfo.tag)],
        ['Created', infoTime(headerSessionInfo.createdAt)],
        ['Last modified', infoTime(headerSessionInfo.lastModified)],
        ['File size', infoBytes(headerSessionInfo.fileSize)],
      ]
    : []

  const reconcileSelection = useCallback((selectionSnapshot: { intentId: number; projectId: string | null; sessionId: string | null }, outcomes: Map<string, { outcome: string; selectedSessionExists?: boolean }>) => {
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
    if (selectedSessionId && selectedProjectOutcome?.selectedSessionExists === false) setSelectedSessionId(null)
  }, [clearSelection, queryClient, selectProject, selectedProjectId, selectedSessionId, setSelectedSessionId])

  const refreshVisibleWindows = useCallback(async (projectIds = visibleProjectIds) => {
    const targetProjectIds = [...new Set(projectIds)]
    if (targetProjectIds.length === 0) return new Map<string, { outcome: string; selectedSessionExists?: boolean }>()
    const selectionSnapshot = {
      intentId: pendingSessionRequestRef.current,
      projectId: selectedProjectId,
      sessionId: selectedSessionId,
    }
    const generations = new Map(targetProjectIds.map((projectId) => {
      const generation = (visibleSessionGenerationsRef.current.get(projectId) ?? 0) + 1
      visibleSessionGenerationsRef.current.set(projectId, generation)
      return [projectId, generation]
    }))
    setVisibleSessionStates((current) => ({
      ...current,
      ...Object.fromEntries(targetProjectIds.map((projectId) => [projectId, { generation: generations.get(projectId)!, loading: true, error: false }])),
    }))
    try {
      const outcomes = await refreshVisibleProjectSessions(queryClient, {
        selectedProjectId: selectionSnapshot.projectId,
        selectedSessionId: selectionSnapshot.sessionId,
        visibleProjectIds: targetProjectIds,
      })
      reconcileSelection(selectionSnapshot, outcomes)
      setVisibleSessionStates((current) => {
        const next = { ...current }
        for (const projectId of targetProjectIds) {
          if (next[projectId]?.generation !== generations.get(projectId)) continue
          next[projectId] = { generation: generations.get(projectId)!, loading: false, error: false }
        }
        return next
      })
      return outcomes
    } catch (error) {
      console.error('visible-sessions:refresh failed', error)
      setVisibleSessionStates((current) => {
        const next = { ...current }
        for (const projectId of targetProjectIds) {
          if (next[projectId]?.generation !== generations.get(projectId)) continue
          next[projectId] = { generation: generations.get(projectId)!, loading: false, error: true }
        }
        return next
      })
      return new Map<string, { outcome: string; selectedSessionExists?: boolean }>()
    }
  }, [queryClient, reconcileSelection, selectedProjectId, selectedSessionId, visibleProjectIds])

  const refreshProjectsOnly = useCallback(async () => {
    const desiredVersion = desiredProjectsVersionRef.current
    const epoch = listVersionEpochRef.current
    const outcome = await refreshProjectsWindow(queryClient)
    if (outcome === 'applied' && listVersionEpochRef.current === epoch) acknowledgedProjectsVersionRef.current = desiredVersion
    return outcome
  }, [queryClient])

  function handleSelectSession(projectId: string, sessionId: string) {
    const requestId = beginSelectionIntent()
    setSelectedSessionRuntime(null)
    if (projectId !== selectedProjectId || sessionId !== selectedSessionId) selection.selectSession(projectId, sessionId)
    void ensureSessionRuntime(projectId, sessionId).then((runtime) => {
      if (pendingSessionRequestRef.current === requestId) setSelectedSessionRuntime(runtime)
    }).catch(() => {})
  }

  async function handleDeleteSession(projectId: string, sessionId: string, confirmationSessionId: string) {
    try {
      await deleteSession(projectId, sessionId, confirmationSessionId)
      removeProjectSessionFromCache(queryClient, projectId, sessionId)
      if (selectedProjectId === projectId && selectedSessionId === sessionId) {
        beginSelectionIntent()
        setSelectedSessionId(null)
        setSelectedSessionRuntime(null)
        setSelectedSessionInfo(null)
      }
      await refreshProjectsOnly()
      await refreshVisibleWindows([projectId])
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
      await refreshVisibleWindows([projectId])
      if (selectedProjectId === projectId && selectedSessionId === sessionId) {
        setSelectedSessionInfo(await fetchSessionInfo(projectId, sessionId))
      }
      setToast({ message: 'Session renamed', tone: 'success' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setToast({ message: `Failed to rename session: ${message}`, tone: 'error' })
      throw error
    }
  }

  useEffect(() => {
    const events = connectListVersions((event: ListVersionsEvent) => {
      const epochChanged = listVersionEpochRef.current !== event.epoch
      if (epochChanged) {
        listVersionEpochRef.current = event.epoch
        desiredProjectsVersionRef.current = 0
        acknowledgedProjectsVersionRef.current = -1
        desiredProjectVersionsRef.current.clear()
        acknowledgedProjectVersionsRef.current.clear()
      }
      desiredProjectsVersionRef.current = Math.max(desiredProjectsVersionRef.current, event.projectsVersion)
      for (const { projectId, version } of event.projectVersions) {
        desiredProjectVersionsRef.current.set(projectId, Math.max(desiredProjectVersionsRef.current.get(projectId) ?? 0, version))
      }
      if (epochChanged || desiredProjectsVersionRef.current > acknowledgedProjectsVersionRef.current) void refreshProjectsOnly()
      if (selectedProjectId && selectedSessionId && event.sessionChanges.some((change) => change.kind === 'changed' && change.projectId === selectedProjectId && change.sessionId === selectedSessionId)) {
        void queryClient.refetchQueries({ queryKey: ['session-info', selectedProjectId, selectedSessionId], exact: true })
        void queryClient.refetchQueries({ queryKey: ['session-timeline', selectedProjectId, selectedSessionId], exact: true })
      }
      const projectIds = visibleProjectIds.filter((projectId) => epochChanged || (desiredProjectVersionsRef.current.get(projectId) ?? 0) > (acknowledgedProjectVersionsRef.current.get(projectId) ?? -1))
      if (projectIds.length === 0) return
      void refreshVisibleWindows(projectIds).then((outcomes) => {
        for (const projectId of projectIds) {
          if (outcomes.get(projectId)?.outcome !== 'applied') continue
          const desired = desiredProjectVersionsRef.current.get(projectId)
          if (desired !== undefined) acknowledgedProjectVersionsRef.current.set(projectId, desired)
        }
      })
    })
    return () => events.close()
  }, [queryClient, refreshProjectsOnly, refreshVisibleWindows, selectedProjectId, selectedSessionId, visibleProjectIds])

  useEffect(() => {
    if (visibleProjectIds.length === 0) return
    void refreshVisibleWindows()
  }, [refreshVisibleWindows, visibleProjectIds])

  useEffect(() => {
    function refreshIfVisible() {
      if (document.visibilityState === 'hidden') return
      void refreshProjectsOnly()
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
  }, [refreshProjectsOnly, refreshVisibleWindows, visibleProjectIds])

  async function handleRefreshLists() {
    if (refreshingLists) return
    setRefreshingLists(true)
    const epoch = listVersionEpochRef.current
    const desiredVersions = new Map(visibleProjectIds.map((projectId) => [projectId, desiredProjectVersionsRef.current.get(projectId)]))
    try {
      await refreshProjects(selection.selectedProjectId)
      await refreshProjectsOnly()
      const outcomes = await refreshVisibleWindows()
      if (listVersionEpochRef.current !== epoch) return
      for (const [projectId, desiredVersion] of desiredVersions) {
        if (desiredVersion === undefined || outcomes.get(projectId)?.outcome !== 'applied') continue
        acknowledgedProjectVersionsRef.current.set(projectId, Math.max(acknowledgedProjectVersionsRef.current.get(projectId) ?? -1, desiredVersion))
      }
    } finally {
      setRefreshingLists(false)
    }
  }

  if (workspaceNavActive && selection.projects.isLoading) return <div className="panel muted">Loading Claude Code projects…</div>
  if (workspaceNavActive && selection.projects.isError) return <div className="panel error">Failed to load projects: {selection.projects.error instanceof Error ? selection.projects.error.message : 'unknown error'}</div>

  return (
    <div
      className="dashboard-layout"
      data-nav-collapsed={navCollapsed ? 'true' : 'false'}
      data-nav-resizing={isResizing ? 'true' : 'false'}
      data-session-rail-resizing={isSessionRailResizing ? 'true' : 'false'}
      data-session-rail-snapping={isSessionRailSnapping ? 'true' : 'false'}
      style={{ '--dashboard-nav-width': `${navWidth}px`, '--workspace-rail-width': `${sessionRailWidth}px` } as CSSProperties}
    >
      <aside className="dashboard-nav-rail" aria-label="Dashboard navigation">
        <nav className="dashboard-nav-links" aria-label="Workspace sections">
          {navItems.map((item) => (
            <a
              key={item.key}
              className={`dashboard-nav-link ${activeNav === item.key ? 'active' : ''}`}
              href={`${item.path}${window.location.search}`}
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                event.preventDefault()
                navigateNav(item.key)
              }}
              aria-current={activeNav === item.key ? 'page' : undefined}
              aria-label={item.label}
            >
              <span className="dashboard-nav-icon" aria-hidden="true"><DashboardNavIcon itemKey={item.key} /></span>
              <span className="dashboard-nav-label">{item.label}</span>
            </a>
          ))}
        </nav>
        {authSession.data?.authenticated ? <button className="dashboard-nav-link logout-link" type="button" onClick={() => void handleLogout()}>Logout</button> : null}
      </aside>
      {!workspaceNavActive ? (
        <section className="settings-page-shell">
          {activeNav === 'settings' ? <SettingsPanel projectId={null} settings={settings} /> : activeNav === 'debug' ? <DebugWorkspacePanel /> : <PlaceholderPage title={DASHBOARD_NAV_ITEMS.find((item) => item.key === activeNav)?.label ?? 'Page'} />}
        </section>
      ) : (
        <section className="workspace-panel" data-session-rail-collapsed={isSessionRailCollapsed ? 'true' : 'false'}>
          <div className="dashboard-nav-resize-handle" role="separator" aria-label="Resize navigation sidebar" aria-orientation="vertical" onPointerDown={beginNavResize} />
          <div className="workspace-rail-pane" aria-hidden={isSessionRailCollapsed ? 'true' : undefined}>
            <header className="project-rail-header workspace-panel-header">
              <h2 className="project-rail-title" id="projects-sidebar-section-heading">Projects</h2>
              <button
                className="project-rail-header-action"
                type="button"
                onClick={handleRefreshLists}
                disabled={refreshingLists}
                aria-label="Refresh project and session lists"
                title="Refresh project and session lists"
              >
                {refreshingLists ? <span className="turn-spinner session-age-spinner" aria-hidden="true" /> : '↻'}
              </button>
            </header>
            <ProjectSessionRail
              projects={selection.items}
              selectedProjectId={selectedProjectId}
              selectedSessionId={selectedSessionId}
              pendingProjectId={null}
              pendingSessionId={null}
              highlightedProjectId={highlightedForkSession?.projectId ?? null}
              highlightedSessionId={highlightedForkSession?.sessionId ?? null}
              projectsHasMore={selection.projects.hasNextPage}
              projectsLoadingMore={selection.projects.isFetchingNextPage}
              onLoadMoreProjects={() => {
                if (projectLoadMoreInFlightRef.current || !selection.projects.hasNextPage || selection.projects.isFetchingNextPage) return
                projectLoadMoreInFlightRef.current = true
                void selection.projects.fetchNextPage({ throwOnError: true }).catch((error) => {
                  if (error instanceof PaginationCursorStaleError) return refreshProjectsWindow(queryClient)
                }).finally(() => {
                  projectLoadMoreInFlightRef.current = false
                })
              }}
              visibleSessionStates={visibleSessionStates}
              onVisibleProjectIdsChange={setVisibleProjectIds}
              onSelectProject={(projectId) => {
                beginSelectionIntent()
                setSelectedSessionRuntime(null)
                setSelectedSessionInfo(null)
                selection.selectProject(projectId)
              }}
              onSelectSession={handleSelectSession}
              onDeleteSession={handleDeleteSession}
              onRenameSession={handleRenameSession}
              onForkSession={handleForkSession}
              onSessionCursorStale={(projectId) => { void refreshVisibleWindows([projectId]) }}
              onHighlightedSessionSeen={() => setHighlightedForkSeen(true)}
            />
          </div>
          <div
            className="workspace-rail-resize-handle"
            role="separator"
            aria-label="Resize project and session list"
            aria-orientation="vertical"
            aria-valuemin={WORKSPACE_RAIL_MIN_WIDTH}
            aria-valuemax={WORKSPACE_RAIL_MAX_WIDTH}
            aria-valuenow={sessionRailWidth}
            onPointerDown={beginSessionRailResize}
          />
          <div className="workspace-main-pane">
            <header className="workspace-main-header workspace-panel-header">
              <div className="project-title-block">
                <button
                  className="workspace-rail-toggle"
                  type="button"
                  aria-label={isSessionRailCollapsed ? 'Show project and session list' : 'Hide project and session list'}
                  aria-expanded={!isSessionRailCollapsed}
                  aria-controls="projects-sidebar-section-heading"
                  onClick={() => setSessionRailCollapsed(!isSessionRailCollapsed)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" data-icon={isSessionRailCollapsed ? 'SideFoldOutlined' : 'SideExpandOutlined'}>
                    <path d={isSessionRailCollapsed ? 'M22 4a1 1 0 0 0-1-1H3a1 1 0 0 0 0 2h18a1 1 0 0 0 1-1Zm-1.111 7c.614 0 1.111.448 1.111 1s-.497 1-1.111 1H13.11c-.613 0-1.11-.448-1.11-1s.498-1 1.111-1h7.778ZM22 20c0-.552-.497-1-1.111-1H13.11c-.614 0-1.111.448-1.111 1s.498 1 1.111 1h7.778c.614 0 1.111-.448 1.111-1ZM8.59 16.864a1.117 1.117 0 0 0 0-1.729l-4.95-3.916c-.676-.535-1.64-.027-1.64.864v7.834c0 .89.964 1.4 1.639.865l4.951-3.918Z' : 'M22 4a1 1 0 0 0-1-1H3a1 1 0 0 0 0 2h18a1 1 0 0 0 1-1Zm-11.111 7c.614 0 1.111.448 1.111 1s-.498 1-1.111 1H3.11C2.497 13 2 12.552 2 12s.497-1 1.111-1h7.778ZM12 20c0-.552-.498-1-1.111-1H3.11C2.497 19 2 19.448 2 20s.497 1 1.111 1h7.778c.614 0 1.111-.448 1.111-1Zm3.41-3.136a1.117 1.117 0 0 1 0-1.729l4.951-3.917c.675-.534 1.639-.026 1.639.865v7.834c0 .89-.964 1.4-1.639.865l-4.951-3.918Z'} fill="currentColor" />
                  </svg>
                </button>
                <div className="project-title-text">
                  <div className="project-session-title">
                    <h2>{workspaceTitle}</h2>
                    {selectedSession ? <span>{selectedSession.title}</span> : null}
                  </div>
                </div>
              </div>
              <div className="project-meta-lines">
                {headerSessionInfoRows.length > 0 ? (
                  <button
                    className="project-meta-icon project-session-info-toggle"
                    type="button"
                    aria-label="Toggle session info"
                    aria-expanded={sessionInfoOpen}
                    aria-controls="workspace-session-info"
                    onClick={() => setSessionInfoOpen((open) => !open)}
                  >
                    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" data-icon="InfoOutlined" aria-hidden="true"><path d="M11 15.5v-4a1 1 0 1 1 0-2h1.004c.55 0 .998.445.998.996.003 1.668-.002 3.336-.002 5.004h.5a1 1 0 1 1 0 2h-3a1 1 0 1 1 0-2h.5Zm1-7a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" fill="currentColor" /></svg>
                  </button>
                ) : null}
                <div className="workspace-new-conversation-menu" ref={newConversationMenuRef} onMouseEnter={() => setNewConversationMenuOpen(true)} onMouseLeave={() => setNewConversationMenuOpen(false)}>
                  <button
                    className="project-meta-icon workspace-new-conversation-button"
                    type="button"
                    onClick={() => setNewConversationMenuOpen((open) => !open)}
                    disabled={refreshingLists}
                    aria-haspopup="menu"
                    aria-expanded={newConversationMenuOpen}
                    aria-label="Create new"
                    title="Create new"
                  >
                    +
                  </button>
                  {newConversationMenuOpen ? (
                    <div className="workspace-new-conversation-menu-list" role="menu" aria-label="Create new">
                      <button className="workspace-new-conversation-menu-item" type="button" role="menuitem" onClick={beginNewSession}>New Session</button>
                      <button className="workspace-new-conversation-menu-item" type="button" role="menuitem" onClick={beginNewProject}>New Project</button>
                    </div>
                  ) : null}
                </div>
              </div>
            </header>
            {sessionInfoOpen && headerSessionInfoRows.length > 0 ? (
              <div className="session-info-block" id="workspace-session-info">
                <dl className="session-info-kv">
                  {headerSessionInfoRows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
                </dl>
              </div>
            ) : null}
            <div className="workspace-main-content">
              {selection.projectSessions.isError ? <div className="panel error workspace-panel-error">Failed to load project sessions: {selection.projectSessions.error instanceof Error ? selection.projectSessions.error.message : 'unknown error'}</div> : <WorkspacePanel
                    projectId={selection.selectedProjectId}
                    detail={selection.projectSessions.data}
                    selectedSessionId={selection.selectedSessionId}
                    setSelectedSessionId={selection.setSelectedSessionId}
                    refreshSessionLists={refreshVisibleWindows}
                    onProjectRequired={(text) => { setNewProjectName(''); setNewProjectParentPath(''); setProjectChoice({ text, mode: 'choose', error: null }) }}
                    pendingProjectId={pendingProjectId}
                    pendingProjectRequest={pendingProjectRequest}
                    onSessionCreated={handleSessionCreated}
                    settings={settings}
                    sessionRuntime={selectedSessionRuntime}
                    sessionInfo={selectedSessionInfo}
                    onSessionInfoChange={setSelectedSessionInfo}
                    onForkSession={handleForkSession}
                    onNotify={setToast}
                  />}
            </div>
          </div>
        </section>
      )}
      {toast ? <div className={`settings-toast settings-toast-${toast.tone}`} role="status">{toast.message}</div> : null}
      {projectChoice ? (
        <dialog className="project-choice-dialog" open aria-labelledby="project-choice-title">
          <form className="project-choice-form" onSubmit={(event) => {
            event.preventDefault()
            const name = newProjectName.trim()
            if (projectChoice.mode === 'create' && name) void createProjectForPendingTurn(newProjectParentPath ? `${newProjectParentPath}/${name}` : name)
          }}>
            <h2 id="project-choice-title">{projectChoice.mode === 'create' ? 'Create project' : 'Choose a project'}</h2>
            <p>{projectChoice.text.trim() ? 'Your first message will start a new session in the selected project.' : 'Create a project directory and start a blank session there.'}</p>
            {projectChoice.mode === 'choose' ? (
              <>
                {selection.items.length > 0 ? (
                  <div className="project-choice-list">
                    {selection.items.map((project) => <button key={project.id} type="button" onClick={() => startPendingProject(project.id)}>{project.name}</button>)}
                  </div>
                ) : <p className="panel muted">No existing projects found.</p>}
                <button type="button" className="project-choice-link" onClick={() => setProjectChoice((current) => current ? { ...current, mode: 'create', error: null } : current)}>Create new project directory</button>
              </>
            ) : (
              <div className="project-choice-create">
                <div className="project-choice-parent-row">
                  <span>Parent: {newProjectParentPath || '/'}</span>
                  {newProjectParentPath ? <button type="button" onClick={() => setNewProjectParentPath(newProjectParentPath.split('/').slice(0, -1).join('/'))}>Up</button> : null}
                </div>
                {projectDirectories.isLoading ? <p className="muted">Loading directories…</p> : projectDirectories.isError ? <p className="error panel">Failed to load directories.</p> : projectDirectories.data?.directories.length ? (
                  <div className="project-choice-list project-choice-directory-list">
                    {projectDirectories.data.directories.map((directory) => <button key={directory.path} type="button" onClick={() => setNewProjectParentPath(directory.path)}>{directory.name}</button>)}
                  </div>
                ) : <p className="muted">No child directories.</p>}
                <label className="project-choice-path">
                  <span>Project directory name</span>
                  <input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="demo-project" autoFocus />
                </label>
              </div>
            )}
            {projectChoice.error ? <div className="panel error">{projectChoice.error}</div> : null}
            <div className="project-choice-actions">
              <button type="button" onClick={() => setProjectChoice(null)}>Cancel</button>
              {projectChoice.mode === 'create' ? <button type="submit" disabled={!newProjectName.trim()}>{projectChoice.text.trim() ? 'Create and start' : 'Create project'}</button> : null}
            </div>
          </form>
        </dialog>
      ) : null}
    </div>
  )
}

function AccessRequired({ session }: { session?: { githubConfigured: boolean } }) {
  const queryClient = useQueryClient()
  const [flow, setFlow] = useState<{ flowId: string; userCode: string; verificationUri: string; verificationUriComplete?: string; interval: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!flow) return
    let stopped = false
    const poll = async () => {
      try {
        const response = await pollGitHubDeviceLogin(flow.flowId)
        if (stopped) return
        if (response.status === 'authorized') {
          await queryClient.invalidateQueries({ queryKey: ['auth-session'] })
          return
        }
        window.setTimeout(poll, response.interval * 1000)
      } catch (error) {
        if (!stopped) setError(error instanceof Error ? error.message : String(error))
      }
    }
    const timer = window.setTimeout(poll, flow.interval * 1000)
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [flow, queryClient])

  async function startLogin() {
    setError(null)
    try {
      setFlow(await startGitHubDeviceLogin())
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <section className="panel access-required">
      <p className="eyebrow">Sign in</p>
      <h2>Open Cotta with GitHub.</h2>
      <p className="lede">GitHub authorizes your identity; Cotta stores a local HttpOnly session cookie.</p>
      {session?.githubConfigured ? <div className="login-actions"><button type="button" onClick={startLogin}>Sign in with GitHub</button></div> : null}
      {flow ? (
        <div className="panel login-device-flow">
          <p className="muted">Enter this code on GitHub:</p>
          <p className="login-code">{flow.userCode}</p>
          <a href={flow.verificationUriComplete ?? flow.verificationUri} target="_blank" rel="noreferrer">Open GitHub device login</a>
          <p className="muted">Waiting for authorization…</p>
        </div>
      ) : null}
      {error ? <div className="panel error">{error}</div> : null}
    </section>
  )
}

function App() {
  const authSession = useQuery({ queryKey: ['auth-session'], queryFn: fetchAuthSession, retry: false })
  const session = authSession.data
  const authenticated = Boolean(session?.authenticated || (session && !session.githubConfigured))

  return (
    <main className="shell">
      {authSession.isLoading ? <div className="panel muted">Loading authentication…</div> : authenticated ? <ProjectsDashboard /> : <AccessRequired session={session} />}
    </main>
  )
}

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode><QueryClientProvider client={queryClient}><App /></QueryClientProvider></StrictMode>,
)
