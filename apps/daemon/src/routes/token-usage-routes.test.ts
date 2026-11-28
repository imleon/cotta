import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../index.js'
import { createTestApp } from './project-routes-test-helpers.js'

const dailyResponse = {
  days: 7,
  timeZone: 'UTC',
  daily: Array.from({ length: 7 }, (_, index) => ({ date: `2026-09-0${index + 1}`, uncachedInputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, totalTokens: 0 })),
}

const response = {
  range: '30d' as const,
  timeZone: 'UTC',
  totals: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheHitRate: 0, sessions: 0, userMessages: 0 },
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('token usage routes', () => {
  it('defaults to 30d and passes a valid IANA timezone', async () => {
    const query = vi.fn(() => response)
    const app = createTestApp({}, undefined, { tokenUsageStore: { query } as never })
    const result = await app.request('/api/token-usage?timeZone=UTC')
    expect(result.status).toBe(200)
    expect(query).toHaveBeenCalledWith('30d', 'UTC')
  })

  it('waits for readiness before querying usage', async () => {
    const ready = deferred()
    const query = vi.fn(() => response)
    const tokenUsageReady = vi.fn(() => ready.promise)
    const app = createTestApp({}, undefined, { tokenUsageStore: { query } as never, tokenUsageReady })
    const request = app.request('/api/token-usage?timeZone=UTC')
    await vi.waitFor(() => expect(tokenUsageReady).toHaveBeenCalledOnce())
    expect(query).not.toHaveBeenCalled()
    ready.resolve()
    expect((await request).status).toBe(200)
    expect(query).toHaveBeenCalledOnce()
  })

  it('rejects invalid range and timezone', async () => {
    const app = createTestApp({}, undefined, { tokenUsageStore: { query: () => response } as never })
    expect((await app.request('/api/token-usage?range=week&timeZone=UTC')).status).toBe(400)
    expect((await app.request('/api/token-usage?timeZone=Not/AZone')).status).toBe(400)
  })

  it('passes bounded daily queries to the store', async () => {
    const queryDaily = vi.fn(() => dailyResponse)
    const app = createTestApp({}, undefined, { tokenUsageStore: { queryDaily } as never })
    const result = await app.request('/api/token-usage/daily?days=7&timeZone=UTC')
    expect(result.status).toBe(200)
    expect(queryDaily).toHaveBeenCalledWith(7, 'UTC')
    expect(await result.json()).toEqual(dailyResponse)
  })

  it('waits for readiness before querying daily usage', async () => {
    const ready = deferred()
    const queryDaily = vi.fn(() => dailyResponse)
    const tokenUsageReady = vi.fn(() => ready.promise)
    const app = createTestApp({}, undefined, { tokenUsageStore: { queryDaily } as never, tokenUsageReady })
    const request = app.request('/api/token-usage/daily?days=7&timeZone=UTC')
    await vi.waitFor(() => expect(tokenUsageReady).toHaveBeenCalledOnce())
    expect(queryDaily).not.toHaveBeenCalled()
    ready.resolve()
    expect((await request).status).toBe(200)
    expect(queryDaily).toHaveBeenCalledOnce()
  })

  it.each(['', '?timeZone=UTC', '?days=0&timeZone=UTC', '?days=-1&timeZone=UTC', '?days=1.5&timeZone=UTC', '?days=372&timeZone=UTC', '?days=7&timeZone=Not/AZone'])(
    'rejects invalid daily query %s',
    async (query) => {
      const app = createTestApp({}, undefined, { tokenUsageStore: { queryDaily: () => dailyResponse } as never })
      expect((await app.request(`/api/token-usage/daily${query}`)).status).toBe(400)
    },
  )

  it('awaits an explicit usage refresh', async () => {
    const refresh = deferred()
    const tokenUsageRefresh = vi.fn(() => refresh.promise)
    const app = createTestApp({}, undefined, { tokenUsageRefresh })
    const request = Promise.resolve(app.request('/api/token-usage/refresh', { method: 'POST' }))
    await vi.waitFor(() => expect(tokenUsageRefresh).toHaveBeenCalledOnce())
    let settled = false
    void request.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    refresh.resolve()
    expect(await (await request).json()).toEqual({ ok: true })
  })

  it('returns non-success when refresh fails', async () => {
    const app = createTestApp({}, undefined, { tokenUsageRefresh: async () => Promise.reject(new Error('refresh failed')) })
    expect((await app.request('/api/token-usage/refresh', { method: 'POST' })).status).toBe(500)
  })

  it('reports unavailable without a store or refresh callback', async () => {
    const app = createApp({
      transcriptIndex: {
        getSession: () => null,
        getProject: () => null,
        listProjectsPage: () => ({ items: [], hasMore: false, nextKey: null }),
        listProjectSessionsPage: () => ({ items: [], hasMore: false, nextKey: null, defaultSessionId: null }),
      },
      timelineVersionReader: () => 'timeline-missing',
    })
    expect((await app.request('/api/token-usage?timeZone=UTC')).status).toBe(503)
    expect((await app.request('/api/token-usage/daily?days=7&timeZone=UTC')).status).toBe(503)
    expect((await app.request('/api/token-usage/refresh', { method: 'POST' })).status).toBe(503)
  })
})
