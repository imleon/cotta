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

async function fetchProjects(): Promise<ProjectsResponse> {
  const response = await fetch('/api/projects')
  if (!response.ok) {
    throw new Error(`Projects request failed: ${response.status}`)
  }
  return projectsResponseSchema.parse(await response.json())
}

async function fetchProjectSessions(projectId: string): Promise<ProjectSessionsResponse> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/sessions`)
  if (!response.ok) {
    throw new Error(`Project sessions request failed: ${response.status}`)
  }
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
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/timeline?${params}`,
  )
  if (!response.ok) {
    throw new Error(`Session timeline request failed: ${response.status}`)
  }
  return sessionTimelineResponseSchema.parse(await response.json())
}

async function createTurn(projectId: string, sessionId: string | null, text: string): Promise<CreateTurnResponse> {
  const path = sessionId
    ? `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/turns`
    : `/api/projects/${encodeURIComponent(projectId)}/sessions`
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!response.ok) {
    throw new Error(`Create turn failed: ${response.status}`)
  }
  return createTurnResponseSchema.parse(await response.json())
}

async function interruptTurn(projectId: string, sessionId: string, turnId: string): Promise<void> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/interrupt`,
    { method: 'POST' },
  )
  if (!response.ok) throw new Error(`Interrupt failed: ${response.status}`)
}

function formatLastActivity(value?: number): string {
  if (!value) return 'No activity yet'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function dataPreview(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'text' in value && typeof value.text === 'string') {
    return value.text
  }
  return JSON.stringify(value, null, 2) ?? ''
}

function ProjectCard({
  project,
  selected,
  onSelect,
}: {
  project: ProjectSummary
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button className={`project-card ${selected ? 'selected' : ''}`} type="button" onClick={onSelect}>
      <div>
        <h2>{project.name}</h2>
        {project.path ? <p className="project-path">{project.path}</p> : null}
      </div>
      <dl className="project-meta">
        <div>
          <dt>Sessions</dt>
          <dd>{project.sessionCount ?? 0}</dd>
        </div>
        <div>
          <dt>Last activity</dt>
          <dd>{formatLastActivity(project.lastActivityAt)}</dd>
        </div>
      </dl>
    </button>
  )
}

function SessionRow({
  session,
  selected,
  onSelect,
}: {
  session: SessionSummary
  selected: boolean
  onSelect: () => void
}) {
  return (
    <li>
      <button className={`session-row ${selected ? 'selected' : ''}`} type="button" onClick={onSelect}>
        <div>
          <strong>{session.title}</strong>
          <span>{formatLastActivity(session.lastActivityAt)}</span>
        </div>
        <span className="session-status">{session.displayStatus ?? session.rawStatus ?? 'idle'}</span>
      </button>
    </li>
  )
}

function TimelineBlockView({ block }: { block: TimelineBlock }) {
  return (
    <div className={`timeline-block ${block.kind.replaceAll('.', '-')}`}>
      <div className="timeline-kind">{block.kind}</div>
      <pre>{dataPreview(block.data)}</pre>
    </div>
  )
}

function applyLiveEvent(turns: TurnSummary[], event: SessionStreamEvent): TurnSummary[] {
  if (event.type === 'live.turn.started') {
    return [...turns.filter((turn) => turn.id !== event.turnId), event.turn]
  }

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

function SessionTimeline({
  projectId,
  sessionId,
  onLiveTurnChange,
}: {
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

  const timeline = useQuery({
    queryKey: ['session-timeline', projectId, sessionId],
    queryFn: () => fetchSessionTimeline(projectId, sessionId),
    retry: false,
  })

  useEffect(() => {
    if (!timeline.data) return
    setTurns(timeline.data.turns)
    setNextCursor(timeline.data.nextCursor)
    setHasMore(timeline.data.hasMore)
    setOlderError(null)
    setDebugEvents([])
  }, [timeline.data])

  useEffect(() => {
    const events = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/events`)
    events.onmessage = (message) => {
      const event = JSON.parse(message.data) as SessionStreamEvent
      if (event.type === 'live.raw') {
        setDebugEvents((current) => [...current.slice(-49), event.raw])
      }
      if ('turnId' in event) {
        if (event.type === 'live.turn.started') onLiveTurnChange?.(event.turnId)
        if (event.type === 'live.turn.completed' || event.type === 'live.turn.failed' || event.type === 'live.turn.interrupted') {
          onLiveTurnChange?.(null)
        }
      }
      setTurns((current) => applyLiveEvent(current, event))
    }
    events.onerror = () => {
      events.close()
    }
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

  if (timeline.isLoading) {
    return <div className="panel muted">Loading session timeline…</div>
  }

  if (timeline.isError) {
    return (
      <div className="panel error">
        Failed to load timeline: {timeline.error instanceof Error ? timeline.error.message : 'unknown error'}
      </div>
    )
  }

  if (turns.length === 0) {
    return <div className="panel muted">This session has no projected turns yet.</div>
  }

  return (
    <section className="timeline-panel">
      {hasMore ? (
        <button className="load-older" type="button" onClick={loadOlder} disabled={loadingOlder}>
          {loadingOlder ? 'Loading older turns…' : 'Load older'}
        </button>
      ) : null}
      {olderError ? <div className="panel error">Failed to load older turns: {olderError}</div> : null}
      {turns.map((turn) => (
        <article className="turn-card" key={turn.id}>
          <header>
            <span className="session-status">{turn.displayStatus ?? turn.rawStatus ?? 'complete'}</span>
            <h3>{turn.title ?? 'Untitled turn'}</h3>
          </header>
          <div className="timeline-blocks">
            {turn.blocks.map((block) => (
              <TimelineBlockView block={block} key={block.id} />
            ))}
          </div>
        </article>
      ))}
      <details className="debug-panel">
        <summary>Debug Panel · raw live events ({debugEvents.length})</summary>
        <pre>{JSON.stringify(debugEvents, null, 2)}</pre>
      </details>
    </section>
  )
}

function ProjectDetail({ projectId }: { projectId: string | null }) {
  const [inputText, setInputText] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [liveTurnId, setLiveTurnId] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const detail = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: () => fetchProjectSessions(projectId!),
    enabled: Boolean(projectId),
    retry: false,
  })

  useEffect(() => {
    setActiveSessionId(null)
    setLiveTurnId(null)
    setSubmitError(null)
  }, [projectId])

  if (!projectId) {
    return <div className="panel muted">Select a project to view its sessions.</div>
  }

  if (detail.isLoading) {
    return <div className="panel muted">Loading project sessions…</div>
  }

  if (detail.isError) {
    return (
      <div className="panel error">
        Failed to load project sessions:{' '}
        {detail.error instanceof Error ? detail.error.message : 'unknown error'}
      </div>
    )
  }

  if (!detail.data) {
    return <div className="panel muted">No project session data was returned.</div>
  }

  const data = detail.data
  const selectedSessionId = activeSessionId ?? data.defaultSessionId

  async function submitTurn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!projectId || !inputText.trim()) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const response = await createTurn(projectId, selectedSessionId, inputText)
      setActiveSessionId(response.sessionId)
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
    <section className="detail-panel">
      <header className="detail-header">
        <div>
          <p className="eyebrow">Project</p>
          <h2>{data.project.name}</h2>
          {data.project.path ? <p className="project-path">{data.project.path}</p> : null}
        </div>
        <div className="detail-stat">
          <span>Default session</span>
          <strong>{selectedSessionId ?? 'none'}</strong>
        </div>
      </header>

      {data.sessions.length === 0 ? (
        <div className="panel muted">No sessions were returned for this project.</div>
      ) : (
        <ol className="session-list">
          {data.sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              selected={session.id === selectedSessionId}
              onSelect={() => {
                setActiveSessionId(session.id)
                setLiveTurnId(null)
                setSubmitError(null)
              }}
            />
          ))}
        </ol>
      )}

      <form className="turn-form" onSubmit={submitTurn}>
        <textarea
          value={inputText}
          onChange={(event) => setInputText(event.target.value)}
          placeholder={selectedSessionId ? 'Continue the default session…' : 'Start a new session in this project…'}
          rows={4}
        />
        <div className="turn-actions">
          <button type="submit" disabled={submitting || !inputText.trim()}>
            {submitting ? 'Sending…' : selectedSessionId ? 'Continue session' : 'Start new session'}
          </button>
          {liveTurnId && selectedSessionId ? (
            <button type="button" className="danger" onClick={stopLiveTurn}>
              Stop
            </button>
          ) : null}
        </div>
        {submitError ? <div className="panel error">{submitError}</div> : null}
      </form>

      {selectedSessionId ? (
        <SessionTimeline projectId={projectId} sessionId={selectedSessionId} onLiveTurnChange={setLiveTurnId} />
      ) : null}
    </section>
  )
}

function ProjectsDashboard() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
    retry: false,
  })

  const items = projects.data?.projects ?? []

  useEffect(() => {
    if (!selectedProjectId && items.length > 0) {
      setSelectedProjectId(items[0]!.id)
    }
  }, [items, selectedProjectId])

  if (projects.isLoading) {
    return <div className="panel muted">Loading Claude Code projects…</div>
  }

  if (projects.isError) {
    return (
      <div className="panel error">
        Failed to load projects: {projects.error instanceof Error ? projects.error.message : 'unknown error'}
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="panel muted">
        No Claude Code projects were returned by the Agent SDK yet. Run Claude Code in a project first,
        then refresh this dashboard.
      </div>
    )
  }

  return (
    <div className="dashboard-layout">
      <div className="project-grid">
        {items.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            selected={project.id === selectedProjectId}
            onSelect={() => setSelectedProjectId(project.id)}
          />
        ))}
      </div>
      <ProjectDetail projectId={selectedProjectId} />
    </div>
  )
}

function App() {
  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Cotta v2</p>
        <h1>Claude Code Project Dashboard</h1>
        <p className="lede">
          Projects are discovered from official Claude Agent SDK session APIs. Select a project to see
          recent sessions and the first projected timeline page.
        </p>
      </section>
      <ProjectsDashboard />
    </main>
  )
}

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
