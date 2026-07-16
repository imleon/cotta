import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createTurnResponseSchema,
  sessionRawMessagesResponseSchema,
  type CreateTurnResponse,
  type ProjectSessionsResponse,
  type SessionRawMessagesResponse,
} from '@cotta/shared'
import { authToken, withToken } from './api'
import { ProjectSessionRail, useProjectSessionSelection } from './session-history'
import { refreshProjectSessionLists } from './session-query-refresh'
import { SessionTimeline } from './timeline'
import './styles.css'

async function fetchSessionRawMessages(projectId: string, sessionId: string): Promise<SessionRawMessagesResponse> {
  const response = await fetch(
    withToken(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/raw-messages`),
  )
  if (!response.ok) throw new Error(`Session raw messages request failed: ${response.status}`)
  return sessionRawMessagesResponseSchema.parse(await response.json())
}

async function createTurn(projectId: string, sessionId: string | null, text: string): Promise<CreateTurnResponse> {
  const path = sessionId
    ? `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/turns`
    : `/api/projects/${encodeURIComponent(projectId)}/sessions`
  const response = await fetch(withToken(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!response.ok) throw new Error(`Create turn failed: ${response.status}`)
  return createTurnResponseSchema.parse(await response.json())
}

async function interruptTurn(projectId: string, sessionId: string, turnId: string): Promise<void> {
  const response = await fetch(
    withToken(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/interrupt`),
    { method: 'POST' },
  )
  if (!response.ok) throw new Error(`Interrupt failed: ${response.status}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function dataPreview(value: unknown, space = 2): string {
  if (typeof value === 'object' && value !== null && 'text' in value && typeof value.text === 'string') return value.text
  return JSON.stringify(value, null, space) ?? ''
}

function textFromData(value: unknown): string | null {
  if (isRecord(value) && typeof value.text === 'string') return value.text
  if (isRecord(value) && isRecord(value.raw) && typeof value.raw.content === 'string') return value.raw.content
  if (isRecord(value) && typeof value.content === 'string') return value.content
  if (isRecord(value) && Array.isArray(value.content)) {
    const text = value.content
      .map((block) => isRecord(block) && typeof block.text === 'string' ? block.text : '')
      .filter(Boolean)
      .join('\n')
    return text || null
  }
  return null
}

function shortText(value: string, max = 140): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return '—'
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized
}

function debugDataPreview(value: unknown, max = 180): string {
  return shortText(textFromData(value) ?? dataPreview(value), max)
}

function rawField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

function rawStringField(value: unknown, key: string): string {
  const field = rawField(value, key)
  return typeof field === 'string' ? field : '—'
}

function rawMessagePreview(value: unknown): string {
  return debugDataPreview(rawField(value, 'message') ?? value)
}

function rawMessageField(value: unknown, key: string): unknown {
  const message = rawField(value, 'message')
  return isRecord(message) ? message[key] : undefined
}

function debugFieldPreview(value: unknown, max = 180): string {
  if (value === undefined || value === null) return '—'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return shortText(String(value), max)
  return debugDataPreview(value, max)
}

function rawTimestampParts(value: unknown): { date: string; time: string } {
  const timestamp = rawStringField(value, 'timestamp')
  if (timestamp === '—') return { date: '—', time: '—' }
  const [date, timeWithZone] = timestamp.split('T')
  return { date: date || timestamp, time: timeWithZone ?? '—' }
}

function rawStopReason(value: unknown): string | null {
  const stopReason = rawMessageField(value, 'stop_reason')
  return typeof stopReason === 'string' && stopReason ? stopReason : null
}

function containsToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === 'tool_result')
}

function hasUserTextContent(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0)
}

function isPrimaryUserMessage(value: unknown): boolean {
  const message = rawField(value, 'message')
  const content = isRecord(message) ? message.content : undefined
  return rawStringField(value, 'type') === 'user'
    && isRecord(message)
    && message.role === 'user'
    && !containsToolResult(content)
    && hasUserTextContent(content)
}

function sourceEventLabel(ids: string[]): string {
  if (ids.length === 0) return '—'
  if (ids.length <= 2) return ids.join(', ')
  return `${ids.slice(0, 2).join(', ')} +${ids.length - 2}`
}

function debugContentClassName(type: string | undefined): string {
  if (type === 'text') return 'debug-content-block-text'
  if (type === 'tool_use') return 'debug-content-block-tool-use'
  if (type === 'tool_result') return 'debug-content-block-tool-result'
  return 'debug-content-block-unknown'
}

function DebugContentField({ label, value, json = false, max = 260 }: { label: string; value: unknown; json?: boolean; max?: number }) {
  if (value === undefined || value === null) return null
  return (
    <div className="debug-content-field">
      <span className="debug-content-label">{label}</span>
      <div className="debug-content-value">
        {json ? <pre className="debug-content-pre">{dataPreview(value)}</pre> : debugFieldPreview(value, max)}
      </div>
    </div>
  )
}

function DebugContentBlock({ block, index }: { block: unknown; index: number }) {
  if (!isRecord(block)) {
    return (
      <div className="debug-content-block debug-content-block-unknown">
        <div className="debug-content-block-header">#{index + 1} value</div>
        <DebugContentField label="value" value={block} />
      </div>
    )
  }

  const type = typeof block.type === 'string' ? block.type : undefined
  const isJsonContent = isRecord(block.content) || Array.isArray(block.content)
  return (
    <div className={`debug-content-block ${debugContentClassName(type)}`}>
      <div className="debug-content-block-header">#{index + 1} {type ?? 'unknown'}</div>
      {type === 'text' ? <DebugContentField label="text" value={block.text} max={520} /> : null}
      {type === 'tool_use' ? (
        <>
          <DebugContentField label="id" value={block.id} />
          <DebugContentField label="name" value={block.name} />
          <DebugContentField label="input" value={block.input} json />
        </>
      ) : null}
      {type === 'tool_result' ? (
        <>
          <DebugContentField label="tool_use_id" value={block.tool_use_id} />
          <DebugContentField label="is_error" value={block.is_error} />
          <DebugContentField label="content" value={block.content} json={isJsonContent} max={520} />
        </>
      ) : null}
      {!type || (type !== 'text' && type !== 'tool_use' && type !== 'tool_result') ? <DebugContentField label="data" value={block} json /> : null}
    </div>
  )
}

function debugContentRows(content: unknown): unknown[] {
  if (Array.isArray(content)) return content.length > 0 ? content : [undefined]
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (content === undefined || content === null) return [undefined]
  return [content]
}

function contentBlockType(block: unknown): string {
  if (block === undefined || block === null) return '—'
  if (!isRecord(block)) return 'value'
  return typeof block.type === 'string' ? block.type : 'unknown'
}

function contentBlockId(block: unknown): unknown {
  if (!isRecord(block)) return undefined
  return block.id ?? block.tool_use_id
}

function contentBlockName(block: unknown): unknown {
  return isRecord(block) ? block.name : undefined
}

function contentBlockIsErr(block: unknown): unknown {
  if (!isRecord(block)) return undefined
  return block.is_err ?? block.is_error
}

const contentBlockMetadataKeys = new Set(['type', 'id', 'tool_use_id', 'name', 'is_err', 'is_error'])

function contentBlockValue(block: unknown): unknown {
  if (!isRecord(block)) return block
  const entries = Object.entries(block).filter(([key]) => !contentBlockMetadataKeys.has(key))
  if (entries.length === 0) return undefined
  if (entries.length === 1) return entries[0]?.[1]
  return Object.fromEntries(entries)
}

function shouldRenderBlockValueMarkdown(block: unknown, value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (!isRecord(block)) return false
  return (block.type === 'text' && typeof block.text === 'string')
    || (block.type === 'tool_result' && typeof block.content === 'string')
}

function DebugMarkdownValue({ value }: { value: string }) {
  return (
    <div className="debug-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
    </div>
  )
}

function DebugContentCellValue({ value, json = false, max = 260, markdown = false }: { value: unknown; json?: boolean; max?: number; markdown?: boolean }) {
  if (value === undefined || value === null) return <span className="debug-content-empty">—</span>
  if (json || isRecord(value) || Array.isArray(value)) return <pre className="debug-content-code">{dataPreview(value)}</pre>
  if (markdown && typeof value === 'string') return <DebugMarkdownValue value={value} />
  return <>{debugFieldPreview(value, max)}</>
}

function DebugContentStackCell({ blocks, valueForBlock, max = 260, markdownForBlock }: { blocks: unknown[]; valueForBlock: (block: unknown) => unknown; max?: number; markdownForBlock?: (block: unknown, value: unknown) => boolean }) {
  return (
    <div className="debug-content-stack">
      {blocks.map((block, index) => {
        const value = valueForBlock(block)
        return (
          <div key={index}>
            <DebugContentCellValue value={value} max={max} markdown={markdownForBlock?.(block, value) ?? false} />
            {index < blocks.length - 1 ? <div className="debug-content-separator">---</div> : null}
          </div>
        )
      })}
    </div>
  )
}

function SessionDebugView({ rawMessages }: { rawMessages: unknown[] }) {
  return (
    <section className="debug-view" aria-label="Session debug">
      <section className="debug-table-section" aria-label="Raw messages">
        {rawMessages.length === 0 ? <p className="debug-empty">No raw messages loaded.</p> : (
          <div className="debug-table-wrap">
            <table className="debug-table">
              <thead><tr><th>Timestamp</th><th>Type</th><th>block.type</th><th>block.id</th><th>block.name</th><th>block.is_err</th><th>block.value</th><th>raw message</th><th>message.model</th><th>message.usage</th></tr></thead>
              <tbody>
                {rawMessages.map((message, index) => {
                  const timestamp = rawTimestampParts(message)
                  const stopReason = rawStopReason(message)
                  const contentRows = debugContentRows(rawMessageField(message, 'content'))
                  const rowClassName = isPrimaryUserMessage(message) ? 'debug-row-user' : undefined
                  return (
                    <tr className={rowClassName} key={`${rawStringField(message, 'uuid')}:${index}`}>
                      <td className="debug-mono debug-timestamp-cell"><div>{timestamp.date}</div><div className="debug-muted">{timestamp.time}</div></td>
                      <td className="debug-type-cell"><strong>{rawStringField(message, 'type')}</strong>{stopReason ? <div className="debug-muted">(stop_reason: {stopReason})</div> : null}</td>
                      <td><DebugContentStackCell blocks={contentRows} valueForBlock={contentBlockType} /></td>
                      <td className="debug-mono debug-block-id-cell"><DebugContentStackCell blocks={contentRows} valueForBlock={contentBlockId} /></td>
                      <td><DebugContentStackCell blocks={contentRows} valueForBlock={contentBlockName} /></td>
                      <td><DebugContentStackCell blocks={contentRows} valueForBlock={contentBlockIsErr} /></td>
                      <td className="debug-content-cell"><DebugContentStackCell blocks={contentRows} valueForBlock={contentBlockValue} markdownForBlock={shouldRenderBlockValueMarkdown} max={520} /></td>
                      <td className="debug-content-cell debug-raw-message-cell"><DebugContentCellValue value={message} json /></td>
                      <td>{debugFieldPreview(rawMessageField(message, 'model'))}</td>
                      <td className="debug-usage-cell"><pre className="debug-inline-json">{dataPreview(rawMessageField(message, 'usage'), 0)}</pre></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  )
}

function useSessionRawMessages(projectId: string | null, sessionId: string | null) {
  return useQuery({
    queryKey: ['session-raw-messages', projectId, sessionId],
    queryFn: () => fetchSessionRawMessages(projectId!, sessionId!),
    enabled: Boolean(projectId && sessionId),
    retry: false,
  })
}

function WorkspacePanel({
  projectId,
  detail,
  selectedSessionId,
  setSelectedSessionId,
}: {
  projectId: string | null
  detail: ProjectSessionsResponse | undefined
  selectedSessionId: string | null
  setSelectedSessionId: (sessionId: string | null) => void
}) {
  const queryClient = useQueryClient()
  const [inputText, setInputText] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [interrupting, setInterrupting] = useState(false)
  const [liveTurnId, setLiveTurnId] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => { setLiveTurnId(null); setSubmitError(null); setInterrupting(false) }, [projectId, selectedSessionId])
  useEffect(() => { if (!liveTurnId) setInterrupting(false) }, [liveTurnId])
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 112)}px`
  }, [inputText])

  if (!projectId) return <div className="panel muted">Select a project to view its timeline.</div>
  if (!detail) return <div className="panel muted">Loading project sessions…</div>

  async function submitTurn() {
    if (!projectId || !inputText.trim()) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const response = await createTurn(projectId, selectedSessionId, inputText)
      setSelectedSessionId(response.sessionId)
      setLiveTurnId(response.turnId)
      setInputText('')
      refreshProjectSessionLists(queryClient, projectId)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  function refreshSessionListsForCurrentProject() {
    if (!projectId) return
    refreshProjectSessionLists(queryClient, projectId)
  }

  async function stopLiveTurn() {
    if (!projectId || !selectedSessionId || !liveTurnId || interrupting) return
    setInterrupting(true)
    setSubmitError(null)
    try {
      await interruptTurn(projectId, selectedSessionId, liveTurnId)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error))
      setInterrupting(false)
    }
  }

  const actionMode = submitting || interrupting ? 'loading' : liveTurnId ? 'stop' : 'submit'
  const selectedSession = detail.sessions.find((session) => session.id === selectedSessionId)

  return (
    <section className="workspace-panel">
      <section className="detail-panel workspace-main-panel">
        <header className="detail-header">
          <div className="project-title-block">
            <div className="project-session-title">
              <h2>{detail.project.name}</h2>
              {selectedSession ? <span>{selectedSession.title}</span> : null}
            </div>
          </div>
          <div className="project-meta-lines">
            {selectedSessionId ? <span className="project-meta-icon" data-tooltip={`Session ID: ${selectedSessionId}`} aria-label={`Session ID: ${selectedSessionId}`}>#</span> : null}
            {detail.project.path ? <span className="project-meta-icon project-path-icon" data-tooltip={`Project directory: ${detail.project.path}`} aria-label={`Project directory: ${detail.project.path}`}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5h5l1.5 2h6.5v5.5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 1.5 12Z" /></svg>
            </span> : null}
          </div>
        </header>

        <div className="workspace-timeline">
          {selectedSessionId ? <SessionTimeline projectId={projectId} sessionId={selectedSessionId} onLiveTurnChange={setLiveTurnId} onSessionListStale={refreshSessionListsForCurrentProject} /> : <div className="panel muted">Start a new session from the composer below.</div>}
        </div>

        <section className="composer-card composer-card-bottom">
          <form className="turn-form" onSubmit={(event) => { event.preventDefault(); void submitTurn() }}>
            <div className="turn-composer">
              <textarea
                ref={inputRef}
                value={inputText}
                onChange={(event) => setInputText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.shiftKey || submitting || !inputText.trim()) return
                  event.preventDefault()
                  void submitTurn()
                }}
                placeholder={selectedSessionId ? 'Continue the selected session…' : 'Start a new session in this project…'}
                rows={1}
              />
              <div className="turn-composer-footer">
                <button
                  type={actionMode === 'submit' ? 'submit' : 'button'}
                  className="turn-action-button"
                  onClick={actionMode === 'stop' ? stopLiveTurn : undefined}
                  disabled={actionMode === 'loading' || (actionMode === 'submit' && !inputText.trim())}
                  aria-label={actionMode === 'loading' ? 'Submitting' : actionMode === 'stop' ? 'Stop generation' : 'Submit'}
                >
                  {actionMode === 'loading' ? <span className="turn-spinner" aria-hidden="true" /> : actionMode === 'stop' ? <span className="turn-stop-icon" aria-hidden="true" /> : '↑'}
                </button>
              </div>
            </div>
            {submitError ? <div className="panel error">{submitError}</div> : null}
          </form>
        </section>
      </section>
    </section>
  )
}

function ProjectsDashboard() {
  const selection = useProjectSessionSelection()

  if (selection.projects.isLoading) return <div className="panel muted">Loading Claude Code projects…</div>
  if (selection.projects.isError) return <div className="panel error">Failed to load projects: {selection.projects.error instanceof Error ? selection.projects.error.message : 'unknown error'}</div>
  if (selection.items.length === 0) return <div className="panel muted">No Claude Code projects were returned by the Agent SDK yet. Run Claude Code in a project first, then refresh this dashboard.</div>

  return (
    <div className="dashboard-layout">
      <ProjectSessionRail
        projects={selection.items}
        selectedProjectId={selection.selectedProjectId}
        selectedSessionId={selection.selectedSessionId}
        onSelectProject={selection.selectProject}
        onSelectSession={selection.selectSession}
      />
      {selection.projectSessions.isError ? <div className="panel error">Failed to load project sessions: {selection.projectSessions.error instanceof Error ? selection.projectSessions.error.message : 'unknown error'}</div> : <WorkspacePanel projectId={selection.selectedProjectId} detail={selection.projectSessions.data} selectedSessionId={selection.selectedSessionId} setSelectedSessionId={selection.setSelectedSessionId} />}
    </div>
  )
}

function DebugDashboard() {
  const selection = useProjectSessionSelection({ sessionLimit: 100 })
  const rawMessages = useSessionRawMessages(selection.selectedProjectId, selection.selectedSessionId)
  const sessions = selection.projectSessions.data?.sessions ?? []

  if (selection.projects.isLoading) return <div className="panel muted">Loading Claude Code projects…</div>
  if (selection.projects.isError) return <div className="panel error">Failed to load projects: {selection.projects.error instanceof Error ? selection.projects.error.message : 'unknown error'}</div>
  if (selection.items.length === 0) return <div className="panel muted">No Claude Code projects were returned by the Agent SDK yet. Run Claude Code in a project first, then refresh this dashboard.</div>

  return (
    <section className="detail-panel debug-page-panel debug-page-single" aria-label="Debug workspace">
      <div className="debug-filter-bar" aria-label="Debug filters">
        <label className="debug-filter-field">
          <span>Project</span>
          <select value={selection.selectedProjectId ?? ''} onChange={(event) => selection.selectProject(event.target.value)}>
            {selection.items.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <label className="debug-filter-field">
          <span>Session</span>
          <select
            value={selection.selectedSessionId ?? ''}
            onChange={(event) => {
              if (!selection.selectedProjectId || !event.target.value) return
              selection.selectSession(selection.selectedProjectId, event.target.value)
            }}
            disabled={selection.projectSessions.isLoading || sessions.length === 0}
          >
            {selection.projectSessions.isLoading ? <option value="">Loading sessions…</option> : null}
            {!selection.projectSessions.isLoading && sessions.length === 0 ? <option value="">No sessions</option> : null}
            {sessions.map((session) => <option key={session.id} value={session.id}>{session.id} — {session.title}</option>)}
          </select>
        </label>
      </div>
      <div className="debug-page-content">
        {selection.projectSessions.isError ? <div className="panel error">Failed to load project sessions: {selection.projectSessions.error instanceof Error ? selection.projectSessions.error.message : 'unknown error'}</div> : null}
        {selection.projectSessions.isLoading ? <div className="panel muted">Loading project sessions…</div> : null}
        {!selection.projectSessions.isLoading && !selection.selectedSessionId ? <div className="panel muted">Select a session to inspect raw messages.</div> : null}
        {selection.selectedSessionId && rawMessages.isLoading ? <div className="panel muted">Loading raw messages…</div> : null}
        {selection.selectedSessionId && rawMessages.isError ? <div className="panel error">Failed to load raw messages: {rawMessages.error instanceof Error ? rawMessages.error.message : 'unknown error'}</div> : null}
        {selection.selectedSessionId && rawMessages.data ? <SessionDebugView rawMessages={rawMessages.data.messages} /> : null}
      </div>
    </section>
  )
}

function AccessRequired() {
  return (
    <section className="panel access-required">
      <p className="eyebrow">Token required</p>
      <h2>Open this dashboard with a token.</h2>
      <p className="lede">Add <code>?token=&lt;token&gt;</code> to the URL to load projects and sessions.</p>
    </section>
  )
}

function App() {
  const token = authToken()
  const page = new URLSearchParams(window.location.search).get('page') === 'debug' ? 'debug' : 'home'

  return (
    <main className="shell">
      <nav className="hero top-nav" aria-label="Main navigation">
        <div className="top-nav-brand"><h1>Navigator</h1></div>
        <div className="top-nav-links">
          <a className={page === 'home' ? 'active' : ''} href={withToken('/')}>Home</a>
          <a className={page === 'debug' ? 'active' : ''} href={withToken('/?page=debug')}>Debug</a>
        </div>
      </nav>
      {token ? (page === 'debug' ? <DebugDashboard /> : <ProjectsDashboard />) : <AccessRequired />}
    </main>
  )
}

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode><QueryClientProvider client={queryClient}><App /></QueryClientProvider></StrictMode>,
)
