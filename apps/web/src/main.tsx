import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { StrictMode, useEffect, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createTurnResponseSchema,
  projectSessionsResponseSchema,
  projectsResponseSchema,
  sessionTimelineResponseSchema,
  type CreateTurnResponse,
  type ProjectSessionsResponse,
  type ProjectSummary,
  type ProjectsResponse,
  type SessionStreamEvent,
  type SessionSummary,
  type SessionTimelineResponse,
  type TimelineBlock,
  type TurnSummary,
} from '@cotta/shared'
import './styles.css'

function authToken(): string | null {
  return new URLSearchParams(window.location.search).get('token')
}

function withToken(path: string): string {
  const token = authToken()
  if (!token) return path
  const url = new URL(path, window.location.origin)
  url.searchParams.set('token', token)
  return `${url.pathname}${url.search}`
}

async function fetchProjects(): Promise<ProjectsResponse> {
  const response = await fetch(withToken('/api/projects'))
  if (!response.ok) throw new Error(`Projects request failed: ${response.status}`)
  return projectsResponseSchema.parse(await response.json())
}

async function fetchProjectSessions(projectId: string): Promise<ProjectSessionsResponse> {
  const response = await fetch(withToken(`/api/projects/${encodeURIComponent(projectId)}/sessions`))
  if (!response.ok) throw new Error(`Project sessions request failed: ${response.status}`)
  return projectSessionsResponseSchema.parse(await response.json())
}

async function fetchSessionTimeline(
  projectId: string,
  sessionId: string,
  cursor: string | null = null,
): Promise<SessionTimelineResponse> {
  const params = new URLSearchParams({ limitTurns: '20' })
  if (cursor) params.set('cursor', cursor)
  const response = await fetch(
    withToken(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/timeline?${params}`),
  )
  if (!response.ok) throw new Error(`Session timeline request failed: ${response.status}`)
  return sessionTimelineResponseSchema.parse(await response.json())
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

function formatLastActivity(value?: number): string {
  if (!value) return 'No activity yet'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function dataPreview(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'text' in value && typeof value.text === 'string') return value.text
  return JSON.stringify(value, null, 2) ?? ''
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
  if (value === 'complete') return 'Complete'
  return value.replaceAll('_', ' ')
}

function blockTitle(kind: string): string {
  if (kind === 'user.message') return 'User'
  if (kind === 'assistant.text') return 'Assistant'
  if (kind === 'assistant.tool_use') return 'Tool use'
  if (kind === 'tool.result') return 'Tool result'
  if (kind === 'error') return 'Error'
  if (kind.startsWith('stream.')) return 'Stream event'
  if (kind.startsWith('system.')) return 'System event'
  if (kind.startsWith('raw.')) return 'Raw event'
  return kind
}

function blockTone(kind: string): string {
  if (kind === 'user.message') return 'user'
  if (kind === 'assistant.text' || kind === 'assistant.message') return 'assistant'
  if (kind === 'assistant.tool_use' || kind === 'tool.result') return 'tool'
  if (kind === 'error') return 'danger'
  return 'muted'
}

function shouldCollapseBlock(kind: string): boolean {
  return kind.startsWith('stream.')
    || kind.startsWith('raw.')
    || kind.startsWith('system.')
    || kind === 'assistant.tool_use'
    || kind === 'tool.result'
}

function ProjectCard({ project, selected, onSelect }: { project: ProjectSummary; selected: boolean; onSelect: () => void }) {
  return (
    <button className={`project-card ${selected ? 'selected' : ''}`} type="button" onClick={onSelect} aria-current={selected ? 'true' : undefined}>
      <div className="project-card-main">
        <h2>{project.name}</h2>
        {project.path ? <p className="project-path">{project.path}</p> : null}
      </div>
      <div className="project-card-meta">
        <span>{project.sessionCount ?? 0} sessions</span>
        <span>{formatLastActivity(project.lastActivityAt)}</span>
      </div>
    </button>
  )
}

function StatusBadge({ value }: { value?: string }) {
  return <span className={`status-badge status-${statusTone(value)}`}>{statusLabel(value)}</span>
}

function SessionRow({ session, selected, onSelect }: { session: SessionSummary; selected: boolean; onSelect: () => void }) {
  const state = statusValue(session.displayStatus, session.rawStatus)
  return (
    <li>
      <button className={`session-row ${selected ? 'selected' : ''}`} type="button" onClick={onSelect} aria-current={selected ? 'true' : undefined}>
        <div className="session-main">
          <strong>{session.title}</strong>
          <span>{formatLastActivity(session.lastActivityAt)}</span>
        </div>
        <StatusBadge value={state} />
      </button>
    </li>
  )
}

function TimelineBlockView({ block }: { block: TimelineBlock }) {
  const text = textFromData(block.data)
  const collapsible = shouldCollapseBlock(block.kind)
  return (
    <div className={`timeline-block timeline-block-${blockTone(block.kind)} ${block.kind.replaceAll('.', '-')}`}>
      <div className="timeline-block-header">
        <span className="timeline-kind">{blockTitle(block.kind)}</span>
        <span className="timeline-kind-raw">{block.kind}</span>
      </div>
      {text && !collapsible ? (
        <div className="timeline-text">{text}</div>
      ) : collapsible ? (
        <details className="timeline-raw">
          <summary>{text ? text.slice(0, 120) : 'View raw payload'}</summary>
          <pre>{dataPreview(block.data)}</pre>
        </details>
      ) : (
        <pre className="timeline-json">{dataPreview(block.data)}</pre>
      )}
    </div>
  )
}

function applyLiveEvent(turns: TurnSummary[], event: SessionStreamEvent): TurnSummary[] {
  if (event.type === 'live.turn.started') return [...turns.filter((turn) => turn.id !== event.turnId), event.turn]
  if (event.type === 'live.timeline.block') {
    return turns.map((turn) => turn.id === event.turnId
      ? { ...turn, blocks: [...turn.blocks.filter((block) => block.id !== event.block.id), event.block] }
      : turn)
  }
  if (event.type === 'live.turn.completed' || event.type === 'live.turn.interrupted') {
    return turns.map((turn) => turn.id === event.turnId
      ? { ...turn, rawStatus: event.type === 'live.turn.interrupted' ? 'interrupted' : 'completed', displayStatus: event.type === 'live.turn.interrupted' ? 'interrupted' : 'complete' }
      : turn)
  }
  if (event.type === 'live.turn.failed') {
    return turns.map((turn) => turn.id === event.turnId
      ? { ...turn, rawStatus: 'failed', displayStatus: 'failed', blocks: [...turn.blocks, { id: `${event.turnId}:error`, kind: 'error', sourceEventIds: [event.turnId], data: { error: event.error } }] }
      : turn)
  }
  return turns
}

function ProjectSessionRail({
  projects,
  sessions,
  selectedProjectId,
  selectedSessionId,
  onSelectProject,
  onSelectSession,
}: {
  projects: ProjectSummary[]
  sessions: SessionSummary[]
  selectedProjectId: string | null
  selectedSessionId: string | null
  onSelectProject: (projectId: string) => void
  onSelectSession: (sessionId: string) => void
}) {
  return (
    <aside className="project-rail" aria-label="Projects and sessions">
      <div className="section-heading"><div><p className="eyebrow">Projects</p><h3>{projects.length} workspaces</h3></div></div>
      <div className="project-tree">
        {projects.map((project) => {
          const selected = project.id === selectedProjectId
          return (
            <div className="project-tree-item" key={project.id}>
              <ProjectCard project={project} selected={selected} onSelect={() => onSelectProject(project.id)} />
              {selected ? (
                <div className="project-sessions">
                  <div className="project-sessions-heading">Sessions · {sessions.length}</div>
                  {sessions.length === 0 ? <div className="rail-empty">No sessions</div> : (
                    <ol className="session-list rail-session-list">
                      {sessions.map((session) => (
                        <SessionRow key={session.id} session={session} selected={session.id === selectedSessionId} onSelect={() => onSelectSession(session.id)} />
                      ))}
                    </ol>
                  )}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </aside>
  )
}

function SessionTimeline({ projectId, sessionId, onLiveTurnChange }: {
  projectId: string
  sessionId: string
  onLiveTurnChange?: (turnId: string | null) => void
}) {
  const [turns, setTurns] = useState<TurnSummary[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [olderError, setOlderError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [debugEvents, setDebugEvents] = useState<unknown[]>([])

  const timeline = useQuery({ queryKey: ['session-timeline', projectId, sessionId], queryFn: () => fetchSessionTimeline(projectId, sessionId), retry: false })

  useEffect(() => {
    if (!timeline.data) return
    setTurns(timeline.data.turns)
    setNextCursor(timeline.data.nextCursor)
    setHasMore(timeline.data.hasMore)
    setOlderError(null)
    setDebugEvents([])
  }, [timeline.data])

  useEffect(() => {
    const events = new EventSource(withToken(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/events`))
    events.onmessage = (message) => {
      const event = JSON.parse(message.data) as SessionStreamEvent
      if (event.type === 'live.raw') setDebugEvents((current) => [...current.slice(-49), event.raw])
      if ('turnId' in event) {
        if (event.type === 'live.turn.started') onLiveTurnChange?.(event.turnId)
        if (event.type === 'live.turn.completed' || event.type === 'live.turn.failed' || event.type === 'live.turn.interrupted') onLiveTurnChange?.(null)
      }
      setTurns((current) => applyLiveEvent(current, event))
    }
    events.onerror = () => events.close()
    return () => events.close()
  }, [onLiveTurnChange, projectId, sessionId])

  async function loadOlder() {
    if (!nextCursor || loadingOlder) return
    setLoadingOlder(true)
    setOlderError(null)
    try {
      const page = await fetchSessionTimeline(projectId, sessionId, nextCursor)
      setTurns((current) => [...page.turns, ...current])
      setNextCursor(page.nextCursor)
      setHasMore(page.hasMore)
    } catch (error) {
      setOlderError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingOlder(false)
    }
  }

  if (timeline.isLoading) return <div className="panel muted">Loading session timeline…</div>
  if (timeline.isError) return <div className="panel error">Failed to load timeline: {timeline.error instanceof Error ? timeline.error.message : 'unknown error'}</div>
  if (turns.length === 0) return <div className="panel muted">This session has no projected turns yet.</div>

  return (
    <section className="timeline-panel" aria-label="Session timeline">
      <div className="section-heading">
        <div><p className="eyebrow">Timeline</p><h3>{turns.length} loaded turns</h3></div>
        {hasMore ? <button className="load-older" type="button" onClick={loadOlder} disabled={loadingOlder}>{loadingOlder ? 'Loading…' : 'Load older'}</button> : null}
      </div>
      {olderError ? <div className="panel error">Failed to load older turns: {olderError}</div> : null}
      {turns.map((turn) => {
        const state = statusValue(turn.displayStatus, turn.rawStatus, 'complete')
        return (
          <article className="turn-card" key={turn.id}>
            <header><StatusBadge value={state} /><h3>{turn.title ?? 'Untitled turn'}</h3></header>
            <div className="timeline-blocks">{turn.blocks.map((block) => <TimelineBlockView block={block} key={block.id} />)}</div>
          </article>
        )
      })}
      <details className="debug-panel"><summary>Debug · raw live events ({debugEvents.length})</summary><pre>{JSON.stringify(debugEvents, null, 2)}</pre></details>
    </section>
  )
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
  const [inputText, setInputText] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [liveTurnId, setLiveTurnId] = useState<string | null>(null)

  useEffect(() => { setLiveTurnId(null); setSubmitError(null) }, [projectId, selectedSessionId])

  if (!projectId) return <div className="panel muted">Select a project to view its timeline.</div>
  if (!detail) return <div className="panel muted">Loading project sessions…</div>

  async function submitTurn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!projectId || !inputText.trim()) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const response = await createTurn(projectId, selectedSessionId, inputText)
      setSelectedSessionId(response.sessionId)
      setLiveTurnId(response.turnId)
      setInputText('')
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  async function stopLiveTurn() {
    if (!projectId || !selectedSessionId || !liveTurnId) return
    try {
      await interruptTurn(projectId, selectedSessionId, liveTurnId)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <section className="detail-panel workspace-panel">
      <header className="detail-header">
        <div><p className="eyebrow">Project</p><h2>{detail.project.name}</h2>{detail.project.path ? <p className="project-path">{detail.project.path}</p> : null}</div>
        <div className="detail-stat"><span>Active session</span><strong>{selectedSessionId ?? 'new session'}</strong></div>
      </header>

      <div className="workspace-timeline">
        {selectedSessionId ? <SessionTimeline projectId={projectId} sessionId={selectedSessionId} onLiveTurnChange={setLiveTurnId} /> : <div className="panel muted">Start a new session from the composer below.</div>}
      </div>

      <section className="composer-card composer-card-bottom">
        <div className="section-heading"><div><p className="eyebrow">Compose</p><h3>{selectedSessionId ? 'Continue selected session' : 'Start new session'}</h3></div></div>
        <form className="turn-form" onSubmit={submitTurn}>
          <textarea value={inputText} onChange={(event) => setInputText(event.target.value)} placeholder={selectedSessionId ? 'Continue the selected session…' : 'Start a new session in this project…'} rows={4} />
          <div className="turn-actions">
            <button type="submit" disabled={submitting || !inputText.trim()}>{submitting ? 'Sending…' : selectedSessionId ? 'Continue session' : 'Start new session'}</button>
            {liveTurnId && selectedSessionId ? <button type="button" className="danger" onClick={stopLiveTurn}>Stop</button> : null}
          </div>
          {submitError ? <div className="panel error">{submitError}</div> : null}
        </form>
      </section>
    </section>
  )
}

function ProjectsDashboard() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects, retry: false })
  const projectSessions = useQuery({ queryKey: ['project-sessions', selectedProjectId], queryFn: () => fetchProjectSessions(selectedProjectId!), enabled: Boolean(selectedProjectId), retry: false })
  const items = projects.data?.projects ?? []

  useEffect(() => { if (!selectedProjectId && items.length > 0) setSelectedProjectId(items[0]!.id) }, [items, selectedProjectId])
  useEffect(() => { setSelectedSessionId(projectSessions.data?.defaultSessionId ?? null) }, [projectSessions.data])

  if (projects.isLoading) return <div className="panel muted">Loading Claude Code projects…</div>
  if (projects.isError) return <div className="panel error">Failed to load projects: {projects.error instanceof Error ? projects.error.message : 'unknown error'}</div>
  if (items.length === 0) return <div className="panel muted">No Claude Code projects were returned by the Agent SDK yet. Run Claude Code in a project first, then refresh this dashboard.</div>

  return (
    <div className="dashboard-layout">
      <ProjectSessionRail
        projects={items}
        sessions={projectSessions.data?.sessions ?? []}
        selectedProjectId={selectedProjectId}
        selectedSessionId={selectedSessionId}
        onSelectProject={(projectId) => { setSelectedProjectId(projectId); setSelectedSessionId(null) }}
        onSelectSession={setSelectedSessionId}
      />
      {projectSessions.isError ? <div className="panel error">Failed to load project sessions: {projectSessions.error instanceof Error ? projectSessions.error.message : 'unknown error'}</div> : <WorkspacePanel projectId={selectedProjectId} detail={projectSessions.data} selectedSessionId={selectedSessionId} setSelectedSessionId={setSelectedSessionId} />}
    </div>
  )
}

function App() {
  return (
    <main className="shell">
      <section className="hero"><p className="eyebrow">Cotta v2</p><h1>Claude Code Project Dashboard</h1><p className="lede">Reconnect to Claude Code projects, inspect session timelines, and continue work from the browser.</p></section>
      <ProjectsDashboard />
    </main>
  )
}

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode><QueryClientProvider client={queryClient}><App /></QueryClientProvider></StrictMode>,
)
