import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createTokenAuthMiddleware } from './auth.js'
import { createClaudeCodeApi, type ClaudeCodeApi } from './claude-code-api.js'
import { LiveTurnManager } from './live-turn-manager.js'
import { registerHealthRoute } from './routes/health.js'
import { registerProjectRoutes, type ProjectRoutesLiveTurnManager } from './routes/projects.js'

export function createApp(input: {
  claudeCodeApi?: ClaudeCodeApi
  liveTurnManager?: ProjectRoutesLiveTurnManager
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
  const server = serve(
    {
      fetch: createApp().fetch,
      hostname: host,
      port,
    },
    () => {
      console.log(`Cotta server listening on http://${host}:${port}`)
    },
  )

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Cotta server failed to start: http://${host}:${port} is already in use.`)
      console.error('Stop the process using that port, or start Cotta with a different PORT.')
      process.exitCode = 1
      return
    }

    throw error
  })
}
