import type { Hono } from 'hono'
import type { ProjectResponse, ProjectsResponse, ProjectSessionsResponse } from '@cotta/shared'
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

  app.get('/api/projects/:projectId', async (c) => {
    try {
      const project = await input.claudeCodeApi.getProject(c.req.param('projectId'))
      if (!project) {
        return c.json({ error: 'project_not_found' }, 404)
      }
      const response: ProjectResponse = { project }
      return c.json(response)
    } catch (error) {
      console.error('projects:get failed', error)
      return c.json({ error: 'project_get_failed' }, 500)
    }
  })

  app.get('/api/projects/:projectId/sessions', async (c) => {
    try {
      const result = await input.claudeCodeApi.listProjectSessions(c.req.param('projectId'))
      if (!result) {
        return c.json({ error: 'project_not_found' }, 404)
      }
      const response: ProjectSessionsResponse = result
      return c.json(response)
    } catch (error) {
      console.error('projects:sessions failed', error)
      return c.json({ error: 'project_sessions_failed' }, 500)
    }
  })
}
