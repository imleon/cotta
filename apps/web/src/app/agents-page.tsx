import type { RemoteBot } from '@cotta/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { bindRemoteBot, createRemoteBot, deleteRemoteBot, fetchProjects, fetchRemoteBots, resolveRemoteBot, unpairRemoteBot, updateRemoteBot } from '../api'

type ToastState = { message: string; tone: 'success' | 'error' }
type BotDraft = Pick<RemoteBot, 'platform' | 'appId' | 'allProjects' | 'projectIds' | 'enabled'> & { appSecret: string }

const EMPTY_DRAFT: BotDraft = { platform: 'feishu', appId: '', appSecret: '', allProjects: true, projectIds: [], enabled: true }
const CONNECTION_STATUS_LABELS: Record<RemoteBot['connectionStatus'], string> = {
  disabled: 'Disabled',
  unpaired: 'Unpaired',
  connecting: 'Connecting',
  connected: 'Connected',
  error: 'Connection error',
}

function draftFromBot(bot: RemoteBot): BotDraft {
  return { platform: bot.platform, appId: bot.appId, appSecret: '', allProjects: bot.allProjects, projectIds: bot.projectIds, enabled: bot.enabled }
}

async function fetchAllProjects() {
  const projects = []
  let cursor: string | null = null
  do {
    const page = await fetchProjects(cursor, 100)
    projects.push(...page.projects)
    cursor = page.hasMore ? page.nextCursor : null
  } while (cursor)
  return projects
}

export function AgentsPage({ setStatus }: { setStatus: (status: ToastState) => void }) {
  const queryClient = useQueryClient()
  const bots = useQuery({ queryKey: ['remote-bots'], queryFn: fetchRemoteBots, retry: false, refetchInterval: 10_000 })
  const projects = useQuery({ queryKey: ['projects', 'remote-bots'], queryFn: fetchAllProjects, retry: false })
  const [selectedBotId, setSelectedBotId] = useState<string | null | undefined>(undefined)
  const [draft, setDraft] = useState<BotDraft>(EMPTY_DRAFT)
  const [chatId, setChatId] = useState('')
  const [preview, setPreview] = useState<{ name: string; avatarUrl: string | null } | null>(null)
  const [saving, setSaving] = useState(false)
  const selectedBot = bots.data?.bots.find((bot) => bot.botId === selectedBotId)

  useEffect(() => {
    if (!bots.data) return
    if (selectedBotId === undefined || (selectedBotId !== null && !bots.data.bots.some((bot) => bot.botId === selectedBotId))) {
      const next = bots.data.bots[0]
      setSelectedBotId(next?.botId ?? null)
      setDraft(next ? draftFromBot(next) : EMPTY_DRAFT)
      setChatId('')
      setPreview(null)
    }
  }, [bots.data, selectedBotId])

  function selectBot(bot: RemoteBot) {
    setSelectedBotId(bot.botId)
    setDraft(draftFromBot(bot))
    setChatId('')
    setPreview(null)
  }

  function createNew() {
    setSelectedBotId(null)
    setDraft(EMPTY_DRAFT)
    setChatId('')
    setPreview(null)
  }

  function patch(update: Partial<BotDraft>) {
    setDraft((current) => ({ ...current, ...update }))
  }

  async function run(action: () => Promise<void>, message: string) {
    try {
      setSaving(true)
      await action()
      setStatus({ message, tone: 'success' })
    } catch (error) {
      setStatus({ message: error instanceof Error ? error.message : String(error), tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  async function save() {
    if (projects.isError) {
      setStatus({ message: 'Projects must load before saving.', tone: 'error' })
      return
    }
    if (!draft.appId.trim() || (!draft.allProjects && draft.projectIds.length === 0) || (!selectedBotId && !draft.appSecret.trim())) {
      setStatus({ message: 'App ID, project access, and Secret are required for new bots.', tone: 'error' })
      return
    }
    await run(async () => {
      const response = selectedBotId ? await updateRemoteBot(selectedBotId, { ...draft }) : await createRemoteBot({ ...draft })
      await queryClient.invalidateQueries({ queryKey: ['remote-bots'] })
      setSelectedBotId(response.bot.botId)
      setDraft(draftFromBot(response.bot))
      setChatId('')
      setPreview(null)
    }, 'Bot saved')
  }

  async function remove() {
    if (!selectedBotId || !window.confirm('Delete this bot? Existing cards will stop working.')) return
    const deletedId = selectedBotId
    await run(async () => {
      await deleteRemoteBot(deletedId)
      const next = bots.data?.bots.find((bot) => bot.botId !== deletedId)
      setSelectedBotId(next?.botId ?? null)
      setDraft(next ? draftFromBot(next) : EMPTY_DRAFT)
      setChatId('')
      setPreview(null)
      await queryClient.invalidateQueries({ queryKey: ['remote-bots'] })
    }, 'Bot deleted')
  }

  async function resolve() {
    if (!selectedBotId || !chatId.trim() || preview) return
    const botId = selectedBotId
    try {
      setPreview(await resolveRemoteBot(botId, chatId.trim()))
    } catch (error) {
      setStatus({ message: error instanceof Error ? error.message : String(error), tone: 'error' })
    }
  }

  async function bind() {
    if (!selectedBotId || !chatId.trim()) return
    const botId = selectedBotId
    await run(async () => {
      const response = await bindRemoteBot(botId, chatId.trim())
      await queryClient.invalidateQueries({ queryKey: ['remote-bots'] })
      setDraft(draftFromBot(response.bot))
      setChatId('')
      setPreview(null)
    }, 'Bot bound')
  }

  async function unpair() {
    if (!selectedBotId) return
    await run(async () => {
      await unpairRemoteBot(selectedBotId)
      setChatId('')
      setPreview(null)
      await queryClient.invalidateQueries({ queryKey: ['remote-bots'] })
    }, 'Bot unpaired')
  }

  return (
    <section className="detail-panel agents-page" aria-labelledby="agents-page-title">
      <div className="settings-section">
        <h2 id="agents-page-title">Agents</h2>
        <p className="muted">Drive your projects from Feishu or Lark — no need to be at your desk.</p>
      </div>

      <div className="agents-body">
        <aside className="agents-list-pane" aria-labelledby="agents-list-title">
          <div className="agents-pane-heading">
            <span id="agents-list-title">Configured bots</span>
            <span>{bots.data?.bots.length ?? 0}</span>
          </div>
          <div className="agents-list">
            {bots.isLoading ? (
              <div className="agents-list-skeleton" aria-label="Loading agents">
                <span />
                <span />
                <span />
              </div>
            ) : null}
            {bots.isError ? <p className="rail-empty error-text">Failed to load agents</p> : null}
            {bots.data?.bots.length === 0 ? <p className="rail-empty">No bots configured</p> : null}
            {bots.data?.bots.map((bot) => (
              <button
                key={bot.botId}
                type="button"
                className={`agents-list-item ${selectedBotId === bot.botId ? 'selected' : ''}`}
                onClick={() => selectBot(bot)}
                aria-current={selectedBotId === bot.botId ? 'true' : undefined}
              >
                <span className="agents-list-item-main">
                  <strong>{bot.appId}</strong>
                  <span>{bot.platform === 'feishu' ? 'Feishu' : 'Lark'}</span>
                </span>
                <span className={`agents-status agents-status-${bot.connectionStatus}`}>{CONNECTION_STATUS_LABELS[bot.connectionStatus]}</span>
              </button>
            ))}
          </div>
          <button type="button" className="settings-primary-action agents-add-bot" onClick={createNew}>
            Add bot
          </button>
        </aside>

        <div className="agents-editor-pane">
          <div className="agents-editor-content">
            <div className="agents-editor-heading">
              <div>
                <span className="agents-eyebrow">{selectedBot ? (selectedBot.platform === 'feishu' ? 'Feishu bot' : 'Lark bot') : 'New bot'}</span>
                <h2>{selectedBotId ? selectedBot?.appId || 'Bot configuration' : 'Create bot'}</h2>
              </div>
              {selectedBot ? <span className={`agents-status agents-status-${selectedBot.connectionStatus}`}>{CONNECTION_STATUS_LABELS[selectedBot.connectionStatus]}</span> : null}
            </div>

            {bots.isError ? (
              <div className="agents-callout agents-callout-warning" role="alert">
                <strong>Agents failed to load.</strong>
                <button type="button" onClick={() => void bots.refetch()}>
                  Retry
                </button>
              </div>
            ) : selectedBotId === undefined ? (
              <div className="agents-editor-loading" aria-label="Loading bot configuration">
                <span />
                <span />
              </div>
            ) : (
              <form
                className="agents-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void save()
                }}
              >
                <section className="settings-card agents-card">
                  <div className="agents-card-heading">
                    <h3>Configuration</h3>
                    <p>Choose the platform, credentials, and projects this bot can read.</p>
                  </div>
                  <div className="agents-fields">
                    <label>
                      Platform
                      <select value={draft.platform} onChange={(event) => patch({ platform: event.target.value as BotDraft['platform'] })}>
                        <option value="feishu">Feishu</option>
                        <option value="lark">Lark</option>
                      </select>
                    </label>
                    <label>
                      App ID
                      <input required value={draft.appId} onChange={(event) => patch({ appId: event.target.value })} />
                    </label>
                    <label className="agents-field-wide">
                      App Secret
                      <input
                        type="password"
                        required={!selectedBotId}
                        placeholder={selectedBotId ? 'Leave blank to keep the current secret' : ''}
                        value={draft.appSecret}
                        onChange={(event) => patch({ appSecret: event.target.value })}
                      />
                    </label>
                    <fieldset className="agents-project-access">
                      <legend>Project access</legend>
                      <label>
                        <input type="radio" name="project-access" checked={draft.allProjects} onChange={() => patch({ allProjects: true, projectIds: [] })} />
                        All projects including future
                      </label>
                      <label>
                        <input type="radio" name="project-access" checked={!draft.allProjects} onChange={() => patch({ allProjects: false })} />
                        Selected projects
                      </label>
                      {!draft.allProjects ? (
                        <div className="agents-project-list">
                          {projects.data?.map((project) => (
                            <label key={project.id}>
                              <input
                                type="checkbox"
                                checked={draft.projectIds.includes(project.id)}
                                onChange={(event) => patch({ projectIds: event.target.checked ? [...draft.projectIds, project.id] : draft.projectIds.filter((id) => id !== project.id) })}
                              />
                              {project.name}
                            </label>
                          ))}
                        </div>
                      ) : null}
                      {projects.isLoading ? <small>Loading projects…</small> : null}
                      {projects.isError ? (
                        <small className="error-text">
                          Projects failed to load.{' '}
                          <button type="button" onClick={() => void projects.refetch()}>
                            Retry
                          </button>
                        </small>
                      ) : null}
                    </fieldset>
                  </div>
                  <p className="agents-card-note">
                    App Secrets are stored in plaintext in the local Cotta database and protected by host, file, and backup access controls. Session titles and Timeline content sent by a bot are
                    retained by Feishu or Lark.
                  </p>
                  <div className="agents-card-footer">
                    <label className="agents-enabled-control">
                      <span>
                        <strong>Enabled</strong>
                        <small>Keep the bot connected and available.</small>
                      </span>
                      <button type="button" className="settings-switch" role="switch" aria-label="Enabled" aria-checked={draft.enabled} onClick={() => patch({ enabled: !draft.enabled })}>
                        <span className="settings-switch-thumb" />
                      </button>
                    </label>
                    <button type="submit" className="settings-primary-action" disabled={saving || projects.isError}>
                      Save changes
                    </button>
                  </div>
                </section>

                <section className="settings-card agents-card agents-connection-card">
                  <div className="agents-card-heading">
                    <h3>Connection & pairing</h3>
                    <p>{selectedBotId ? 'Bind one private chat to access the configured projects.' : 'Save the bot before binding a chat.'}</p>
                  </div>
                  {selectedBot?.paired ? (
                    <div className="agents-bound-user" role="status">
                      {selectedBot.pairedUserAvatarUrl ? <img src={selectedBot.pairedUserAvatarUrl} alt="" width={40} height={40} /> : <span className="agents-bound-avatar-fallback" />}
                      <div>
                        <strong>{selectedBot.pairedUserName ?? 'Bound'}</strong>
                        <small>Bound to this chat</small>
                      </div>
                      <button type="button" disabled={saving} onClick={() => void unpair()}>
                        Unpair chat
                      </button>
                    </div>
                  ) : selectedBotId && selectedBot?.enabled ? (
                    <div className="agents-bind-form">
                      <label>
                        Chat ID
                        <input
                          placeholder="oc_..."
                          value={chatId}
                          onChange={(event) => {
                            setChatId(event.target.value)
                            setPreview(null)
                          }}
                          onBlur={() => void resolve()}
                        />
                      </label>
                      {preview ? (
                        <div className="agents-bound-user" role="status">
                          {preview.avatarUrl ? <img src={preview.avatarUrl} alt="" width={40} height={40} /> : <span className="agents-bound-avatar-fallback" />}
                          <div>
                            <strong>{preview.name}</strong>
                            <small>Confirm to bind this chat</small>
                          </div>
                          <button type="button" className="settings-primary-action" disabled={saving} onClick={() => void bind()}>
                            Confirm bind
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="agents-callout agents-callout-info">
                    In the Feishu or Lark developer console, create an event menu and set its event ID to <code>LIST_SESSIONS</code>.
                  </div>
                </section>

                {selectedBotId ? (
                  <section className="settings-card agents-card agents-danger-zone">
                    <div>
                      <strong>Delete bot</strong>
                      <span>Remove this connection and invalidate its existing cards.</span>
                    </div>
                    <button type="button" disabled={saving} onClick={() => void remove()}>
                      Delete
                    </button>
                  </section>
                ) : null}
              </form>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
