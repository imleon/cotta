import { describe, expect, it } from 'vitest'
import { projectsResponseSchema, type ProjectSummary } from '@cotta/shared'
import { createApp } from '../index.js'

const projects: ProjectSummary[] = [
  {
    id: 'project-one',
    name: 'cotta-v2',
    path: '/tmp/cotta-v2',
    lastActivityAt: 123,
    sessionCount: 2,
  },
]

describe('project routes', () => {
  it('lists projects from the Claude Code API adapter', async () => {
    const app = createApp({
      claudeCodeApi: {
        async listProjects() {
          return projects
        },
      },
    })

    const response = await app.request('/api/projects')

    expect(response.status).toBe(200)
    expect(projectsResponseSchema.parse(await response.json())).toEqual({ projects })
  })
})
