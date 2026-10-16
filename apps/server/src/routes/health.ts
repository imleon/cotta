import type { HealthResponse } from '@cotta/shared'
import type { Hono } from 'hono'

export function registerHealthRoute(app: Hono): void {
  app.get('/api/health', (c) => {
    const response: HealthResponse = {
      ok: true,
      service: 'cotta-server',
    }
    return c.json(response)
  })
}
