import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  projectSessionsResponseSchema,
  projectsResponseSchema,
  sessionTimelineResponseSchema,
  type ProjectSessionsResponse,
  type ProjectSummary,
  type ProjectsResponse,
  type SessionSummary,
  type SessionTimelineResponse,
  type TimelineBlock,
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

async function fetchSessionTimeline(projectId: string, sessionId: string): Promise<SessionTimelineResponse> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/timeline?limitTurns=20`,
  )
  if (!response.ok) {
    throw new Error(`Session timeline request failed: ${response.status}`)
  }
  return sessionTimelineResponseSchema.parse(await response.json())
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

function SessionRow({ session, selected }: { session: SessionSummary; selected: boolean }) {
  return (
    <li className={`session-row ${selected ? 'selected' : ''}`}>
      <div>
        <strong>{session.title}</strong>
        <span>{formatLastActivity(session.lastActivityAt)}</span>
      </div>
      <span className="session-status">{session.displayStatus ?? session.rawStatus ?? 'idle'}</span>
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

function SessionTimeline({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const timeline = useQuery({
    queryKey: ['session-timeline', projectId, sessionId],
    queryFn: () => fetchSessionTimeline(projectId, sessionId),
    retry: false,
  })

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

  const turns = timeline.data?.turns ?? []

  if (turns.length === 0) {
    return <div className="panel muted">This session has no projected turns yet.</div>
  }

  return (
    <section className="timeline-panel">
      {timeline.data?.hasMore ? (
        <button className="load-older" type="button" disabled>
          Load older available after cursor wiring
        </button>
      ) : null}
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
    </section>
  )
}

function ProjectDetail({ projectId }: { projectId: string | null }) {
  const detail = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: () => fetchProjectSessions(projectId!),
    enabled: Boolean(projectId),
    retry: false,
  })

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
  const selectedSessionId = data.defaultSessionId

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
            <SessionRow key={session.id} session={session} selected={session.id === selectedSessionId} />
          ))}
        </ol>
      )}

      {selectedSessionId ? <SessionTimeline projectId={projectId} sessionId={selectedSessionId} /> : null}
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
