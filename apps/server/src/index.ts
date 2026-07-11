import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { registerHealthRoute } from './routes/health.js'

export function createApp(): Hono {
  const app = new Hono()
  registerHealthRoute(app)
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
