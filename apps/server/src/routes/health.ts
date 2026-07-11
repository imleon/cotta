import type { Hono } from 'hono'
import type { HealthResponse } from '@cotta/shared'

export function registerHealthRoute(app: Hono): void {
  app.get('/', (c) => c.html(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Cotta v2</title></head>
  <body style="font-family: system-ui, sans-serif; padding: 32px; line-height: 1.5;">
    <h1>Cotta v2 server is running</h1>
    <p>API health: <a href="/api/health">/api/health</a></p>
    <p>In development, open the Vite web app at <code>http://&lt;host&gt;:5173/?token=&lt;token&gt;</code>.</p>
  </body>
</html>`))

  app.get('/api/health', (c) => {
    const response: HealthResponse = {
      ok: true,
      service: 'cotta-server',
    }
    return c.json(response)
  })
}
