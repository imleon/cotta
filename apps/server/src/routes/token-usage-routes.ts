import { tokenUsageDailyResponseSchema, tokenUsageRangeSchema, tokenUsageResponseSchema } from '@cotta/shared'
import type { Hono } from 'hono'
import type { TokenUsageStore } from '../token-usage-store.js'

export function registerTokenUsageRoutes(app: Hono, tokenUsageStore?: TokenUsageStore, ensureReady?: () => Promise<void>, refreshUsage?: () => Promise<void>): void {
  app.post('/api/token-usage/refresh', async (c) => {
    if (!refreshUsage) return c.json({ error: 'token_usage_unavailable' }, 503)
    await refreshUsage()
    return c.json({ ok: true })
  })

  app.get('/api/token-usage/daily', async (c) => {
    if (!tokenUsageStore) return c.json({ error: 'token_usage_unavailable' }, 503)
    const days = Number(c.req.query('days'))
    const timeZone = c.req.query('timeZone')
    if (!Number.isInteger(days) || days < 1 || days > 371 || !timeZone) return c.json({ error: 'invalid_token_usage_query' }, 400)
    try {
      new Intl.DateTimeFormat('en', { timeZone }).format()
    } catch {
      return c.json({ error: 'invalid_token_usage_query' }, 400)
    }
    await ensureReady?.()
    return c.json(tokenUsageDailyResponseSchema.parse(tokenUsageStore.queryDaily(days, timeZone)))
  })

  app.get('/api/token-usage', async (c) => {
    if (!tokenUsageStore) return c.json({ error: 'token_usage_unavailable' }, 503)
    const range = tokenUsageRangeSchema.safeParse(c.req.query('range') ?? '30d')
    const timeZone = c.req.query('timeZone')
    if (!range.success || !timeZone) return c.json({ error: 'invalid_token_usage_query' }, 400)
    try {
      new Intl.DateTimeFormat('en', { timeZone }).format()
    } catch {
      return c.json({ error: 'invalid_token_usage_query' }, 400)
    }
    await ensureReady?.()
    return c.json(tokenUsageResponseSchema.parse(tokenUsageStore.query(range.data, timeZone)))
  })
}
