import type { Hono } from 'hono'
import type { ProjectsResponse } from '@cotta/shared'
import type { ClaudeCodeApi } from '../claude-code-api.js'

export function registerProjectRoutes(app: Hono, input: { claudeCodeApi: ClaudeCodeApi }): void {
  app.get('/api/projects', async (c) => {
    try {
      const response: ProjectsResponse = {
        projects: await input.claudeCodeApi.listProjects(),
      }
      return c.json(response)
    } catch (error) {
      console.error('projects:list failed', error)
      return c.json({ error: 'projects_list_failed' }, 500)
    }
  })
}
