import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createTokenAuthMiddleware } from './auth.js'
import { createClaudeCodeApi, type ClaudeCodeApi } from './claude-code-api.js'
import { LiveTurnManager } from './live-turn-manager.js'
import { registerHealthRoute } from './routes/health.js'
import { registerProjectRoutes } from './routes/projects.js'

export function createApp(input: {
  claudeCodeApi?: ClaudeCodeApi
  liveTurnManager?: LiveTurnManager
  authToken?: string
} = {}): Hono {
  const app = new Hono()
  const claudeCodeApi = input.claudeCodeApi ?? createClaudeCodeApi()
  const liveTurnManager = input.liveTurnManager ?? new LiveTurnManager()
  app.use('*', createTokenAuthMiddleware(input.authToken ?? process.env.COTTA_AUTH_TOKEN))
  registerHealthRoute(app)
  registerProjectRoutes(app, { claudeCodeApi, liveTurnManager })
  return app
}

const host = process.env.HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? 3000)

if (process.env.NODE_ENV !== 'test') {
  serve({
    fetch: createApp().fetch,
    hostname: host,
    port,
  })
  console.log(`Cotta server listening on http://${host}:${port}`)
}
