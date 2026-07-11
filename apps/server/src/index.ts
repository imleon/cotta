import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createClaudeCodeApi, type ClaudeCodeApi } from './claude-code-api.js'
import { registerHealthRoute } from './routes/health.js'
import { registerProjectRoutes } from './routes/projects.js'

export function createApp(input: { claudeCodeApi?: ClaudeCodeApi } = {}): Hono {
  const app = new Hono()
  const claudeCodeApi = input.claudeCodeApi ?? createClaudeCodeApi()
  registerHealthRoute(app)
  registerProjectRoutes(app, { claudeCodeApi })
  return app
}

const port = Number(process.env.PORT ?? 3000)

if (process.env.NODE_ENV !== 'test') {
  serve({
    fetch: createApp().fetch,
    port,
  })
  console.log(`Cotta server listening on http://localhost:${port}`)
}
