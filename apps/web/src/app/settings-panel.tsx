import {
  type AppSettings,
  type AppSettingsUpdate,
  type AuthSessionResponse,
  type DefaultTurnOption,
  type EffortLevel,
  isSingleUser,
  type ModelCatalogItem,
  type ModelSelection,
  matchingCatalogModel,
  type PermissionMode,
  supportedEffortLevels,
  terminalOriginUpdateRequestSchema,
} from '@cotta/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import { fetchBuildInfo, fetchGitHubConfig, pollGitHubStepUp, refreshModelCatalog, saveGitHubConfig, saveSettings, saveTerminalOrigin, startGitHubDeviceLogin } from '../api'
import { writeClipboard } from '../timeline/content'
import { DEFAULT_TURN_OPTION, effortLabel, ModelIcon, PERMISSION_MODE_OPTIONS } from './turn-option-controls'

const SETTINGS_MODEL_CATALOG_QUERY_KEY = ['settings-model-catalog'] as const

function timeZoneOffsetMinutes(timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(new Date())
    const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? ''
    const match = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/)
    if (!match) return 0
    const sign = match[1] === '-' ? -1 : 1
    return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0))
  } catch {
    return 0
  }
}

function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return m ? `UTC${sign}${h}:${String(m).padStart(2, '0')}` : `UTC${sign}${h}`
}

const TIME_ZONES = ['UTC', ...Intl.supportedValuesOf('timeZone')]
  .map((value) => ({ value, offset: timeZoneOffsetMinutes(value) }))
  .sort((a, b) => a.offset - b.offset || a.value.localeCompare(b.value))
  .map(({ value, offset }) => ({ value, label: value === 'UTC' ? 'UTC' : `(${offsetLabel(offset)}) ${value}` }))

type ToastState = { message: string; tone: 'success' | 'error' }

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m`
  return `${seconds}s`
}

/** Permission icons for Settings: one shared shield outline with a mode-specific glyph inside. */
const PERMISSION_SHIELD_GLYPH: Record<PermissionMode, string> = {
  plan: 'M8.5 10h7M8.5 12.6h4.5',
  dontAsk: 'm8.8 8.6 6.4 6.4',
  default: 'M12 8.6v3.1M12 14.4h.01',
  acceptEdits: 'm8.6 11.6 2.3 2.3 4.5-4.8',
  auto: 'm12 7.6 1.15 2.85 2.85 1.15-2.85 1.15L12 16.6l-1.15-2.85L8 12.6l2.85-1.15L12 7.6Z',
  bypassPermissions: 'm13.2 7.6-4 5.3h2.9l-.8 4 4-5.3h-2.9l.8-4Z',
}

function PermissionShieldIcon({ name }: { name: PermissionMode }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="permission-shield-icon">
      <path d="M12 3 5 5.7v5.3c0 4 2.9 7.2 7 8.3 4.1-1.1 7-4.3 7-8.3V5.7L12 3Z" />
      <path d={PERMISSION_SHIELD_GLYPH[name]} />
    </svg>
  )
}

/**
 * Modal that runs a GitHub device-flow step-up, then writes the terminal Origin through the gated endpoint.
 * Mirrors AccessRequired's poll loop, but authorizes a one-time token instead of a session, and saves on success.
 */
function TerminalOriginStepUp({ origin, onClose, onSaved }: { origin: string | null; onClose: () => void; onSaved: (settings: AppSettings) => void }) {
  const [flow, setFlow] = useState<{ flowId: string; userCode: string; verificationUri: string; verificationUriComplete?: string; interval: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Latest onSaved via ref: the parent passes an inline callback, and re-running the poll effect on every parent
  // render would drop an in-flight authorize/save result.
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved

  useEffect(() => {
    let stopped = false
    startGitHubDeviceLogin('stepup').then(
      (f) => {
        if (!stopped) setFlow(f)
      },
      (err) => {
        if (!stopped) setError(err instanceof Error ? err.message : String(err))
      },
    )
    return () => {
      stopped = true
    }
  }, [])

  useEffect(() => {
    if (!flow) return
    let stopped = false
    let timer: number
    const poll = async () => {
      try {
        const response = await pollGitHubStepUp(flow.flowId)
        if (stopped) return
        if (response.status === 'authorized') {
          const saved = await saveTerminalOrigin(origin, response.stepUpToken)
          if (stopped) return
          onSavedRef.current(saved.settings)
          return
        }
        timer = window.setTimeout(poll, response.interval * 1000)
      } catch (err) {
        if (stopped) return
        setError(err instanceof Error ? err.message : String(err))
      }
    }
    timer = window.setTimeout(poll, flow.interval * 1000)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [flow, origin])

  return (
    <div className="settings-stepup-backdrop" role="dialog" aria-modal="true" aria-label="Verify to change terminal origin">
      <div className="settings-stepup-card">
        <h3>Verify to change terminal origin</h3>
        <p className="muted">Changing the terminal access origin is a security-sensitive action. Approve it on GitHub as the signed-in user.</p>
        {flow ? (
          <div className="login-device-flow">
            <p className="muted">Open GitHub and enter the code:</p>
            <button type="button" className="login-code" onClick={() => void writeClipboard(flow.userCode)} title="Copy code">
              <span>{flow.userCode}</span>
            </button>
            <a className="login-primary" href={flow.verificationUriComplete ?? flow.verificationUri} target="_blank" rel="noreferrer">
              Open GitHub to authorize
            </a>
            <p className="muted login-waiting">
              <span className="login-spinner" aria-hidden="true" /> Waiting for authorization…
            </p>
          </div>
        ) : (
          <p className="muted">
            <span className="login-spinner" aria-hidden="true" /> Starting…
          </p>
        )}
        {error ? <div className="panel error">{error}</div> : null}
        <div className="settings-stepup-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

export function SettingsPanel({ settings, authSession, onLogout }: { settings: AppSettings; authSession: AuthSessionResponse | undefined; onLogout: () => Promise<void> }) {
  const queryClient = useQueryClient()
  const buildInfo = useQuery({ queryKey: ['build-info'], queryFn: fetchBuildInfo, retry: false })
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(settings.defaultPermissionMode)
  const [model, setModel] = useState<ModelSelection | DefaultTurnOption>(settings.defaultModel ?? DEFAULT_TURN_OPTION)
  const [effort, setEffort] = useState<EffortLevel | DefaultTurnOption>(settings.defaultEffort ?? DEFAULT_TURN_OPTION)
  const [publicBaseUrl, setPublicBaseUrl] = useState<string>(settings.publicBaseUrl ?? '')
  const [terminalOrigin, setTerminalOrigin] = useState<string>(settings.terminalOrigin ?? '')
  const [stepUpOrigin, setStepUpOrigin] = useState<string | null | undefined>(undefined)
  const [status, setStatus] = useState<ToastState | null>(null)
  const [saving, setSaving] = useState(false)
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [menuModelValue, setMenuModelValue] = useState<ModelSelection | null>(null)
  const [effortMenuPosition, setEffortMenuPosition] = useState<CSSProperties>()
  const [githubEditing, setGithubEditing] = useState(false)
  const [githubAllowedUsers, setGithubAllowedUsers] = useState('')
  const [githubError, setGithubError] = useState<string | null>(null)
  const permissionMenuRef = useRef<HTMLDivElement | null>(null)
  const modelMenuRef = useRef<HTMLDivElement | null>(null)
  const githubDialogRef = useRef<HTMLDialogElement | null>(null)
  const selectedPermission = PERMISSION_MODE_OPTIONS.find((option) => option.value === permissionMode)
  const catalogModels = settings.modelCatalog?.models ?? []
  const selectedModel = matchingCatalogModel(catalogModels, model, settings)
  const menuModel = menuModelValue == null ? undefined : catalogModels.find((item) => item.value === menuModelValue)
  const effortLevels = supportedEffortLevels(selectedModel)
  const triggerModelLabel = selectedModel?.displayName || selectedModel?.value || model

  useEffect(() => {
    setPermissionMode(settings.defaultPermissionMode)
    setModel(settings.defaultModel ?? DEFAULT_TURN_OPTION)
    setEffort(settings.defaultEffort ?? DEFAULT_TURN_OPTION)
  }, [settings.defaultPermissionMode, settings.defaultModel, settings.defaultEffort])

  useEffect(() => {
    if (!catalogModels.length) return
    if (!selectedModel) {
      setModel(DEFAULT_TURN_OPTION)
      setEffort('medium')
      return
    }
    if (!effortLevels.length) setEffort(DEFAULT_TURN_OPTION)
    else if (effort === DEFAULT_TURN_OPTION || !effortLevels.includes(effort)) setEffort(effortLevels.includes('medium') ? 'medium' : effortLevels[0]!)
  }, [catalogModels.length, selectedModel, effort, effortLevels])

  const catalogQuery = useQuery({
    queryKey: SETTINGS_MODEL_CATALOG_QUERY_KEY,
    queryFn: async () => {
      const response = await refreshModelCatalog(null)
      queryClient.setQueryData(['settings'], response)
      return response
    },
    enabled: modelMenuOpen,
    gcTime: 0,
    staleTime: 0,
    retry: false,
  })

  useEffect(() => {
    if (modelMenuOpen) return
    queryClient.removeQueries({ queryKey: SETTINGS_MODEL_CATALOG_QUERY_KEY, exact: true })
  }, [modelMenuOpen, queryClient])

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

  function chooseModel(option: ModelCatalogItem) {
    const nextEffort = option.supportsEffort && option.supportedEffortLevels?.includes('medium') ? 'medium' : DEFAULT_TURN_OPTION
    void saveModelDefault(option.value, nextEffort)
  }

  function chooseEffort(option: ModelCatalogItem, nextEffort: EffortLevel) {
    void saveModelDefault(option.value, nextEffort)
  }

  async function save(update: AppSettingsUpdate) {
    setSaving(true)
    setStatus(null)
    try {
      const response = await saveSettings(update)
      queryClient.setQueryData(['settings'], response)
      setStatus({ message: 'Saved', tone: 'success' })
    } catch (error) {
      setStatus({ message: error instanceof Error ? error.message : String(error), tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const githubConfigQuery = useQuery({ queryKey: ['github-config'], queryFn: fetchGitHubConfig, enabled: githubEditing, retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false })
  useEffect(() => {
    if (githubEditing && githubConfigQuery.data) {
      setGithubAllowedUsers(githubConfigQuery.data.allowedUsers)
    }
  }, [githubEditing, githubConfigQuery.data])

  useEffect(() => {
    const dialog = githubDialogRef.current
    if (!dialog) return
    if (githubEditing) {
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) dialog.close()
  }, [githubEditing])

  function closeGithubEditor() {
    // Esc / backdrop must not dismiss mid-save, or a failed save would report into an unmounted dialog.
    if (saving) return
    setGithubError(null)
    setGithubEditing(false)
  }

  async function saveGithub() {
    setSaving(true)
    setGithubError(null)
    try {
      await saveGitHubConfig({ allowedUsers: githubAllowedUsers.trim() })
      setGithubEditing(false)
      // When the allowed login changes the server revokes every session, so re-reading the shared auth
      // query drives the app back to the login gate; when it doesn't, the panel stays mounted and we must
      // clear `saving` ourselves or the whole Settings panel stays disabled.
      await queryClient.refetchQueries({ queryKey: ['auth-session'] })
    } catch (error) {
      setGithubError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  async function savePermissionDefault(nextPermissionMode: PermissionMode) {
    setPermissionMode(nextPermissionMode)
    setPermissionMenuOpen(false)
    await save({ defaultPermissionMode: nextPermissionMode })
  }

  async function saveTimeZone(timeZone: string) {
    await save({ timeZone })
  }

  async function saveModelDefault(nextModel: ModelSelection | DefaultTurnOption, nextEffort: EffortLevel | DefaultTurnOption) {
    setModel(nextModel)
    setEffort(nextEffort)
    setModelMenuOpen(false)
    await save({ defaultModel: nextModel, defaultEffort: nextEffort === DEFAULT_TURN_OPTION ? 'medium' : nextEffort })
  }

  async function saveUseOneMillionContext(useOneMillionContext: boolean) {
    await save({ useOneMillionContext })
  }

  async function saveAutoCompactPercent(value: string) {
    await save({ autoCompactPercent: value ? Number(value) : null })
  }

  async function saveShowDebugNav(showDebugNav: boolean) {
    await save({ showDebugNav })
  }

  async function savePublicBaseUrl(next: string) {
    const trimmed = next.trim()
    setPublicBaseUrl(trimmed)
    await save({ publicBaseUrl: trimmed || null })
  }

  return (
    <section className="detail-panel settings-panel" aria-label="Settings">
      <div className="settings-section">
        <h2>Settings</h2>
        <p className="muted">Tune how Cotta works so every session fits the way you work.</p>
      </div>

      <section className="settings-group">
        <h3 className="settings-group-title">General</h3>
        <form className="settings-row" onSubmit={(event) => event.preventDefault()}>
          <div className="settings-card-copy">
            <label htmlFor="settings-time-zone">Time zone</label>
            <p className="muted">Used for all dates and times across Cotta.</p>
          </div>
          <div className="settings-card-controls">
            <select id="settings-time-zone" className="settings-select" value={settings.timeZone} disabled={saving} onChange={(event) => void saveTimeZone(event.target.value)}>
              {TIME_ZONES.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </form>

        <form className="settings-row" onSubmit={(event) => event.preventDefault()}>
          <div className="settings-card-copy">
            <h3>Show Debug</h3>
            <p className="muted">Show the Debug entry in the app navigation.</p>
          </div>
          <div className="settings-card-controls">
            <button type="button" className="settings-switch" role="switch" aria-checked={settings.showDebugNav} disabled={saving} onClick={() => void saveShowDebugNav(!settings.showDebugNav)}>
              <span className="settings-switch-thumb" />
            </button>
          </div>
        </form>
      </section>

      <section className="settings-group">
        <h3 className="settings-group-title">Composer defaults</h3>

        <form className="settings-row" onSubmit={(event) => event.preventDefault()}>
          <div className="settings-card-copy">
            <h3>Default permission</h3>
            <p className="muted">Starting permission mode for new composer turns.</p>
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
                <PermissionShieldIcon name={permissionMode} />
                <span>{selectedPermission?.label ?? permissionMode}</span>
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
                      <span className="permission-mode-option-icon" aria-hidden="true">
                        <PermissionShieldIcon name={option.value} />
                      </span>
                      <span className="permission-mode-option-copy">
                        <span className="permission-mode-option-title">{option.label}</span>
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

        <form className="settings-row" onSubmit={(event) => event.preventDefault()}>
          <div className="settings-card-copy">
            <h3>Default model / effort</h3>
            <p className="muted">Model and effort new composer turns start with.</p>
          </div>
          <div className="settings-card-controls">
            <div className="model-effort-picker settings-picker" ref={modelMenuRef}>
              <button
                type="button"
                className="model-effort-trigger settings-model-trigger"
                aria-haspopup="menu"
                aria-expanded={modelMenuOpen}
                onClick={() => {
                  setMenuModelValue(null)
                  setModelMenuOpen((open) => !open)
                }}
              >
                <span className="model-effort-trigger-icon" aria-hidden="true">
                  <ModelIcon value={selectedModel?.value ?? model} />
                </span>
                <span className="model-effort-trigger-copy">
                  <span className="model-effort-trigger-model">{triggerModelLabel}</span>
                  {selectedModel?.supportsEffort && effort !== DEFAULT_TURN_OPTION ? <span className="model-effort-trigger-effort">{effortLabel(effort)}</span> : null}
                </span>
              </button>
              {modelMenuOpen ? (
                <div className="model-effort-menu settings-menu" role="menu" aria-label="Default model and effort">
                  {catalogQuery.isFetching ? <div className="model-effort-hint">Loading model catalog…</div> : null}
                  {!catalogQuery.isFetching && !catalogModels.length ? <div className="model-effort-hint">No models found.</div> : null}
                  <div className="model-effort-models" role="group" aria-label="Models">
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
                          onClick={(event) => (option.supportsEffort && option.supportedEffortLevels?.length ? showEffortMenu(option, event.currentTarget) : chooseModel(option))}
                        >
                          <span className="model-effort-option-icon" aria-hidden="true">
                            <ModelIcon value={option.value} />
                          </span>
                          <span className="model-effort-option-title">{option.displayName || option.value}</span>
                          {selected ? (
                            <span className="model-effort-option-check" aria-hidden="true">
                              ✓
                            </span>
                          ) : null}
                        </button>
                      )
                    })}
                  </div>
                  {menuModel?.supportsEffort && menuModel.supportedEffortLevels?.length ? (
                    <div className="model-effort-efforts" style={effortMenuPosition} role="group" aria-label={`${menuModel.displayName || menuModel.value} efforts`}>
                      {supportedEffortLevels(menuModel).map((level) => {
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
                            {selected ? (
                              <span className="model-effort-option-check" aria-hidden="true">
                                ✓
                              </span>
                            ) : null}
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

        <form className="settings-row" onSubmit={(event) => event.preventDefault()}>
          <div className="settings-card-copy">
            <h3>Use 1M context</h3>
            <p className="muted">Use million-token model variants when the catalog offers them.</p>
          </div>
          <div className="settings-card-controls">
            <button
              type="button"
              className="settings-switch"
              role="switch"
              aria-checked={settings.useOneMillionContext !== false}
              disabled={saving}
              onClick={() => void saveUseOneMillionContext(settings.useOneMillionContext === false)}
            >
              <span className="settings-switch-thumb" />
            </button>
          </div>
        </form>

        <form className="settings-row" onSubmit={(event) => event.preventDefault()}>
          <div className="settings-card-copy">
            <h3>Auto-compact percent</h3>
            <p className="muted">Compact the context when it reaches this percent full. Empty uses the SDK default.</p>
          </div>
          <div className="settings-card-controls">
            <select className="settings-select" value={settings.autoCompactPercent?.toString() ?? ''} disabled={saving} onChange={(event) => void saveAutoCompactPercent(event.target.value)}>
              <option value="">Default</option>
              {Array.from({ length: 41 }, (_, index) => 60 + index).map((percent) => (
                <option key={percent} value={percent}>
                  {percent}%
                </option>
              ))}
            </select>
          </div>
        </form>
      </section>

      <section className="settings-group">
        <h3 className="settings-group-title">Sharing</h3>
        <form className="settings-row settings-row-stacked" onSubmit={(event) => event.preventDefault()}>
          <div className="settings-card-copy">
            <h3>Public base URL</h3>
            <p className="muted">Origin used to build Lark Detail links. Leave empty to hide the Detail button on Lark cards.</p>
          </div>
          <div className="settings-origins">
            <div className="settings-origin-row">
              <input
                type="text"
                className="settings-text-input"
                placeholder="https://cotta.example.com"
                value={publicBaseUrl}
                disabled={saving}
                onChange={(event) => setPublicBaseUrl(event.target.value)}
                onBlur={() => void savePublicBaseUrl(publicBaseUrl)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                }}
              />
            </div>
            <button type="button" className="settings-origin-add" disabled={saving} onClick={() => void savePublicBaseUrl(window.location.origin)}>
              Use current origin
            </button>
          </div>
        </form>
      </section>

      <section className="settings-group">
        <h3 className="settings-group-title">Terminal</h3>
        <form className="settings-row settings-row-stacked" onSubmit={(event) => event.preventDefault()}>
          <div className="settings-card-copy">
            <h3>Access origin</h3>
            <p className="muted">
              {settings.terminalOrigin
                ? `Override: ${settings.terminalOrigin}`
                : 'Using loopback only. Set an origin to allow the terminal from a non-loopback deployment.'}
            </p>
            <p className="muted">Changing this is security-sensitive and requires GitHub verification before it saves.</p>
          </div>
          <div className="settings-origins">
            <div className="settings-origin-row">
              <input
                type="text"
                className="settings-text-input"
                placeholder="https://cotta.example.com"
                value={terminalOrigin}
                disabled={saving || stepUpOrigin !== undefined}
                onChange={(event) => setTerminalOrigin(event.target.value)}
              />
            </div>
            <button
              type="button"
              className="settings-origin-add"
              disabled={saving || stepUpOrigin !== undefined}
              onClick={() => {
                const origin = terminalOrigin.trim() || null
                // Validate before the GitHub round-trip so a typo doesn't cost a full approval.
                if (!terminalOriginUpdateRequestSchema.shape.origin.safeParse(origin).success) {
                  setStatus({ message: 'Invalid origin: use scheme, host and optional port only, e.g. https://cotta.example.com', tone: 'error' })
                  return
                }
                setStepUpOrigin(origin)
              }}
            >
              Verify & save
            </button>
          </div>
        </form>
      </section>

      {authSession?.authenticated && authSession.user ? (
        <section className="settings-group" aria-labelledby="settings-account-heading">
          <h3 className="settings-group-title" id="settings-account-heading">
            Account
          </h3>
          <div className="settings-row settings-account">
            <div className="settings-account-profile">
              <span className="settings-account-avatar" aria-hidden="true">
                {authSession.user.avatarUrl ? (
                  <img src={authSession.user.avatarUrl} alt="" />
                ) : (
                  <svg viewBox="0 0 20 20">
                    <circle cx="10" cy="7" r="3" />
                    <path d="M4.5 17a5.5 5.5 0 0 1 11 0" />
                  </svg>
                )}
              </span>
              <div className="settings-card-copy settings-account-copy">
                <strong>{authSession.user.name || authSession.user.login}</strong>
                {authSession.user.name ? <span className="muted">@{authSession.user.login}</span> : null}
              </div>
            </div>
            <div className="settings-card-controls settings-account-actions">
              <button
                type="button"
                className="settings-logout settings-secondary"
                onClick={() => {
                  setGithubError(null)
                  setGithubEditing((open) => !open)
                }}
              >
                Change account
              </button>
              <button type="button" className="settings-logout" onClick={() => void onLogout()}>
                Logout
              </button>
            </div>
          </div>
          {githubEditing ? (
            <dialog
              ref={githubDialogRef}
              className="settings-github-dialog"
              aria-labelledby="settings-github-title"
              onCancel={(event) => {
                event.preventDefault()
                closeGithubEditor()
              }}
              onClick={(event) => {
                if (event.target === event.currentTarget) closeGithubEditor()
              }}
            >
              <div className="settings-github-shell">
                <div className="settings-card-copy">
                  <h3 id="settings-github-title">Change account</h3>
                  <p className="muted">
                    Sign in is restricted to one GitHub user. Enter the username allowed to sign in. Changing the allowed user signs out every session on all devices — sign in again as that user.
                  </p>
                </div>
                <label className="settings-github-field">
                  Allowed user
                  <input
                    className="settings-text-input"
                    placeholder="GitHub username, e.g. octocat"
                    value={githubAllowedUsers}
                    disabled={saving || githubConfigQuery.isFetching}
                    onChange={(event) => setGithubAllowedUsers(event.target.value)}
                  />
                </label>
                {githubConfigQuery.isError ? <p className="error-text">Failed to load current config.</p> : null}
                {githubError ? <p className="error-text">{githubError}</p> : null}
                {githubAllowedUsers.trim() && !isSingleUser(githubAllowedUsers) ? <p className="error-text">Enter exactly one GitHub username (no spaces or commas).</p> : null}
                <div className="settings-github-actions">
                  <button type="button" className="settings-logout settings-secondary" disabled={saving} onClick={closeGithubEditor}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="settings-primary-action"
                    disabled={saving || githubConfigQuery.isFetching || githubConfigQuery.isError || !isSingleUser(githubAllowedUsers)}
                    onClick={() => void saveGithub()}
                  >
                    Save
                  </button>
                </div>
              </div>
            </dialog>
          ) : null}
        </section>
      ) : null}

      {status ? (
        <div className={`settings-toast settings-toast-${status.tone}`} role="status">
          {status.message}
        </div>
      ) : null}

      {buildInfo.data ? (
        <footer className="settings-build-info">
          <span>
            Cotta version {buildInfo.data.version}
            {buildInfo.data.commit ? (
              <>
                {' (commit '}
                <code>{buildInfo.data.commit}</code>)
              </>
            ) : null}
          </span>
          {buildInfo.data.agentSdkVersion ? <span>Claude Agent SDK version {buildInfo.data.agentSdkVersion}</span> : null}
          <span>Uptime {formatUptime(buildInfo.data.uptimeSeconds)}</span>
        </footer>
      ) : null}

      {stepUpOrigin !== undefined ? (
        <TerminalOriginStepUp
          origin={stepUpOrigin}
          onClose={() => setStepUpOrigin(undefined)}
          onSaved={(saved) => {
            queryClient.setQueryData(['settings'], { settings: saved })
            setTerminalOrigin(saved.terminalOrigin ?? '')
            setStepUpOrigin(undefined)
            setStatus({ message: 'Saved', tone: 'success' })
          }}
        />
      ) : null}
    </section>
  )
}
