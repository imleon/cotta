import { QueryClient, QueryClientProvider, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { StrictMode, useEffect, useRef, useState, type FormEvent } from 'react'
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

async function fetchProjectSessions(
  projectId: string,
  cursor: string | null = null,
  limit = 10,
): Promise<ProjectSessionsResponse> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor) params.set('cursor', cursor)
  const response = await fetch(withToken(`/api/projects/${encodeURIComponent(projectId)}/sessions?${params}`))
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

function formatAge(value?: number): string {
  if (!value) return '—'
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - value) / 1000))
  if (elapsedSeconds < 60) return 'now'
  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`
  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours}h`
  const elapsedDays = Math.floor(elapsedHours / 24)
  if (elapsedDays < 30) return `${elapsedDays}d`
  const elapsedMonths = Math.floor(elapsedDays / 30)
  if (elapsedMonths < 12) return `${elapsedMonths}mo`
  return `${Math.floor(elapsedMonths / 12)}y`
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

function timelineDebugPayload(turns: TurnSummary[], rawLiveEvents: unknown[]) {
  return {
    loadedTurns: turns.length,
    loadedBlocks: turns.reduce((count, turn) => count + turn.blocks.length, 0),
    timeline: turns,
    rawLiveEvents,
  }
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
      </div>
    </button>
  )
}

function StatusBadge({ value }: { value?: string }) {
  const tone = statusTone(value)
  if (tone === 'neutral') return null
  return <span className={`status-badge status-${tone}`}>{statusLabel(value)}</span>
}

function previewSessionStatus(index: number): string | undefined {
  return ['running', 'complete', 'requires_action', 'failed'][index]
}

function SessionRow({ session, selected, onSelect, previewStatus }: { session: SessionSummary; selected: boolean; onSelect: () => void; previewStatus?: string }) {
  const actualState = statusValue(session.displayStatus, session.rawStatus)
  const state = statusTone(actualState) === 'neutral' ? previewStatus ?? actualState : actualState
  return (
    <li>
      <button className={`session-row ${selected ? 'selected' : ''}`} type="button" onClick={onSelect} aria-current={selected ? 'true' : undefined}>
        <div className="session-content">
          <div className="session-main">
            <strong>{session.title}</strong>
          </div>
          <StatusBadge value={state} />
        </div>
        <span className="session-age">{formatAge(session.lastActivityAt)}</span>
      </button>
    </li>
  )
}

function SessionDebugView({ debugPayload, rawLiveEventCount }: {
  debugPayload: ReturnType<typeof timelineDebugPayload>
  rawLiveEventCount: number
}) {
  return (
    <section className="debug-panel debug-view" aria-label="Session debug">
      <div className="debug-view-header">
        <h3>Debug</h3>
        <p>
          loaded timeline payloads ({debugPayload.loadedTurns} turns / {debugPayload.loadedBlocks} blocks)
          {rawLiveEventCount > 0 ? ` · raw live events (${rawLiveEventCount})` : ''}
        </p>
      </div>
      <pre>{JSON.stringify(debugPayload, null, 2)}</pre>
    </section>
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

function ProjectSessionBranch({
  project,
  selectedProjectId,
  selectedSessionId,
  onSelectProject,
  onSelectSession,
}: {
  project: ProjectSummary
  selectedProjectId: string | null
  selectedSessionId: string | null
  onSelectProject: (projectId: string) => void
  onSelectSession: (projectId: string, sessionId: string) => void
}) {
  const sessionsQuery = useInfiniteQuery({
    queryKey: ['project-sessions-rail', project.id],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchProjectSessions(project.id, pageParam, 10),
    getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.nextCursor : undefined,
    retry: false,
  })
  const sessions = sessionsQuery.data?.pages.flatMap((page) => page.sessions) ?? []
  const selected = project.id === selectedProjectId

  return (
    <div className="project-tree-item">
      <ProjectCard project={project} selected={selected} onSelect={() => onSelectProject(project.id)} />
      <div className="project-sessions">
        {sessionsQuery.isLoading ? <div className="rail-empty">Loading sessions…</div> : null}
        {sessionsQuery.isError ? <div className="rail-empty error-text">Failed to load sessions</div> : null}
        {!sessionsQuery.isLoading && sessions.length === 0 ? <div className="rail-empty">No sessions</div> : null}
        {sessions.length > 0 ? (
          <ol className="session-list rail-session-list">
            {sessions.map((session, index) => (
              <SessionRow
                key={session.id}
                session={session}
                selected={project.id === selectedProjectId && session.id === selectedSessionId}
                previewStatus={previewSessionStatus(index)}
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
    </div>
  )
}

function ProjectSessionRail({
  projects,
  selectedProjectId,
  selectedSessionId,
  onSelectProject,
  onSelectSession,
}: {
  projects: ProjectSummary[]
  selectedProjectId: string | null
  selectedSessionId: string | null
  onSelectProject: (projectId: string) => void
  onSelectSession: (projectId: string, sessionId: string) => void
}) {
  return (
    <aside className="project-rail" aria-label="Projects and sessions">
      <div className="project-tree">
        {projects.map((project) => (
          <ProjectSessionBranch
            key={project.id}
            project={project}
            selectedProjectId={selectedProjectId}
            selectedSessionId={selectedSessionId}
            onSelectProject={onSelectProject}
            onSelectSession={onSelectSession}
          />
        ))}
      </div>
    </aside>
  )
}

function SessionTimeline({ projectId, sessionId, debugEnabled, onLiveTurnChange }: {
  projectId: string
  sessionId: string
  debugEnabled: boolean
  onLiveTurnChange?: (turnId: string | null) => void
}) {
  const [turns, setTurns] = useState<TurnSummary[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [olderError, setOlderError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [debugEvents, setDebugEvents] = useState<unknown[]>([])
  const timelineEndRef = useRef<HTMLDivElement | null>(null)
  const shouldScrollToBottomRef = useRef(false)

  const timeline = useQuery({ queryKey: ['session-timeline', projectId, sessionId], queryFn: () => fetchSessionTimeline(projectId, sessionId), retry: false })

  useEffect(() => {
    if (!timeline.data) return
    shouldScrollToBottomRef.current = true
    setTurns(timeline.data.turns)
    setNextCursor(timeline.data.nextCursor)
    setHasMore(timeline.data.hasMore)
    setOlderError(null)
    setDebugEvents([])
  }, [timeline.data])

  useEffect(() => {
    if (!shouldScrollToBottomRef.current) return
    shouldScrollToBottomRef.current = false
    timelineEndRef.current?.scrollIntoView({ block: 'end' })
  }, [turns])

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

  const debugPayload = timelineDebugPayload(turns, debugEvents)

  return (
    <section className={`session-workspace-view ${debugEnabled ? 'debug-enabled' : ''}`} aria-label="Session workspace">
      <section className="timeline-panel" aria-label="Session timeline">
        {hasMore ? <div className="section-heading"><button className="load-older" type="button" onClick={loadOlder} disabled={loadingOlder}>{loadingOlder ? 'Loading…' : 'Load older'}</button></div> : null}
        {olderError ? <div className="panel error">Failed to load older turns: {olderError}</div> : null}
        {turns.length === 0 ? <div className="panel muted">This session has no projected turns yet.</div> : turns.map((turn) => {
          const state = statusValue(turn.displayStatus, turn.rawStatus, 'complete')
          return (
            <article className="turn-card" key={turn.id}>
              <header><StatusBadge value={state} /><h3>{turn.title ?? 'Untitled turn'}</h3></header>
              <div className="timeline-blocks">{turn.blocks.map((block) => <TimelineBlockView block={block} key={block.id} />)}</div>
            </article>
          )
        })}
        <div ref={timelineEndRef} />
      </section>
      {debugEnabled ? <SessionDebugView debugPayload={debugPayload} rawLiveEventCount={debugEvents.length} /> : null}
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
  const [debugEnabled, setDebugEnabled] = useState(false)

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
    <section className="workspace-panel">
      <section className="detail-panel workspace-main-panel">
        <header className="detail-header">
          <div className="project-title-block">
            <h2>{detail.project.name}</h2>
            <button type="button" className={`debug-toggle ${debugEnabled ? 'active' : ''}`} aria-pressed={debugEnabled} onClick={() => setDebugEnabled((value) => !value)}>Debug</button>
          </div>
          <div className="project-meta-lines">
            {detail.project.path ? <p className="project-directory">{detail.project.path}</p> : null}
            <p className="project-session-id">{selectedSessionId ?? 'new session'}</p>
          </div>
        </header>

        <div className="workspace-timeline">
          {selectedSessionId ? <SessionTimeline projectId={projectId} sessionId={selectedSessionId} debugEnabled={debugEnabled} onLiveTurnChange={setLiveTurnId} /> : <div className="panel muted">Start a new session from the composer below.</div>}
        </div>

        <section className="composer-card composer-card-bottom">
          <form className="turn-form" onSubmit={submitTurn}>
            <div className="turn-form-row">
              <textarea value={inputText} onChange={(event) => setInputText(event.target.value)} placeholder={selectedSessionId ? 'Continue the selected session…' : 'Start a new session in this project…'} rows={1} />
              <div className="turn-actions">
                <button type="submit" disabled={submitting || !inputText.trim()}>{submitting ? 'Sending…' : selectedSessionId ? 'Continue session' : 'Start new session'}</button>
                {liveTurnId && selectedSessionId ? <button type="button" className="danger" onClick={stopLiveTurn}>Stop</button> : null}
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
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects, retry: false })
  const projectSessions = useQuery({ queryKey: ['project-sessions-detail', selectedProjectId], queryFn: () => fetchProjectSessions(selectedProjectId!), enabled: Boolean(selectedProjectId), retry: false })
  const items = projects.data?.projects ?? []

  useEffect(() => { if (!selectedProjectId && items.length > 0) setSelectedProjectId(items[0]!.id) }, [items, selectedProjectId])
  useEffect(() => {
    if (!selectedSessionId) setSelectedSessionId(projectSessions.data?.defaultSessionId ?? null)
  }, [projectSessions.data, selectedSessionId])

  if (projects.isLoading) return <div className="panel muted">Loading Claude Code projects…</div>
  if (projects.isError) return <div className="panel error">Failed to load projects: {projects.error instanceof Error ? projects.error.message : 'unknown error'}</div>
  if (items.length === 0) return <div className="panel muted">No Claude Code projects were returned by the Agent SDK yet. Run Claude Code in a project first, then refresh this dashboard.</div>

  return (
    <div className="dashboard-layout">
      <ProjectSessionRail
        projects={items}
        selectedProjectId={selectedProjectId}
        selectedSessionId={selectedSessionId}
        onSelectProject={(projectId) => { setSelectedProjectId(projectId); setSelectedSessionId(null) }}
        onSelectSession={(projectId, sessionId) => { setSelectedProjectId(projectId); setSelectedSessionId(sessionId) }}
      />
      {projectSessions.isError ? <div className="panel error">Failed to load project sessions: {projectSessions.error instanceof Error ? projectSessions.error.message : 'unknown error'}</div> : <WorkspacePanel projectId={selectedProjectId} detail={projectSessions.data} selectedSessionId={selectedSessionId} setSelectedSessionId={setSelectedSessionId} />}
    </div>
  )
}

function App() {
  return (
    <main className="shell">
      <nav className="hero top-nav" aria-label="Main navigation"><div className="top-nav-brand"><h1>Navigator</h1></div><div className="top-nav-links"><a href="/">Home</a></div></nav>
      <ProjectsDashboard />
    </main>
  )
}

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode><QueryClientProvider client={queryClient}><App /></QueryClientProvider></StrictMode>,
)
