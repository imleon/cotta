import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { projectsResponseSchema, type ProjectSummary, type ProjectsResponse } from '@cotta/shared'
import './styles.css'

async function fetchProjects(): Promise<ProjectsResponse> {
  const response = await fetch('/api/projects')
  if (!response.ok) {
    throw new Error(`Projects request failed: ${response.status}`)
  }
  return projectsResponseSchema.parse(await response.json())
}

function formatLastActivity(value?: number): string {
  if (!value) return 'No activity yet'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function ProjectCard({ project }: { project: ProjectSummary }) {
  return (
    <article className="project-card">
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
    </article>
  )
}

function ProjectsDashboard() {
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
    retry: false,
  })

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

  const items = projects.data?.projects ?? []
  if (items.length === 0) {
    return (
      <div className="panel muted">
        No Claude Code projects were returned by the Agent SDK yet. Run Claude Code in a project first,
        then refresh this dashboard.
      </div>
    )
  }

  return (
    <div className="project-grid">
      {items.map((project) => (
        <ProjectCard key={project.id} project={project} />
      ))}
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
          Projects are discovered from official Claude Agent SDK session APIs. The first MVP slice is
          read-only project discovery; session timelines come next.
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
