import { describe, expect, it } from 'vitest'
import {
  projectResponseSchema,
  projectSessionsResponseSchema,
  projectsResponseSchema,
  type ProjectSummary,
  type SessionSummary,
} from '@cotta/shared'
import { createApp } from '../index.js'

const project: ProjectSummary = {
  id: 'project-one',
  name: 'cotta-v2',
  path: '/tmp/cotta-v2',
  lastActivityAt: 123,
  sessionCount: 2,
}

const sessions: SessionSummary[] = [
  {
    id: 'session-newest',
    projectId: project.id,
    title: 'Newest session',
    lastActivityAt: 123,
  },
  {
    id: 'session-older',
    projectId: project.id,
    title: 'Older session',
    lastActivityAt: 100,
  },
]

function createTestApp() {
  return createApp({
    claudeCodeApi: {
      async listProjects() {
        return [project]
      },
      async getProject(projectId) {
        return projectId === project.id ? project : null
      },
      async listProjectSessions(projectId) {
        if (projectId !== project.id) return null
        return {
          project,
          sessions,
          defaultSessionId: sessions[0]?.id ?? null,
        }
      },
    },
  })
}

describe('project routes', () => {
  it('lists projects from the Claude Code API adapter', async () => {
    const response = await createTestApp().request('/api/projects')

    expect(response.status).toBe(200)
    expect(projectsResponseSchema.parse(await response.json())).toEqual({ projects: [project] })
  })

  it('gets a project by id', async () => {
    const response = await createTestApp().request(`/api/projects/${project.id}`)

    expect(response.status).toBe(200)
    expect(projectResponseSchema.parse(await response.json())).toEqual({ project })
  })

  it('lists sessions for a project and returns the default session', async () => {
    const response = await createTestApp().request(`/api/projects/${project.id}/sessions`)

    expect(response.status).toBe(200)
    expect(projectSessionsResponseSchema.parse(await response.json())).toEqual({
      project,
      sessions,
      defaultSessionId: 'session-newest',
    })
  })

  it('returns 404 for unknown project sessions', async () => {
    const response = await createTestApp().request('/api/projects/missing/sessions')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'project_not_found' })
  })
})
