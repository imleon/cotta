import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createClaudeCodeApi, type ClaudeCodeApi } from './claude-code-api.js'
import { LiveTurnManager } from './live-turn-manager.js'
import { registerHealthRoute } from './routes/health.js'
import { registerProjectRoutes } from './routes/projects.js'

export function createApp(input: { claudeCodeApi?: ClaudeCodeApi; liveTurnManager?: LiveTurnManager } = {}): Hono {
  const app = new Hono()
  const claudeCodeApi = input.claudeCodeApi ?? createClaudeCodeApi()
  const liveTurnManager = input.liveTurnManager ?? new LiveTurnManager()
  registerHealthRoute(app)
  registerProjectRoutes(app, { claudeCodeApi, liveTurnManager })
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
